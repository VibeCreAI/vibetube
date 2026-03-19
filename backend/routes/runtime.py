"""Runtime routes: transcription and active-task state."""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Annotated, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from .. import models, transcribe
from ..backends import get_model_config
from ..services.errors import extract_error_message
from ..services.model_management import model_download_message, run_model_load
from ..services.uploads import write_upload_to_temp
from ..utils.progress import get_progress_manager
from ..utils.tasks import get_task_manager

router = APIRouter()


@router.post("/transcribe", response_model=models.TranscriptionResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    language: Annotated[Optional[str], Form()] = None,
    model: Annotated[Optional[str], Form()] = None,
):
    """Transcribe audio file to text."""
    allowed_audio_exts = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".webm", ".opus"}
    uploaded_ext = Path(file.filename or "").suffix.lower()
    file_suffix = uploaded_ext if uploaded_ext in allowed_audio_exts else ".wav"
    tmp_path = await write_upload_to_temp(file, suffix=file_suffix)

    try:
        from ..utils.audio import load_audio

        audio, sr = await asyncio.to_thread(load_audio, str(tmp_path))
        duration = len(audio) / sr

        whisper_model = transcribe.get_whisper_model()
        model_size = (model or getattr(whisper_model, "model_size", None) or "base").strip() or "base"
        model_config = get_model_config(f"whisper-{model_size}")
        if not model_config:
            raise HTTPException(status_code=400, detail=f"Unsupported Whisper model: {model_size}")

        if not whisper_model._is_model_cached(model_size):
            task_manager = get_task_manager()
            progress_manager = get_progress_manager()

            async def download_whisper_background():
                try:
                    await run_model_load(model_config)
                except Exception as exc:
                    message = extract_error_message(exc)
                    progress_manager.mark_error(model_config.model_name, message)
                    task_manager.error_download(model_config.model_name, message)

            task_manager.start_download(model_config.model_name)
            progress_manager.update_progress(
                model_name=model_config.model_name,
                current=0,
                total=0,
                filename="Connecting to HuggingFace...",
                status="downloading",
            )
            asyncio.create_task(download_whisper_background())

            raise HTTPException(
                status_code=202,
                detail={
                    "message": model_download_message(model_config),
                    "model_name": model_config.model_name,
                    "downloading": True,
                },
            )

        text = await whisper_model.transcribe(str(tmp_path), language, model_size)

        return models.TranscriptionResponse(
            text=text,
            duration=duration,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=extract_error_message(exc))
    finally:
        tmp_path.unlink(missing_ok=True)


@router.get("/tasks/active", response_model=models.ActiveTasksResponse)
async def get_active_tasks():
    """Return all currently active downloads and generations."""
    task_manager = get_task_manager()
    progress_manager = get_progress_manager()

    active_downloads = []
    task_manager_downloads = task_manager.get_active_downloads()
    progress_active = progress_manager.get_all_active()

    download_map = {task.model_name: task for task in task_manager_downloads}
    progress_map = {p["model_name"]: p for p in progress_active}

    all_model_names = set(download_map.keys()) | set(progress_map.keys())
    for model_name in all_model_names:
        task = download_map.get(model_name)
        progress = progress_map.get(model_name)

        if task:
            active_downloads.append(
                models.ActiveDownloadTask(
                    model_name=model_name,
                    status=task.status,
                    started_at=task.started_at,
                )
            )
        elif progress:
            timestamp_str = progress.get("timestamp")
            if timestamp_str:
                try:
                    started_at = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    started_at = datetime.utcnow()
            else:
                started_at = datetime.utcnow()

            active_downloads.append(
                models.ActiveDownloadTask(
                    model_name=model_name,
                    status=progress.get("status", "downloading"),
                    started_at=started_at,
                )
            )

    active_generations = []
    for gen_task in task_manager.get_active_generations():
        active_generations.append(
            models.ActiveGenerationTask(
                task_id=gen_task.task_id,
                profile_id=gen_task.profile_id,
                text_preview=gen_task.text_preview,
                started_at=gen_task.started_at,
            )
        )

    return models.ActiveTasksResponse(
        downloads=active_downloads,
        generations=active_generations,
    )
