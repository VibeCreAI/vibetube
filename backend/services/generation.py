"""Shared generation workflows used by generation, stories, and VibeTube routes."""

from __future__ import annotations

import asyncio
import shutil
import uuid
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, UploadFile
from sqlalchemy.orm import Session

from .. import config, models, tts
from . import history, profiles
from ..backends import engine_needs_trim, load_engine_model
from ..services.errors import extract_error_message
from ..services.model_management import get_generation_model_config, model_download_message
from ..services.uploads import write_upload_to_temp
from ..utils.audio import trim_tts_output
from ..utils.chunked_tts import generate_chunked
from ..utils.progress import get_progress_manager
from ..utils.tasks import get_task_manager

_ALLOWED_AUDIO_UPLOAD_EXTS = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".webm", ".opus"}


def _resolve_generation_engine_and_model_size(
    data: models.GenerationRequest,
) -> tuple[str, str]:
    engine = data.engine or "qwen"
    model_size = data.model_size or ("1.7B" if engine == "qwen" else "default")
    return engine, model_size


async def _generate_speech_audio(
    data: models.GenerationRequest,
    db: Session,
    *,
    queue_download_if_missing: bool,
) -> tuple[object, int, str, str]:
    profile = await profiles.get_profile(data.profile_id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    engine, model_size = _resolve_generation_engine_and_model_size(data)
    model_config = get_generation_model_config(engine, model_size)
    tts_model = tts.get_tts_model(engine)

    if not tts_model._is_model_cached(model_size):
        if queue_download_if_missing:
            task_manager = get_task_manager()
            progress_manager = get_progress_manager()

            async def download_model_background():
                try:
                    await load_engine_model(engine, model_size)
                except Exception as exc:
                    message = extract_error_message(exc)
                    progress_manager.mark_error(model_config.model_name, message)
                    task_manager.error_download(model_config.model_name, message)

            task_manager.start_download(model_config.model_name)
            asyncio.create_task(download_model_background())

            raise HTTPException(
                status_code=202,
                detail={
                    "message": model_download_message(model_config),
                    "model_name": model_config.model_name,
                    "downloading": True,
                },
            )

        raise HTTPException(
            status_code=400,
            detail=(
                f"{model_config.display_name} is not downloaded yet. "
                "Use /generate or /models/download first."
            ),
        )

    await load_engine_model(engine, model_size)

    voice_prompt = await profiles.create_voice_prompt_for_profile(
        data.profile_id,
        db,
        engine=engine,
    )

    trim_fn = trim_tts_output if engine_needs_trim(engine) else None
    if engine == "qwen":
        audio, sample_rate = await tts_model.generate(
            data.text,
            voice_prompt,
            data.language,
            data.seed,
            data.instruct,
        )
    else:
        audio, sample_rate = await generate_chunked(
            tts_model,
            data.text,
            voice_prompt,
            language=data.language,
            seed=data.seed,
            instruct=data.instruct if engine == "qwen" else None,
            max_chunk_chars=800,
            crossfade_ms=50,
            trim_fn=trim_fn,
        )

    return audio, sample_rate, engine, model_size


async def generate_and_persist_speech(
    data: models.GenerationRequest,
    db: Session,
) -> models.GenerationResponse:
    """Shared speech generation path used by single and batch generation endpoints."""
    task_manager = get_task_manager()
    generation_task_id = str(uuid.uuid4())

    try:
        task_manager.start_generation(
            task_id=generation_task_id,
            profile_id=data.profile_id,
            text=data.text,
        )
        audio, sample_rate, engine, model_size = await _generate_speech_audio(
            data,
            db,
            queue_download_if_missing=True,
        )

        duration = len(audio) / sample_rate
        audio_path = config.get_generations_dir() / f"{uuid.uuid4()}.wav"

        from ..utils.audio import save_audio

        save_audio(audio, str(audio_path), sample_rate)

        generation = await history.create_generation(
            profile_id=data.profile_id,
            text=data.text,
            language=data.language,
            engine=engine,
            model_size=model_size,
            source_type="ai",
            audio_path=str(audio_path),
            duration=duration,
            seed=data.seed,
            db=db,
            instruct=data.instruct if engine == "qwen" else None,
        )

        task_manager.complete_generation(generation_task_id)
        return generation
    except HTTPException:
        task_manager.complete_generation(generation_task_id)
        raise
    except ValueError as exc:
        task_manager.complete_generation(generation_task_id)
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        task_manager.complete_generation(generation_task_id)
        raise HTTPException(status_code=500, detail=extract_error_message(exc))


async def generate_stream_wav_bytes(
    data: models.GenerationRequest,
    db: Session,
) -> bytes:
    """Generate speech and return WAV bytes for streaming responses."""
    try:
        audio, sample_rate, _engine, _model_size = await _generate_speech_audio(
            data,
            db,
            queue_download_if_missing=False,
        )
        return tts.audio_to_wav_bytes(audio, sample_rate)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=extract_error_message(exc))


async def create_generation_from_uploaded_audio(
    profile_id: str,
    file: UploadFile,
    db: Session,
    text: Optional[str] = None,
    language: Optional[str] = None,
    instruct: Optional[str] = None,
) -> models.GenerationResponse:
    """Persist uploaded audio as a normal generation history row."""
    profile = await profiles.get_profile(profile_id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    uploaded_ext = Path(file.filename or "").suffix.lower()
    file_suffix = uploaded_ext if uploaded_ext in _ALLOWED_AUDIO_UPLOAD_EXTS else ".wav"
    tmp_path = await write_upload_to_temp(file, suffix=file_suffix)

    destination_path: Optional[Path] = None
    try:
        from ..utils.audio import load_audio

        audio, sample_rate = await asyncio.to_thread(load_audio, str(tmp_path))
        duration = len(audio) / sample_rate

        destination_path = config.get_generations_dir() / f"{uuid.uuid4()}{file_suffix}"
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(tmp_path, destination_path)

        generation_text = (text or "").strip() or "Recorded voice clip"
        generation_language = (language or profile.language or "en").strip() or "en"

        return await history.create_generation(
            profile_id=profile_id,
            text=generation_text,
            language=generation_language,
            engine="qwen",
            model_size="1.7B",
            source_type="recording",
            audio_path=str(destination_path),
            duration=duration,
            seed=None,
            db=db,
            instruct=(instruct or "").strip() or None,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        if destination_path and destination_path.exists():
            destination_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        if destination_path and destination_path.exists():
            destination_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to process audio file: {extract_error_message(exc)}",
        )
    finally:
        tmp_path.unlink(missing_ok=True)
