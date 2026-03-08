"""
FastAPI application for VibeTube backend.

Handles voice cloning, generation history, and server mode.
"""

from fastapi import FastAPI, Depends, UploadFile, File, Form, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime
import asyncio
import uvicorn
import argparse
import torch
import tempfile
import io
from pathlib import Path
import uuid
import asyncio
import signal
import os
import shutil
import json
import base64
import re
import random
import urllib.request
from urllib.parse import quote
from PIL import Image, ExifTags


def _safe_content_disposition(disposition_type: str, filename: str) -> str:
    """Build a Content-Disposition header that is safe for non-ASCII filenames.

    Uses RFC 5987 ``filename*`` parameter so that browsers can decode
    UTF-8 filenames while the ``filename`` fallback stays ASCII-only.
    """
    ascii_name = "".join(
        c for c in filename if c.isascii() and (c.isalnum() or c in " -_.")
    ).strip() or "download"
    utf8_name = quote(filename, safe="")
    return (
        f'{disposition_type}; filename="{ascii_name}"; '
        f"filename*=UTF-8''{utf8_name}"
    )


from . import database, models, profiles, history, tts, transcribe, config, export_import, channels, stories, vibetube, __version__
from .database import (
    get_db,
    Generation as DBGeneration,
    VoiceProfile as DBVoiceProfile,
    Story as DBStory,
    StoryItem as DBStoryItem,
)
from .utils.progress import get_progress_manager
from .utils.tasks import get_task_manager
from .utils.cache import clear_voice_prompt_cache
from .utils import avatar_local
from .platform_detect import get_backend_type


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

        profile = await profiles.get_profile(data.profile_id, db)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")

        tts_model = tts.get_tts_model()
        model_size = data.model_size or "1.7B"

        if not tts_model._is_model_cached(model_size):
            model_name = f"qwen-tts-{model_size}"

            async def download_model_background():
                try:
                    await tts_model.load_model_async(model_size)
                except Exception as e:
                    task_manager.error_download(model_name, str(e))

            task_manager.start_download(model_name)
            asyncio.create_task(download_model_background())

            raise HTTPException(
                status_code=202,
                detail={
                    "message": f"Model {model_size} is being downloaded. Please wait and try again.",
                    "model_name": model_name,
                    "downloading": True,
                },
            )

        await tts_model.load_model_async(model_size)

        voice_prompt = await profiles.create_voice_prompt_for_profile(
            data.profile_id,
            db,
        )

        audio, sample_rate = await tts_model.generate(
            data.text,
            voice_prompt,
            data.language,
            data.seed,
            data.instruct,
        )

        duration = len(audio) / sample_rate

        audio_path = config.get_generations_dir() / f"{uuid.uuid4()}.wav"

        from .utils.audio import save_audio

        save_audio(audio, str(audio_path), sample_rate)

        generation = await history.create_generation(
            profile_id=data.profile_id,
            text=data.text,
            language=data.language,
            audio_path=str(audio_path),
            duration=duration,
            seed=data.seed,
            db=db,
            instruct=data.instruct,
        )

        task_manager.complete_generation(generation_task_id)
        return generation
    except HTTPException:
        task_manager.complete_generation(generation_task_id)
        raise
    except ValueError as e:
        task_manager.complete_generation(generation_task_id)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        task_manager.complete_generation(generation_task_id)
        raise HTTPException(status_code=500, detail=str(e))

app = FastAPI(
    title="VibeTube API",
    description="Production-quality Qwen3-TTS voice cloning API",
    version=__version__,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_VIBETUBE_AVATAR_STATES = {"idle", "talk", "idle_blink", "talk_blink"}
_DEFAULT_AVATAR_MODEL_ID = os.environ.get(
    "VIBETUBE_AVATAR_MODEL_ID",
    "runwayml/stable-diffusion-v1-5",
)
_DEFAULT_AVATAR_LORA_ID = os.environ.get("VIBETUBE_AVATAR_LORA_ID") or None
_STYLIZED_PIXEL_MODEL_NAME = "stylizedpixel-m80"
_STYLIZED_PIXEL_DISPLAY_NAME = "StylizedPixel M80"
_STYLIZED_PIXEL_DOWNLOAD_URL = (
    "https://civitai.com/api/download/models/153325"
    "?type=Model&format=SafeTensor&size=full&fp=fp16"
)


def _vibetube_avatar_pack_dir(profile_id: str) -> Path:
    return config.get_profiles_dir() / profile_id / "vibetube_avatar"


def _vibetube_avatar_preview_dir(profile_id: str) -> Path:
    return config.get_profiles_dir() / profile_id / "vibetube_avatar_preview"


def _avatar_style_refs_dir() -> Path:
    return config.get_data_dir() / "avatar_style_refs"


def _bundled_avatar_style_refs_dir() -> Path:
    return Path(__file__).resolve().parent / "assets" / "avatar_style_refs"


def _stylized_pixel_model_path() -> Path:
    checkpoints_dir = config.get_models_dir() / "checkpoints"
    checkpoints_dir.mkdir(parents=True, exist_ok=True)
    return checkpoints_dir / "stylizedpixel_m80.safetensors"


def _list_avatar_style_references() -> list[Path]:
    refs: list[Path] = []
    for refs_dir in (_bundled_avatar_style_refs_dir(), _avatar_style_refs_dir()):
        if not refs_dir.exists():
            continue
        refs.extend(
            sorted(
                [
                    p
                    for p in refs_dir.iterdir()
                    if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
                ]
            )
        )
    return refs


def _build_image_model_status() -> models.ImageModelStatusResponse:
    model_path = _stylized_pixel_model_path()
    task_manager = get_task_manager()
    downloaded = model_path.exists() and model_path.is_file()
    return models.ImageModelStatusResponse(
        model_name=_STYLIZED_PIXEL_MODEL_NAME,
        display_name=_STYLIZED_PIXEL_DISPLAY_NAME,
        downloaded=downloaded,
        downloading=task_manager.is_download_active(_STYLIZED_PIXEL_MODEL_NAME),
        download_url=_STYLIZED_PIXEL_DOWNLOAD_URL,
        file_path=str(model_path) if downloaded else None,
        size_bytes=model_path.stat().st_size if downloaded else None,
    )


def _download_stylized_pixel_model() -> None:
    target_path = _stylized_pixel_model_path()
    temp_path = target_path.with_suffix(f"{target_path.suffix}.part")
    temp_path.parent.mkdir(parents=True, exist_ok=True)
    if temp_path.exists():
        temp_path.unlink()

    try:
        with urllib.request.urlopen(_STYLIZED_PIXEL_DOWNLOAD_URL) as response:
            with temp_path.open("wb") as destination:
                shutil.copyfileobj(response, destination)
        temp_path.replace(target_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def _build_vibetube_avatar_pack_response(profile_id: str) -> models.VibeTubeAvatarPackResponse:
    pack_dir = _vibetube_avatar_pack_dir(profile_id)

    def _state_url(state: str) -> Optional[str]:
        file_path = pack_dir / f"{state}.png"
        if not file_path.exists():
            return None
        return f"/profiles/{profile_id}/vibetube-avatar-pack/{state}"

    idle_url = _state_url("idle")
    talk_url = _state_url("talk")
    idle_blink_url = _state_url("idle_blink")
    talk_blink_url = _state_url("talk_blink")

    return models.VibeTubeAvatarPackResponse(
        profile_id=profile_id,
        idle_url=idle_url,
        talk_url=talk_url,
        idle_blink_url=idle_blink_url,
        talk_blink_url=talk_blink_url,
        complete=bool(idle_url and talk_url and idle_blink_url and talk_blink_url),
    )


def _build_vibetube_avatar_preview_response(profile_id: str) -> models.VibeTubeAvatarPreviewResponse:
    preview_dir = _vibetube_avatar_preview_dir(profile_id)

    def _state_url(state: str) -> Optional[str]:
        file_path = preview_dir / f"{state}.png"
        if not file_path.exists():
            return None
        return f"/profiles/{profile_id}/vibetube-avatar-preview/{state}"

    idle_url = _state_url("idle")
    talk_url = _state_url("talk")
    idle_blink_url = _state_url("idle_blink")
    talk_blink_url = _state_url("talk_blink")
    idle_ready = False
    idle_path = preview_dir / "idle.png"
    if idle_path.exists():
        try:
            with Image.open(idle_path) as idle_img:
                rgba = idle_img.convert("RGBA")
                alpha = rgba.getchannel("A")
                alpha_hist = alpha.histogram()
                non_transparent = sum(alpha_hist[1:])
                # Reject fully/mostly empty or effectively flat placeholders.
                rgb_extrema = rgba.convert("RGB").getextrema()
                flat_rgb = all(ch_min == ch_max for ch_min, ch_max in rgb_extrema)
                idle_ready = non_transparent >= 50 and not flat_rgb
        except Exception:
            idle_ready = False

    return models.VibeTubeAvatarPreviewResponse(
        profile_id=profile_id,
        idle_url=idle_url,
        idle_ready=idle_ready,
        talk_url=talk_url,
        idle_blink_url=idle_blink_url,
        talk_blink_url=talk_blink_url,
        complete=bool(idle_url and talk_url and idle_blink_url and talk_blink_url),
    )


def _save_vibetube_state_png(input_path: Path, output_path: Path, max_size: int = 512) -> None:
    """Process and save VibeTube avatar state while preserving transparency."""
    with Image.open(input_path) as img:
        try:
            orientation_tag = None
            for tag, name in ExifTags.TAGS.items():
                if name == "Orientation":
                    orientation_tag = tag
                    break
            if orientation_tag is not None and hasattr(img, "_getexif"):
                exif = img._getexif()
                if exif:
                    orientation = exif.get(orientation_tag)
                    if orientation == 3:
                        img = img.rotate(180, expand=True)
                    elif orientation == 6:
                        img = img.rotate(270, expand=True)
                    elif orientation == 8:
                        img = img.rotate(90, expand=True)
        except Exception:
            pass

        # Keep alpha channel for VibeTube states; convert non-alpha sources to RGBA.
        img = img.convert("RGBA")
        img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(output_path, format="PNG", optimize=True)


def _extract_caption_preview(captions_path: Path, max_chars: int = 120) -> Optional[str]:
    """Extract a short readable preview line from an SRT caption file."""
    if not captions_path.exists():
        return None
    try:
        for raw in captions_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.isdigit():
                continue
            if "-->" in line:
                continue
            return line[:max_chars]
    except Exception:
        return None
    return None


def _ensure_vibetube_job_captions(job_dir: Path) -> Path:
    """Resolve or regenerate captions.srt for a VibeTube job directory."""
    meta_path = job_dir / "meta.json"
    captions_path = job_dir / "captions.srt"
    meta: dict = {}

    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            meta = {}

    source_text = str(meta.get("source_text_preview") or "").strip()
    duration_sec = meta.get("duration_sec")
    try:
        duration_value = float(duration_sec)
    except (TypeError, ValueError):
        duration_value = 0.0

    # Prefer regenerating from source metadata when available so caption timing
    # reflects the latest subtitle writer logic for both new and existing jobs.
    if source_text and duration_value > 0:
        vibetube._write_srt(text=source_text, duration_sec=duration_value, out_path=captions_path)
        meta["captions"] = captions_path.name
        try:
            meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        except Exception:
            pass
        return captions_path

    if captions_path.exists():
        return captions_path

    # Respect explicit captions filename from metadata when regeneration is not possible.
    captions_name = str(meta.get("captions") or "").strip()
    if captions_name:
        named_path = job_dir / captions_name
        if named_path.exists():
            return named_path

    raise FileNotFoundError("No subtitle data found for this render job.")


def _srt_text_to_vtt_text(srt_text: str) -> str:
    """Convert SRT text payload to WebVTT payload."""
    lines = srt_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    converted: list[str] = ["WEBVTT", ""]
    for raw in lines:
        line = raw.strip()
        if line and line.isdigit():
            continue
        converted.append(raw.replace(",", "."))
    return "\n".join(converted).strip() + "\n"


def _save_data_url_image(data_url: str, target_path: Path) -> None:
    """Decode a data URL image and save it to disk."""
    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", data_url.strip())
    if not match:
        raise ValueError("Invalid background image data URL format.")
    mime_type = match.group(1).lower()
    raw_b64 = match.group(2)
    if mime_type not in {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"}:
        raise ValueError("Unsupported background image type. Use PNG/JPEG/WEBP/GIF.")
    try:
        payload = base64.b64decode(raw_b64, validate=True)
    except Exception as exc:
        raise ValueError("Invalid background image base64 payload.") from exc
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_bytes(payload)


# ============================================
# ROOT & HEALTH ENDPOINTS
# ============================================

@app.get("/")
async def root():
    """Root endpoint."""
    return {"message": "VibeTube API", "version": __version__}


@app.post("/shutdown")
async def shutdown():
    """Gracefully shutdown the server."""
    async def shutdown_async():
        await asyncio.sleep(0.1)  # Give response time to send
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(shutdown_async())
    return {"message": "Shutting down..."}


@app.get("/health", response_model=models.HealthResponse)
async def health():
    """Health check endpoint."""
    from huggingface_hub import hf_hub_download, constants as hf_constants
    from pathlib import Path
    import os

    tts_model = tts.get_tts_model()
    backend_type = get_backend_type()

    # Check for GPU availability (CUDA, MPS, Intel Arc XPU, or DirectML)
    has_cuda = torch.cuda.is_available()
    has_mps = hasattr(torch.backends, 'mps') and torch.backends.mps.is_available()

    # Intel Arc / Intel Xe via intel-extension-for-pytorch (IPEX)
    has_xpu = False
    xpu_name = None
    try:
        import intel_extension_for_pytorch as ipex  # noqa: F401
        if hasattr(torch, 'xpu') and torch.xpu.is_available():
            has_xpu = True
            try:
                xpu_name = torch.xpu.get_device_name(0)
            except Exception:
                xpu_name = "Intel GPU"
    except ImportError:
        pass

    # DirectML backend (torch-directml) for any Windows GPU
    has_directml = False
    directml_name = None
    try:
        import torch_directml
        if torch_directml.device_count() > 0:
            has_directml = True
            try:
                directml_name = torch_directml.device_name(0)
            except Exception:
                directml_name = "DirectML GPU"
    except ImportError:
        pass

    gpu_available = has_cuda or has_mps or has_xpu or has_directml or backend_type == "mlx"

    gpu_type = None
    if has_cuda:
        gpu_type = f"CUDA ({torch.cuda.get_device_name(0)})"
    elif has_mps:
        gpu_type = "MPS (Apple Silicon)"
    elif backend_type == "mlx":
        gpu_type = "Metal (Apple Silicon via MLX)"
    elif has_xpu:
        gpu_type = f"XPU ({xpu_name})"
    elif has_directml:
        gpu_type = f"DirectML ({directml_name})"

    vram_used = None
    if has_cuda:
        vram_used = torch.cuda.memory_allocated() / 1024 / 1024  # MB
    
    # Check if model is loaded - use the same logic as model status endpoint
    model_loaded = False
    model_size = None
    try:
        # Use the same check as model status endpoint
        if tts_model.is_loaded():
            model_loaded = True
            # Get the actual loaded model size
            # Check _current_model_size first (more reliable for actually loaded models)
            model_size = getattr(tts_model, '_current_model_size', None)
            if not model_size:
                # Fallback to model_size attribute (which should be set when model loads)
                model_size = getattr(tts_model, 'model_size', None)
    except Exception:
        # If there's an error checking, assume not loaded
        model_loaded = False
        model_size = None
    
    # Check if default model is downloaded (cached)
    model_downloaded = None
    try:
        # Check if the default model (1.7B) is cached
        # Use different model IDs based on backend
        if backend_type == "mlx":
            default_model_id = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
        else:
            default_model_id = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
        
        # Method 1: Try scan_cache_dir if available
        try:
            from huggingface_hub import scan_cache_dir
            cache_info = scan_cache_dir()
            for repo in cache_info.repos:
                if repo.repo_id == default_model_id:
                    model_downloaded = True
                    break
        except (ImportError, Exception):
            # Method 2: Check cache directory (using HuggingFace's OS-specific cache location)
            cache_dir = hf_constants.HF_HUB_CACHE
            repo_cache = Path(cache_dir) / ("models--" + default_model_id.replace("/", "--"))
            if repo_cache.exists():
                has_model_files = (
                    any(repo_cache.rglob("*.bin")) or
                    any(repo_cache.rglob("*.safetensors")) or
                    any(repo_cache.rglob("*.pt")) or
                    any(repo_cache.rglob("*.pth")) or
                    any(repo_cache.rglob("*.npz"))  # MLX models may use npz
                )
                model_downloaded = has_model_files
    except Exception:
        pass
    
    return models.HealthResponse(
        status="healthy",
        model_loaded=model_loaded,
        model_downloaded=model_downloaded,
        model_size=model_size,
        gpu_available=gpu_available,
        gpu_type=gpu_type,
        vram_used_mb=vram_used,
        backend_type=backend_type,
    )


# ============================================
# VOICE PROFILE ENDPOINTS
# ============================================

@app.post("/profiles", response_model=models.VoiceProfileResponse)
async def create_profile(
    data: models.VoiceProfileCreate,
    db: Session = Depends(get_db),
):
    """Create a new voice profile."""
    try:
        return await profiles.create_profile(data, db)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/profiles", response_model=List[models.VoiceProfileResponse])
async def list_profiles(
    exclude_story_only: bool = Query(default=False),
    db: Session = Depends(get_db),
):
    """List all voice profiles."""
    return await profiles.list_profiles(db, exclude_story_only=exclude_story_only)


@app.post("/profiles/import", response_model=models.VoiceProfileResponse)
async def import_profile(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Import a voice profile from a ZIP archive."""
    # Validate file size (max 100MB)
    MAX_FILE_SIZE = 100 * 1024 * 1024  # 100MB
    
    # Read file content
    content = await file.read()
    
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size is {MAX_FILE_SIZE / (1024 * 1024)}MB"
        )
    
    try:
        profile = await export_import.import_profile_from_zip(content, db)
        return profile
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/profiles/{profile_id}", response_model=models.VoiceProfileResponse)
async def get_profile(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Get a voice profile by ID."""
    profile = await profiles.get_profile(profile_id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


@app.put("/profiles/{profile_id}", response_model=models.VoiceProfileResponse)
async def update_profile(
    profile_id: str,
    data: models.VoiceProfileCreate,
    db: Session = Depends(get_db),
):
    """Update a voice profile."""
    profile = await profiles.update_profile(profile_id, data, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


@app.delete("/profiles/{profile_id}")
async def delete_profile(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Delete a voice profile."""
    success = await profiles.delete_profile(profile_id, db)
    if not success:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {"message": "Profile deleted successfully"}


@app.post("/profiles/{profile_id}/samples", response_model=models.ProfileSampleResponse)
async def add_profile_sample(
    profile_id: str,
    file: UploadFile = File(...),
    reference_text: str = Form(...),
    db: Session = Depends(get_db),
):
    """Add a sample to a voice profile."""
    # Preserve the uploaded file's extension so librosa can detect format correctly.
    # Defaulting to .wav was causing soundfile to reject MP3/WebM content as invalid WAV.
    _allowed_audio_exts = {'.wav', '.mp3', '.m4a', '.ogg', '.flac', '.aac', '.webm', '.opus'}
    _uploaded_ext = Path(file.filename or '').suffix.lower()
    file_suffix = _uploaded_ext if _uploaded_ext in _allowed_audio_exts else '.wav'

    with tempfile.NamedTemporaryFile(suffix=file_suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        sample = await profiles.add_profile_sample(
            profile_id,
            tmp_path,
            reference_text,
            db,
        )
        return sample
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process audio file: {str(e)}")
    finally:
        # Clean up temp file
        Path(tmp_path).unlink(missing_ok=True)


@app.get("/profiles/{profile_id}/samples", response_model=List[models.ProfileSampleResponse])
async def get_profile_samples(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Get all samples for a profile."""
    return await profiles.get_profile_samples(profile_id, db)


@app.delete("/profiles/samples/{sample_id}")
async def delete_profile_sample(
    sample_id: str,
    db: Session = Depends(get_db),
):
    """Delete a profile sample."""
    success = await profiles.delete_profile_sample(sample_id, db)
    if not success:
        raise HTTPException(status_code=404, detail="Sample not found")
    return {"message": "Sample deleted successfully"}


@app.put("/profiles/samples/{sample_id}", response_model=models.ProfileSampleResponse)
async def update_profile_sample(
    sample_id: str,
    data: models.ProfileSampleUpdate,
    db: Session = Depends(get_db),
):
    """Update a profile sample's reference text."""
    sample = await profiles.update_profile_sample(sample_id, data.reference_text, db)
    if not sample:
        raise HTTPException(status_code=404, detail="Sample not found")
    return sample


@app.put("/profiles/samples/{sample_id}/gain", response_model=models.ProfileSampleResponse)
async def update_profile_sample_gain(
    sample_id: str,
    data: models.ProfileSampleGainUpdate,
    db: Session = Depends(get_db),
):
    """Apply gain (dB) to a profile sample audio file."""
    try:
        sample = await profiles.apply_gain_to_profile_sample(sample_id, data.gain_db, db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not sample:
        raise HTTPException(status_code=404, detail="Sample not found")
    return sample


@app.post("/profiles/{profile_id}/avatar", response_model=models.VoiceProfileResponse)
async def upload_profile_avatar(
    profile_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload or update avatar image for a profile."""
    # Save uploaded file to temp location
    with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename).suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        profile = await profiles.upload_avatar(profile_id, tmp_path, db)
        return profile
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        # Clean up temp file
        Path(tmp_path).unlink(missing_ok=True)


@app.get("/profiles/{profile_id}/avatar")
async def get_profile_avatar(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Get avatar image for a profile."""
    profile = await profiles.get_profile(profile_id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    if not profile.avatar_path:
        raise HTTPException(status_code=404, detail="No avatar found for this profile")

    avatar_path = Path(profile.avatar_path)
    if not avatar_path.exists():
        raise HTTPException(status_code=404, detail="Avatar file not found")

    return FileResponse(avatar_path)


@app.delete("/profiles/{profile_id}/avatar")
async def delete_profile_avatar(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Delete avatar image for a profile."""
    success = await profiles.delete_avatar(profile_id, db)
    if not success:
        raise HTTPException(status_code=404, detail="Profile not found or no avatar to delete")
    return {"message": "Avatar deleted successfully"}


@app.post("/profiles/{profile_id}/vibetube-avatar-pack", response_model=models.VibeTubeAvatarPackResponse)
async def save_vibetube_avatar_pack(
    profile_id: str,
    idle: UploadFile = File(...),
    talk: UploadFile = File(...),
    idle_blink: UploadFile = File(...),
    talk_blink: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Save a 4-state VibeTube avatar pack linked to a voice profile."""
    profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    uploads = {
        "idle": idle,
        "talk": talk,
        "idle_blink": idle_blink,
        "talk_blink": talk_blink,
    }

    pack_dir = _vibetube_avatar_pack_dir(profile_id)
    pack_dir.mkdir(parents=True, exist_ok=True)

    for state_name, upload in uploads.items():
        suffix = Path(upload.filename or "").suffix.lower()
        if suffix not in {".png", ".webp", ".jpg", ".jpeg"}:
            suffix = ".png"

        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            data = await upload.read()
            tmp.write(data)
            tmp_path = Path(tmp.name)

        try:
            is_valid, error_msg = profiles.validate_image(str(tmp_path))
            if not is_valid:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid {state_name} image: {error_msg}",
                )

            out_path = pack_dir / f"{state_name}.png"
            _save_vibetube_state_png(tmp_path, out_path)
        finally:
            tmp_path.unlink(missing_ok=True)

    profile.updated_at = datetime.utcnow()
    db.commit()

    return _build_vibetube_avatar_pack_response(profile_id)


@app.get("/profiles/{profile_id}/vibetube-avatar-pack", response_model=models.VibeTubeAvatarPackResponse)
async def get_vibetube_avatar_pack(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Get metadata for a saved VibeTube avatar pack."""
    profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    return _build_vibetube_avatar_pack_response(profile_id)


@app.get("/profiles/{profile_id}/vibetube-avatar-pack/{state}")
async def get_vibetube_avatar_pack_state(
    profile_id: str,
    state: str,
    db: Session = Depends(get_db),
):
    """Serve a saved VibeTube avatar state image file."""
    if state not in _VIBETUBE_AVATAR_STATES:
        raise HTTPException(status_code=404, detail="Invalid state")

    profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    file_path = _vibetube_avatar_pack_dir(profile_id) / f"{state}.png"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Avatar state not found")

    return FileResponse(file_path)


@app.post(
    "/profiles/{profile_id}/vibetube-avatar-pack/generate-idle-preview",
    response_model=models.VibeTubeAvatarPreviewResponse,
)
async def generate_vibetube_avatar_idle_preview(
    profile_id: str,
    data: models.VibeTubeAvatarGenerateRequest,
    db: Session = Depends(get_db),
):
    """Generate idle preview only (step 1 of 2-stage avatar generation)."""
    profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    preview_dir = _vibetube_avatar_preview_dir(profile_id)
    if preview_dir.exists():
        shutil.rmtree(preview_dir, ignore_errors=True)
    preview_dir.mkdir(parents=True, exist_ok=True)

    max_attempts = 3
    base_seed = data.seed if data.seed is not None else random.randint(1, 2_147_000_000)
    style_ref_paths = _list_avatar_style_references() if data.match_existing_style else []
    pack_idle_path = _vibetube_avatar_pack_dir(profile_id) / "idle.png"
    reference_idle_paths = style_ref_paths or (
        [pack_idle_path] if (data.match_existing_style and pack_idle_path.exists()) else []
    )

    try:
        for attempt in range(max_attempts):
            try:
                attempt_seed = base_seed + (attempt * 9973)
                avatar_local.generate_avatar_idle(
                    profile_id=profile_id,
                    out_dir=preview_dir,
                    user_prompt=data.prompt,
                    model_id=(data.model_id or _DEFAULT_AVATAR_MODEL_ID),
                    lora_id=(data.lora_id or _DEFAULT_AVATAR_LORA_ID),
                    lora_scale=data.lora_scale,
                    seed=attempt_seed,
                    size=data.size,
                    output_size=data.output_size,
                    palette_colors=data.palette_colors,
                    negative_prompt=(data.negative_prompt or avatar_local.DEFAULT_NEGATIVE_PROMPT),
                    num_inference_steps=data.num_inference_steps,
                    guidance_scale=data.guidance_scale,
                    reference_idle_path=(reference_idle_paths[0] if reference_idle_paths else None),
                    reference_idle_paths=reference_idle_paths,
                    reference_strength=data.reference_strength,
                )
                break
            except avatar_local.AvatarGenerationError as exc:
                msg = str(exc).lower()
                if "empty/fully transparent" in msg and attempt < (max_attempts - 1):
                    continue
                raise HTTPException(status_code=400, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Avatar idle generation failed: {exc}")

    return _build_vibetube_avatar_preview_response(profile_id)


@app.post(
    "/profiles/{profile_id}/vibetube-avatar-pack/generate-rest-preview",
    response_model=models.VibeTubeAvatarPreviewResponse,
)
async def generate_vibetube_avatar_rest_preview(
    profile_id: str,
    data: models.VibeTubeAvatarGenerateRequest,
    db: Session = Depends(get_db),
):
    """Generate talk/idle_blink/talk_blink from existing idle preview (step 2 of 2)."""
    profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    preview_dir = _vibetube_avatar_preview_dir(profile_id)
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview_before = _build_vibetube_avatar_preview_response(profile_id)
    if not preview_before.idle_url or not preview_before.idle_ready:
        raise HTTPException(
            status_code=400,
            detail="Idle preview is missing or invalid. Generate a valid idle first.",
        )

    try:
        avatar_local.generate_avatar_states_from_idle(
            out_dir=preview_dir,
            user_prompt=data.prompt,
            model_id=(data.model_id or _DEFAULT_AVATAR_MODEL_ID),
            lora_id=(data.lora_id or _DEFAULT_AVATAR_LORA_ID),
            lora_scale=data.lora_scale,
            seed=data.seed,
            size=data.size,
            output_size=data.output_size,
            palette_colors=data.palette_colors,
            seed_step=data.seed_step,
            negative_prompt=(data.negative_prompt or avatar_local.DEFAULT_NEGATIVE_PROMPT),
            num_inference_steps=data.num_inference_steps,
            guidance_scale=data.guidance_scale,
            variation_strength=data.variation_strength,
        )
    except avatar_local.AvatarGenerationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Avatar state generation failed: {exc}")

    return _build_vibetube_avatar_preview_response(profile_id)


@app.post(
    "/profiles/{profile_id}/vibetube-avatar-pack/generate",
    response_model=models.VibeTubeAvatarPreviewResponse,
)
@app.post(
    "/profiles/{profile_id}/vibetube-avatar-pack/generate-preview",
    response_model=models.VibeTubeAvatarPreviewResponse,
)
async def generate_vibetube_avatar_pack(
    profile_id: str,
    data: models.VibeTubeAvatarGenerateRequest,
    db: Session = Depends(get_db),
):
    """Legacy endpoint disabled: use strict two-step preview generation."""
    raise HTTPException(
        status_code=400,
        detail="Use two-step generation: first /generate-idle-preview, then /generate-rest-preview.",
    )


@app.get(
    "/profiles/{profile_id}/vibetube-avatar-preview",
    response_model=models.VibeTubeAvatarPreviewResponse,
)
async def get_vibetube_avatar_preview(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Get metadata for generated avatar preview states."""
    profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return _build_vibetube_avatar_preview_response(profile_id)


@app.get("/profiles/{profile_id}/vibetube-avatar-preview/{state}")
async def get_vibetube_avatar_preview_state(
    profile_id: str,
    state: str,
    db: Session = Depends(get_db),
):
    """Serve generated avatar preview image by state."""
    if state not in _VIBETUBE_AVATAR_STATES:
        raise HTTPException(status_code=404, detail="Invalid state")
    profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    file_path = _vibetube_avatar_preview_dir(profile_id) / f"{state}.png"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Avatar preview state not found")
    return FileResponse(file_path)


@app.post(
    "/profiles/{profile_id}/vibetube-avatar-pack/apply-preview",
    response_model=models.VibeTubeAvatarPackResponse,
)
async def apply_vibetube_avatar_preview(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Apply generated preview states to the saved avatar pack."""
    profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    preview_dir = _vibetube_avatar_preview_dir(profile_id)
    pack_dir = _vibetube_avatar_pack_dir(profile_id)
    missing = [state for state in _VIBETUBE_AVATAR_STATES if not (preview_dir / f"{state}.png").exists()]
    if missing:
        raise HTTPException(status_code=400, detail=f"Preview states missing: {', '.join(sorted(missing))}")

    pack_dir.mkdir(parents=True, exist_ok=True)
    for state in _VIBETUBE_AVATAR_STATES:
        shutil.copy2(preview_dir / f"{state}.png", pack_dir / f"{state}.png")

    return _build_vibetube_avatar_pack_response(profile_id)


@app.get("/profiles/{profile_id}/export")
async def export_profile(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Export a voice profile as a ZIP archive."""
    try:
        # Get profile to get name for filename
        profile = await profiles.get_profile(profile_id, db)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        
        # Export to ZIP
        zip_bytes = export_import.export_profile_to_zip(profile_id, db)
        
        # Create safe filename
        safe_name = "".join(c for c in profile.name if c.isalnum() or c in (' ', '-', '_')).strip()
        if not safe_name:
            safe_name = "profile"
        filename = f"profile-{safe_name}.vibetube.zip"
        
        # Return as streaming response
        return StreamingResponse(
            io.BytesIO(zip_bytes),
            media_type="application/zip",
            headers={
                "Content-Disposition": _safe_content_disposition("attachment", filename)
            }
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ============================================
# AUDIO CHANNEL ENDPOINTS
# ============================================

@app.get("/channels", response_model=List[models.AudioChannelResponse])
async def list_channels(db: Session = Depends(get_db)):
    """List all audio channels."""
    return await channels.list_channels(db)


@app.post("/channels", response_model=models.AudioChannelResponse)
async def create_channel(
    data: models.AudioChannelCreate,
    db: Session = Depends(get_db),
):
    """Create a new audio channel."""
    try:
        return await channels.create_channel(data, db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/channels/{channel_id}", response_model=models.AudioChannelResponse)
async def get_channel(
    channel_id: str,
    db: Session = Depends(get_db),
):
    """Get an audio channel by ID."""
    channel = await channels.get_channel(channel_id, db)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    return channel


@app.put("/channels/{channel_id}", response_model=models.AudioChannelResponse)
async def update_channel(
    channel_id: str,
    data: models.AudioChannelUpdate,
    db: Session = Depends(get_db),
):
    """Update an audio channel."""
    try:
        channel = await channels.update_channel(channel_id, data, db)
        if not channel:
            raise HTTPException(status_code=404, detail="Channel not found")
        return channel
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/channels/{channel_id}")
async def delete_channel(
    channel_id: str,
    db: Session = Depends(get_db),
):
    """Delete an audio channel."""
    try:
        success = await channels.delete_channel(channel_id, db)
        if not success:
            raise HTTPException(status_code=404, detail="Channel not found")
        return {"message": "Channel deleted successfully"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/channels/{channel_id}/voices")
async def get_channel_voices(
    channel_id: str,
    db: Session = Depends(get_db),
):
    """Get list of profile IDs assigned to a channel."""
    try:
        profile_ids = await channels.get_channel_voices(channel_id, db)
        return {"profile_ids": profile_ids}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/channels/{channel_id}/voices")
async def set_channel_voices(
    channel_id: str,
    data: models.ChannelVoiceAssignment,
    db: Session = Depends(get_db),
):
    """Set which voices are assigned to a channel."""
    try:
        await channels.set_channel_voices(channel_id, data, db)
        return {"message": "Channel voices updated successfully"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/profiles/{profile_id}/channels")
async def get_profile_channels(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Get list of channel IDs assigned to a profile."""
    try:
        channel_ids = await channels.get_profile_channels(profile_id, db)
        return {"channel_ids": channel_ids}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/profiles/{profile_id}/channels")
async def set_profile_channels(
    profile_id: str,
    data: models.ProfileChannelAssignment,
    db: Session = Depends(get_db),
):
    """Set which channels a profile is assigned to."""
    try:
        await channels.set_profile_channels(profile_id, data, db)
        return {"message": "Profile channels updated successfully"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ============================================
# GENERATION ENDPOINTS
# ============================================

@app.post("/generate", response_model=models.GenerationResponse)
async def generate_speech(
    data: models.GenerationRequest,
    db: Session = Depends(get_db),
):
    """Generate speech from text using a voice profile."""
    return await generate_and_persist_speech(data, db)


@app.post("/generate/stream")
async def stream_speech(
    data: models.GenerationRequest,
    db: Session = Depends(get_db),
):
    """
    Generate speech and stream the WAV audio directly without saving to disk.

    Returns raw WAV bytes via a StreamingResponse so the client can start
    playing audio before the entire file has been received.  This endpoint
    does NOT create a history entry — use /generate for that.
    """
    profile = await profiles.get_profile(data.profile_id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    tts_model = tts.get_tts_model()
    model_size = data.model_size or "1.7B"

    if not tts_model._is_model_cached(model_size):
        raise HTTPException(
            status_code=400,
            detail=f"Model {model_size} is not downloaded yet. Use /generate to trigger a download.",
        )

    # Load the correct model before building the voice prompt (fixes issue #96)
    await tts_model.load_model_async(model_size)

    voice_prompt = await profiles.create_voice_prompt_for_profile(data.profile_id, db)

    audio, sample_rate = await tts_model.generate(
        data.text,
        voice_prompt,
        data.language,
        data.seed,
        data.instruct,
    )

    wav_bytes = tts.audio_to_wav_bytes(audio, sample_rate)

    async def _wav_stream():
        # Yield in chunks so large responses don't block the event loop
        chunk_size = 64 * 1024  # 64 KB
        for i in range(0, len(wav_bytes), chunk_size):
            yield wav_bytes[i : i + chunk_size]

    return StreamingResponse(
        _wav_stream(),
        media_type="audio/wav",
        headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
    )


@app.post("/vibetube/render", response_model=models.VibeTubeRenderResponse)
async def vibetube_render(
    profile_id: Optional[str] = Form(None),
    text: Optional[str] = Form(None),
    language: str = Form("en"),
    generation_id: Optional[str] = Form(None),
    fps: int = Form(30),
    width: int = Form(512),
    height: int = Form(512),
    on_threshold: float = Form(0.03),
    off_threshold: float = Form(0.02),
    smoothing_windows: int = Form(3),
    min_hold_windows: int = Form(1),
    blink_min_interval_sec: float = Form(3.5),
    blink_max_interval_sec: float = Form(5.5),
    blink_duration_frames: int = Form(3),
    head_motion_amount_px: float = Form(3.0),
    head_motion_change_sec: float = Form(2.8),
    head_motion_smoothness: float = Form(0.04),
    voice_bounce_amount_px: float = Form(4.0),
    voice_bounce_sensitivity: float = Form(1.0),
    use_background_color: bool = Form(False),
    use_background_image: bool = Form(False),
    use_background: bool = Form(False),
    background_color: str = Form("#101820"),
    subtitle_enabled: bool = Form(False),
    subtitle_style: str = Form("minimal", pattern="^(minimal|cinema|glass)$"),
    subtitle_text_color: str = Form("#FFFFFF", pattern="^#[0-9A-Fa-f]{6}$"),
    subtitle_outline_color: str = Form("#000000", pattern="^#[0-9A-Fa-f]{6}$"),
    subtitle_outline_width: int = Form(2, ge=0, le=12),
    subtitle_font_family: str = Form("sans", pattern="^(sans|serif|mono)$"),
    subtitle_bold: bool = Form(True),
    subtitle_italic: bool = Form(False),
    show_profile_names: bool = Form(True),
    background_image: Optional[UploadFile] = File(None),
    idle: Optional[UploadFile] = File(None),
    talk: Optional[UploadFile] = File(None),
    idle_blink: Optional[UploadFile] = File(None),
    talk_blink: Optional[UploadFile] = File(None),
    blink: Optional[UploadFile] = File(None),
    db: Session = Depends(get_db),
):
    """
    Render a PNGtuber overlay video from an existing generation or from fresh text generation.
    """
    try:
        if generation_id:
            generation = db.query(DBGeneration).filter_by(id=generation_id).first()
            if not generation:
                raise HTTPException(status_code=404, detail="Generation not found")
            audio_path = Path(generation.audio_path)
            source_text = generation.text
            source_generation_id = generation.id
            avatar_profile_id = generation.profile_id
        else:
            if not profile_id or not text:
                raise HTTPException(
                    status_code=400,
                    detail="Provide generation_id OR both profile_id and text",
                )
            gen = await generate_speech(
                data=models.GenerationRequest(
                    profile_id=profile_id,
                    text=text,
                    language=language,
                ),
                db=db,
            )
            audio_path = Path(gen.audio_path)
            source_text = gen.text
            source_generation_id = gen.id
            avatar_profile_id = profile_id

        if profile_id:
            avatar_profile_id = profile_id

        if not audio_path.exists():
            raise HTTPException(status_code=404, detail="Source audio file not found")

        job_id = str(uuid.uuid4())
        base_out = config.get_data_dir() / "vibetube" / job_id
        avatar_dir = base_out / "avatar"
        avatar_dir.mkdir(parents=True, exist_ok=True)

        async def save_upload(upload: UploadFile, target: Path):
            data = await upload.read()
            target.write_bytes(data)

        if idle and talk:
            await save_upload(idle, avatar_dir / "idle.png")
            await save_upload(talk, avatar_dir / "talk.png")
            if idle_blink:
                await save_upload(idle_blink, avatar_dir / "idle_blink.png")
            if talk_blink:
                await save_upload(talk_blink, avatar_dir / "talk_blink.png")
            if blink:
                await save_upload(blink, avatar_dir / "blink.png")
        else:
            pack_dir = _vibetube_avatar_pack_dir(avatar_profile_id)
            if not (pack_dir / "idle.png").exists() or not (pack_dir / "talk.png").exists():
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Avatar images are missing. Upload idle/talk images, "
                        "or save a VibeTube avatar pack for this voice profile first."
                    ),
                )

            shutil.copy2(pack_dir / "idle.png", avatar_dir / "idle.png")
            shutil.copy2(pack_dir / "talk.png", avatar_dir / "talk.png")
            if (pack_dir / "idle_blink.png").exists():
                shutil.copy2(pack_dir / "idle_blink.png", avatar_dir / "idle_blink.png")
            if (pack_dir / "talk_blink.png").exists():
                shutil.copy2(pack_dir / "talk_blink.png", avatar_dir / "talk_blink.png")
            if (pack_dir / "blink.png").exists():
                shutil.copy2(pack_dir / "blink.png", avatar_dir / "blink.png")

        background_image_path: Optional[Path] = None
        if use_background_image and background_image is not None:
            suffix = Path(background_image.filename or "").suffix.lower()
            if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
                suffix = ".png"
            background_image_path = base_out / f"background{suffix}"
            await save_upload(background_image, background_image_path)

        background_enabled = bool(use_background or use_background_color or (use_background_image and background_image_path))
        source_profile_name: Optional[str] = None
        if avatar_profile_id:
            profile = db.query(DBVoiceProfile).filter_by(id=avatar_profile_id).first()
            if profile:
                source_profile_name = profile.name

        render_result = vibetube.render_overlay(
            audio_path=audio_path,
            avatar_dir=avatar_dir,
            output_dir=base_out,
            fps=fps,
            width=width,
            height=height,
            on_threshold=on_threshold,
            off_threshold=off_threshold,
            smoothing_windows=smoothing_windows,
            min_hold_windows=min_hold_windows,
            blink_min_interval_sec=blink_min_interval_sec,
            blink_max_interval_sec=blink_max_interval_sec,
            blink_duration_frames=blink_duration_frames,
            head_motion_amount_px=head_motion_amount_px,
            head_motion_change_sec=head_motion_change_sec,
            head_motion_smoothness=head_motion_smoothness,
            voice_bounce_amount_px=voice_bounce_amount_px,
            voice_bounce_sensitivity=voice_bounce_sensitivity,
            use_background=background_enabled,
            background_color=background_color if use_background_color else None,
            background_image_path=background_image_path,
            text=source_text,
            subtitle_enabled=subtitle_enabled,
            subtitle_style=subtitle_style,
            subtitle_text_color=subtitle_text_color,
            subtitle_outline_color=subtitle_outline_color,
            subtitle_outline_width=subtitle_outline_width,
            subtitle_font_family=subtitle_font_family,
            subtitle_bold=subtitle_bold,
            subtitle_italic=subtitle_italic,
            show_profile_names=show_profile_names,
            profile_display_name=source_profile_name,
        )

        meta_path = Path(render_result["meta_path"])
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            meta = {}
        meta.update(
            {
                "source_generation_id": source_generation_id,
                "source_profile_id": avatar_profile_id,
                "source_profile_name": source_profile_name,
                "source_text_preview": (source_text or "").strip(),
            }
        )
        meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

        return models.VibeTubeRenderResponse(
            job_id=job_id,
            output_dir=str(base_out.resolve()),
            video_path=str(Path(render_result["video_path"]).resolve()),
            timeline_path=str(Path(render_result["timeline_path"]).resolve()),
            captions_path=str(Path(render_result["captions_path"]).resolve()) if render_result["captions_path"] else None,
            meta_path=str(Path(render_result["meta_path"]).resolve()),
            duration=float(render_result["duration_sec"]),
            source_generation_id=source_generation_id,
        )
    except HTTPException:
        raise
    except vibetube.VibeTubeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VibeTube render failed: {str(e)}")


@app.get("/vibetube/jobs/{job_id}/video")
async def vibetube_job_video(job_id: str):
    """Serve rendered WebM video for in-app preview."""
    video_path = config.get_data_dir() / "vibetube" / job_id / "avatar.webm"
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Rendered video not found")
    return FileResponse(video_path, media_type="video/webm")


@app.get("/vibetube/jobs/{job_id}/export-mp4")
async def vibetube_export_mp4(job_id: str):
    """Export rendered job as MP4 and return as downloadable file."""
    base_out = config.get_data_dir() / "vibetube" / job_id
    webm_path = base_out / "avatar.webm"
    mp4_path = base_out / "avatar.mp4"

    if not webm_path.exists():
        raise HTTPException(status_code=404, detail="Rendered video not found")

    try:
        vibetube.export_mp4(webm_path=webm_path, mp4_path=mp4_path)
    except vibetube.VibeTubeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MP4 export failed: {str(e)}")

    return FileResponse(
        mp4_path,
        media_type="video/mp4",
        filename=f"vibetube-{job_id}.mp4",
    )


@app.get("/vibetube/jobs/{job_id}/export-subtitles")
async def vibetube_export_subtitles(
    job_id: str,
    format: str = Query(default="srt", pattern="^(srt|vtt)$"),
):
    """Export subtitles with timestamps for a rendered VibeTube job."""
    job_dir = config.get_data_dir() / "vibetube" / job_id
    if not job_dir.exists() or not job_dir.is_dir():
        raise HTTPException(status_code=404, detail="VibeTube job not found")

    try:
        captions_path = _ensure_vibetube_job_captions(job_dir)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Subtitle export failed: {str(e)}")

    if format == "srt":
        return FileResponse(
            captions_path,
            media_type="application/x-subrip",
            filename=f"vibetube-{job_id}.srt",
        )

    try:
        srt_text = captions_path.read_text(encoding="utf-8")
        vtt_text = _srt_text_to_vtt_text(srt_text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to convert subtitles to VTT: {str(e)}")

    return StreamingResponse(
        io.BytesIO(vtt_text.encode("utf-8")),
        media_type="text/vtt",
        headers={
            "Content-Disposition": _safe_content_disposition("attachment", f"vibetube-{job_id}.vtt")
        },
    )


@app.get("/vibetube/jobs", response_model=List[models.VibeTubeJobResponse])
async def list_vibetube_jobs(db: Session = Depends(get_db)):
    """List all rendered VibeTube jobs."""
    jobs_root = config.get_data_dir() / "vibetube"
    if not jobs_root.exists():
        return []

    jobs: List[models.VibeTubeJobResponse] = []
    for job_dir in jobs_root.iterdir():
        if not job_dir.is_dir():
            continue

        meta_path = job_dir / "meta.json"
        created_ts = datetime.fromtimestamp(job_dir.stat().st_mtime)
        duration_sec: Optional[float] = None
        video_path: Optional[str] = None
        source_generation_id: Optional[str] = None
        source_story_id: Optional[str] = None
        source_story_name: Optional[str] = None
        source_profile_name: Optional[str] = None
        source_text_preview: Optional[str] = None

        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                duration_sec = float(meta.get("duration_sec")) if meta.get("duration_sec") is not None else None
                source_generation_id = meta.get("source_generation_id")
                source_story_id = meta.get("source_story_id")
                source_story_name = meta.get("source_story_name")
                source_profile_name = meta.get("source_profile_name")
                source_text_preview = meta.get("source_text_preview")
            except Exception:
                duration_sec = None

        # Backfill metadata for older jobs that don't have source fields in meta.json.
        if source_generation_id is None and meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                audio_name = str(meta.get("audio") or "").strip()
                if audio_name.lower().endswith(".wav"):
                    source_generation_id = Path(audio_name).stem
            except Exception:
                pass

        if source_generation_id and (not source_profile_name or not source_text_preview):
            generation = db.query(DBGeneration).filter_by(id=source_generation_id).first()
            if generation:
                if not source_text_preview:
                    source_text_preview = generation.text
                if not source_profile_name:
                    profile = db.query(DBVoiceProfile).filter_by(id=generation.profile_id).first()
                    if profile:
                        source_profile_name = profile.name

        # Last-resort text preview fallback for old jobs: read first subtitle line from captions.srt.
        if not source_text_preview and meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                captions_name = str(meta.get("captions") or "").strip()
                if captions_name:
                    source_text_preview = _extract_caption_preview(job_dir / captions_name)
            except Exception:
                pass

        webm_path = job_dir / "avatar.webm"
        if webm_path.exists():
            video_path = str(webm_path.resolve())

        jobs.append(
            models.VibeTubeJobResponse(
                job_id=job_dir.name,
                created_at=created_ts,
                duration_sec=duration_sec,
                video_path=video_path,
                source_generation_id=source_generation_id,
                source_story_id=source_story_id,
                source_story_name=source_story_name,
                source_profile_name=source_profile_name,
                source_text_preview=source_text_preview,
            )
        )

    jobs.sort(key=lambda item: item.created_at, reverse=True)
    return jobs


@app.delete("/vibetube/jobs/{job_id}")
async def delete_vibetube_job(job_id: str):
    """Delete one VibeTube render job and all generated files."""
    job_dir = config.get_data_dir() / "vibetube" / job_id
    if not job_dir.exists() or not job_dir.is_dir():
        raise HTTPException(status_code=404, detail="VibeTube job not found")

    shutil.rmtree(job_dir, ignore_errors=True)
    return {"message": "VibeTube job deleted"}


# ============================================
# HISTORY ENDPOINTS
# ============================================

@app.get("/history", response_model=models.HistoryListResponse)
async def list_history(
    profile_id: Optional[str] = None,
    search: Optional[str] = None,
    exclude_story_generations: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    """List generation history with optional filters."""
    query = models.HistoryQuery(
        profile_id=profile_id,
        search=search,
        exclude_story_generations=exclude_story_generations,
        limit=limit,
        offset=offset,
    )
    return await history.list_generations(query, db)


@app.get("/history/stats")
async def get_stats(db: Session = Depends(get_db)):
    """Get generation statistics."""
    return await history.get_generation_stats(db)


@app.post("/history/import")
async def import_generation(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Import a generation from a ZIP archive."""
    # Validate file size (max 50MB)
    MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
    
    # Read file content
    content = await file.read()
    
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size is {MAX_FILE_SIZE / (1024 * 1024)}MB"
        )
    
    try:
        result = await export_import.import_generation_from_zip(content, db)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/history/{generation_id}", response_model=models.HistoryResponse)
async def get_generation(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Get a generation by ID."""
    # Get generation with profile name
    result = db.query(
        DBGeneration,
        DBVoiceProfile.name.label('profile_name')
    ).join(
        DBVoiceProfile,
        DBGeneration.profile_id == DBVoiceProfile.id
    ).filter(
        DBGeneration.id == generation_id
    ).first()
    
    if not result:
        raise HTTPException(status_code=404, detail="Generation not found")
    
    gen, profile_name = result
    return models.HistoryResponse(
        id=gen.id,
        profile_id=gen.profile_id,
        profile_name=profile_name,
        text=gen.text,
        language=gen.language,
        audio_path=gen.audio_path,
        duration=gen.duration,
        seed=gen.seed,
        instruct=gen.instruct,
        created_at=gen.created_at,
    )


@app.delete("/history/{generation_id}")
async def delete_generation(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Delete a generation."""
    success = await history.delete_generation(generation_id, db)
    if not success:
        raise HTTPException(status_code=404, detail="Generation not found")
    return {"message": "Generation deleted successfully"}


@app.get("/history/{generation_id}/export")
async def export_generation(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Export a generation as a ZIP archive."""
    try:
        # Get generation to create filename
        generation = db.query(DBGeneration).filter_by(id=generation_id).first()
        if not generation:
            raise HTTPException(status_code=404, detail="Generation not found")
        
        # Export to ZIP
        zip_bytes = export_import.export_generation_to_zip(generation_id, db)
        
        # Create safe filename from text
        safe_text = "".join(c for c in generation.text[:30] if c.isalnum() or c in (' ', '-', '_')).strip()
        if not safe_text:
            safe_text = "generation"
        filename = f"generation-{safe_text}.vibetube.zip"
        
        # Return as streaming response
        return StreamingResponse(
            io.BytesIO(zip_bytes),
            media_type="application/zip",
            headers={
                "Content-Disposition": _safe_content_disposition("attachment", filename)
            }
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/history/{generation_id}/export-audio")
async def export_generation_audio(
    generation_id: str,
    db: Session = Depends(get_db),
):
    """Export only the audio file from a generation."""
    generation = db.query(DBGeneration).filter_by(id=generation_id).first()
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    
    audio_path = Path(generation.audio_path)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    
    # Create safe filename from text
    safe_text = "".join(c for c in generation.text[:30] if c.isalnum() or c in (' ', '-', '_')).strip()
    if not safe_text:
        safe_text = "generation"
    filename = f"{safe_text}.wav"
    
    return FileResponse(
        audio_path,
        media_type="audio/wav",
        headers={
            "Content-Disposition": _safe_content_disposition("attachment", filename)
        }
    )


# ============================================
# TRANSCRIPTION ENDPOINTS
# ============================================

@app.post("/transcribe", response_model=models.TranscriptionResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
):
    """Transcribe audio file to text."""
    # Save uploaded file to temporary location
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    
    try:
        # Get audio duration
        from .utils.audio import load_audio
        audio, sr = load_audio(tmp_path)
        duration = len(audio) / sr
        
        # Transcribe
        whisper_model = transcribe.get_whisper_model()

        # Check if Whisper model is downloaded (uses default size "base")
        model_size = whisper_model.model_size
        model_name = f"openai/whisper-{model_size}"

        # Check if model is cached
        from huggingface_hub import constants as hf_constants
        repo_cache = Path(hf_constants.HF_HUB_CACHE) / ("models--" + model_name.replace("/", "--"))
        if not repo_cache.exists():
            # Start download in background
            progress_model_name = f"whisper-{model_size}"

            async def download_whisper_background():
                try:
                    await whisper_model.load_model_async(model_size)
                except Exception as e:
                    get_task_manager().error_download(progress_model_name, str(e))

            get_task_manager().start_download(progress_model_name)
            asyncio.create_task(download_whisper_background())

            # Return 202 Accepted
            raise HTTPException(
                status_code=202,
                detail={
                    "message": f"Whisper model {model_size} is being downloaded. Please wait and try again.",
                    "model_name": progress_model_name,
                    "downloading": True
                }
            )

        text = await whisper_model.transcribe(tmp_path, language)
        
        return models.TranscriptionResponse(
            text=text,
            duration=duration,
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Clean up temp file
        Path(tmp_path).unlink(missing_ok=True)


# ============================================
# STORY ENDPOINTS
# ============================================

async def _render_story_vibetube_internal(
    story_id: str,
    data: models.StoryVibeTubeRenderRequest,
    db: Session,
) -> models.VibeTubeRenderResponse:
    """Internal helper used by both the story render endpoint and batch story creation."""
    story = db.query(DBStory).filter_by(id=story_id).first()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

    rows = (
        db.query(DBStoryItem, DBGeneration)
        .join(DBGeneration, DBStoryItem.generation_id == DBGeneration.id)
        .filter(DBStoryItem.story_id == story_id)
        .order_by(DBStoryItem.start_time_ms)
        .all()
    )
    if not rows:
        raise HTTPException(status_code=400, detail="Story has no items to render")

    audio_bytes = await stories.export_story_audio(story_id, db)
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Story has no renderable audio items")

    job_id = str(uuid.uuid4())
    base_out = config.get_data_dir() / "vibetube" / job_id
    avatar_root = base_out / "avatar"
    avatar_root.mkdir(parents=True, exist_ok=True)

    mixed_audio_path = base_out / "story.wav"
    mixed_audio_path.write_bytes(audio_bytes)

    profile_segments: dict[str, list[tuple[float, float]]] = {}
    profile_display_names: dict[str, str] = {}
    story_text_parts: list[str] = []
    story_subtitle_cues: list[dict[str, int | str]] = []

    for item, generation in rows:
        trim_start_ms = max(0, int(getattr(item, "trim_start_ms", 0) or 0))
        trim_end_ms = max(0, int(getattr(item, "trim_end_ms", 0) or 0))
        original_ms = max(0, int(round(float(generation.duration) * 1000)))
        effective_ms = max(0, original_ms - trim_start_ms - trim_end_ms)
        if effective_ms <= 0:
            continue

        start_sec = max(0.0, float(item.start_time_ms) / 1000.0)
        end_sec = start_sec + (effective_ms / 1000.0)
        profile_segments.setdefault(generation.profile_id, []).append((start_sec, end_sec))

        text = (generation.text or "").strip()
        if text:
            story_text_parts.append(text)
            relative_cues = vibetube._build_subtitle_cues(text=text, duration_sec=effective_ms / 1000.0)
            for cue in relative_cues:
                story_subtitle_cues.append(
                    {
                        "start_ms": int(item.start_time_ms) + int(cue["start_ms"]),
                        "end_ms": int(item.start_time_ms) + int(cue["end_ms"]),
                        "text": str(cue["text"]),
                    }
                )

    if not profile_segments:
        raise HTTPException(status_code=400, detail="Story has no effective audio after trim settings")

    for profile_id in sorted(profile_segments.keys()):
        profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
        profile_name = profile.name if profile else profile_id
        profile_display_names[profile_id] = profile_name
        pack_dir = _vibetube_avatar_pack_dir(profile_id)
        if not (pack_dir / "idle.png").exists() or not (pack_dir / "talk.png").exists():
            raise HTTPException(
                status_code=400,
                detail=(
                    f'VibeTube avatar pack missing for profile "{profile_name}". '
                    "Save idle/talk (and optional blink) images for each voice in this story."
                ),
            )

        out_dir = avatar_root / profile_id
        out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(pack_dir / "idle.png", out_dir / "idle.png")
        shutil.copy2(pack_dir / "talk.png", out_dir / "talk.png")
        if (pack_dir / "idle_blink.png").exists():
            shutil.copy2(pack_dir / "idle_blink.png", out_dir / "idle_blink.png")
        if (pack_dir / "talk_blink.png").exists():
            shutil.copy2(pack_dir / "talk_blink.png", out_dir / "talk_blink.png")
        if (pack_dir / "blink.png").exists():
            shutil.copy2(pack_dir / "blink.png", out_dir / "blink.png")

    avatar_dirs = {profile_id: avatar_root / profile_id for profile_id in profile_segments.keys()}
    story_text = "\n".join(story_text_parts)
    story_background_image_path: Optional[Path] = None
    if data.use_background_image and data.background_image_data:
        try:
            story_background_image_path = base_out / "story_background.png"
            _save_data_url_image(data.background_image_data, story_background_image_path)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    story_background_enabled = bool(
        data.use_background
        or data.use_background_color
        or (data.use_background_image and story_background_image_path is not None)
    )

    render_result = vibetube.render_story_overlay(
        audio_path=mixed_audio_path,
        profile_segments=profile_segments,
        avatar_dirs=avatar_dirs,
        output_dir=base_out,
        fps=data.fps,
        width=data.width,
        height=data.height,
        on_threshold=data.on_threshold,
        off_threshold=data.off_threshold,
        smoothing_windows=data.smoothing_windows,
        min_hold_windows=data.min_hold_windows,
        blink_min_interval_sec=data.blink_min_interval_sec,
        blink_max_interval_sec=data.blink_max_interval_sec,
        blink_duration_frames=data.blink_duration_frames,
        head_motion_amount_px=data.head_motion_amount_px,
        head_motion_change_sec=data.head_motion_change_sec,
        head_motion_smoothness=data.head_motion_smoothness,
        voice_bounce_amount_px=data.voice_bounce_amount_px,
        voice_bounce_sensitivity=data.voice_bounce_sensitivity,
        use_background=story_background_enabled,
        background_color=data.background_color if data.use_background_color else None,
        background_image_path=story_background_image_path,
        text=story_text,
        subtitle_enabled=data.subtitle_enabled,
        subtitle_style=data.subtitle_style,
        subtitle_text_color=data.subtitle_text_color,
        subtitle_outline_color=data.subtitle_outline_color,
        subtitle_outline_width=data.subtitle_outline_width,
        subtitle_font_family=data.subtitle_font_family,
        subtitle_bold=data.subtitle_bold,
        subtitle_italic=data.subtitle_italic,
        story_layout_style=data.story_layout_style,
        show_profile_names=data.show_profile_names,
        profile_display_names=profile_display_names,
        subtitle_cues=story_subtitle_cues,
    )

    source_text_preview = story_text.strip()[:1000] if story_text.strip() else None

    meta_path = Path(render_result["meta_path"])
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        meta = {}
    meta.update(
        {
            "source_story_id": story_id,
            "source_story_name": story.name,
            "source_text_preview": source_text_preview,
        }
    )
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return models.VibeTubeRenderResponse(
        job_id=job_id,
        output_dir=str(base_out.resolve()),
        video_path=str(Path(render_result["video_path"]).resolve()),
        timeline_path=str(Path(render_result["timeline_path"]).resolve()),
        captions_path=str(Path(render_result["captions_path"]).resolve())
        if render_result["captions_path"]
        else None,
        meta_path=str(Path(render_result["meta_path"]).resolve()),
        duration=float(render_result["duration_sec"]),
        source_story_id=story_id,
    )

@app.get("/stories", response_model=List[models.StoryResponse])
async def list_stories(db: Session = Depends(get_db)):
    """List all stories."""
    return await stories.list_stories(db)


@app.post("/stories", response_model=models.StoryResponse)
async def create_story(
    data: models.StoryCreate,
    db: Session = Depends(get_db),
):
    """Create a new story."""
    try:
        return await stories.create_story(data, db)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/stories/batch", response_model=models.StoryBatchCreateResponse)
async def create_story_batch(
    data: models.StoryBatchCreateRequest,
    db: Session = Depends(get_db),
):
    """Create a new story by generating multiple rows sequentially."""
    try:
        return await stories.create_story_from_batch(
            data,
            db,
            generate_func=generate_and_persist_speech,
            render_func=_render_story_vibetube_internal,
        )
    except stories.StoryBatchValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except stories.StoryBatchGenerationError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/stories/import-json", response_model=models.StoryBatchCreateResponse)
async def import_story_json(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Import a JSON script and create a new multi-voice story."""
    try:
        if not file.filename or not file.filename.lower().endswith(".json"):
            raise HTTPException(status_code=400, detail="Please upload a .json file")

        raw_content = await file.read()
        try:
            payload = json.loads(raw_content.decode("utf-8"))
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="JSON file must be UTF-8 encoded")
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"Malformed JSON: {e.msg}")

        try:
            request = models.StoryBatchCreateRequest.model_validate(payload)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid JSON schema: {e}")

        return await stories.create_story_from_batch(
            request,
            db,
            generate_func=generate_and_persist_speech,
            render_func=_render_story_vibetube_internal,
        )
    except stories.StoryBatchValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except stories.StoryBatchGenerationError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/stories/{story_id}", response_model=models.StoryDetailResponse)
async def get_story(
    story_id: str,
    db: Session = Depends(get_db),
):
    """Get a story with all its items."""
    story = await stories.get_story(story_id, db)
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    return story


@app.put("/stories/{story_id}", response_model=models.StoryResponse)
async def update_story(
    story_id: str,
    data: models.StoryCreate,
    db: Session = Depends(get_db),
):
    """Update a story."""
    story = await stories.update_story(story_id, data, db)
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")
    return story


@app.delete("/stories/{story_id}")
async def delete_story(
    story_id: str,
    db: Session = Depends(get_db),
):
    """Delete a story."""
    success = await stories.delete_story(story_id, db)
    if not success:
        raise HTTPException(status_code=404, detail="Story not found")
    return {"message": "Story deleted successfully"}


@app.post("/stories/{story_id}/items", response_model=models.StoryItemDetail)
async def add_story_item(
    story_id: str,
    data: models.StoryItemCreate,
    db: Session = Depends(get_db),
):
    """Add a generation to a story."""
    item = await stories.add_item_to_story(story_id, data, db)
    if not item:
        raise HTTPException(status_code=404, detail="Story or generation not found")
    return item


@app.delete("/stories/{story_id}/items/{item_id}")
async def remove_story_item(
    story_id: str,
    item_id: str,
    db: Session = Depends(get_db),
):
    """Remove a story item from a story."""
    success = await stories.remove_item_from_story(story_id, item_id, db)
    if not success:
        raise HTTPException(status_code=404, detail="Story item not found")
    return {"message": "Item removed successfully"}


@app.put("/stories/{story_id}/items/times")
async def update_story_item_times(
    story_id: str,
    data: models.StoryItemBatchUpdate,
    db: Session = Depends(get_db),
):
    """Update story item timecodes."""
    success = await stories.update_story_item_times(story_id, data, db)
    if not success:
        raise HTTPException(status_code=400, detail="Invalid timecode update request")
    return {"message": "Item timecodes updated successfully"}


@app.put("/stories/{story_id}/items/reorder", response_model=List[models.StoryItemDetail])
async def reorder_story_items(
    story_id: str,
    data: models.StoryItemReorder,
    db: Session = Depends(get_db),
):
    """Reorder story items and recalculate timecodes."""
    items = await stories.reorder_story_items(story_id, data.generation_ids, db)
    if items is None:
        raise HTTPException(status_code=400, detail="Invalid reorder request - ensure all generation IDs belong to this story")
    return items


@app.put("/stories/{story_id}/items/{item_id}/move", response_model=models.StoryItemDetail)
async def move_story_item(
    story_id: str,
    item_id: str,
    data: models.StoryItemMove,
    db: Session = Depends(get_db),
):
    """Move a story item (update position and/or track)."""
    item = await stories.move_story_item(story_id, item_id, data, db)
    if item is None:
        raise HTTPException(status_code=404, detail="Story item not found")
    return item


@app.put("/stories/{story_id}/items/{item_id}/trim", response_model=models.StoryItemDetail)
async def trim_story_item(
    story_id: str,
    item_id: str,
    data: models.StoryItemTrim,
    db: Session = Depends(get_db),
):
    """Trim a story item (update trim_start_ms and trim_end_ms)."""
    item = await stories.trim_story_item(story_id, item_id, data, db)
    if item is None:
        raise HTTPException(status_code=404, detail="Story item not found or invalid trim values")
    return item


@app.post("/stories/{story_id}/items/{item_id}/split", response_model=List[models.StoryItemDetail])
async def split_story_item(
    story_id: str,
    item_id: str,
    data: models.StoryItemSplit,
    db: Session = Depends(get_db),
):
    """Split a story item at a given time, creating two clips."""
    items = await stories.split_story_item(story_id, item_id, data, db)
    if items is None:
        raise HTTPException(status_code=404, detail="Story item not found or invalid split point")
    return items


@app.post("/stories/{story_id}/items/{item_id}/duplicate", response_model=models.StoryItemDetail)
async def duplicate_story_item(
    story_id: str,
    item_id: str,
    db: Session = Depends(get_db),
):
    """Duplicate a story item, creating a copy with all properties."""
    item = await stories.duplicate_story_item(story_id, item_id, db)
    if item is None:
        raise HTTPException(status_code=404, detail="Story item not found")
    return item


@app.get("/stories/{story_id}/export-audio")
async def export_story_audio(
    story_id: str,
    db: Session = Depends(get_db),
):
    """Export story as single mixed audio file with timecode-based mixing."""
    try:
        # Get story to create filename
        story = db.query(database.Story).filter_by(id=story_id).first()
        if not story:
            raise HTTPException(status_code=404, detail="Story not found")
        
        # Export audio
        audio_bytes = await stories.export_story_audio(story_id, db)
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Story has no audio items")
        
        # Create safe filename
        safe_name = "".join(c for c in story.name if c.isalnum() or c in (' ', '-', '_')).strip()
        if not safe_name:
            safe_name = "story"
        filename = f"{safe_name}.wav"
        
        # Return as streaming response
        return StreamingResponse(
            io.BytesIO(audio_bytes),
            media_type="audio/wav",
            headers={
                "Content-Disposition": _safe_content_disposition("attachment", filename)
            }
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/stories/{story_id}/render-vibetube", response_model=models.VibeTubeRenderResponse)
async def render_story_vibetube(
    story_id: str,
    data: models.StoryVibeTubeRenderRequest,
    db: Session = Depends(get_db),
):
    """Render a full story into one multi-avatar VibeTube video."""
    try:
        return await _render_story_vibetube_internal(story_id, data, db)
    except HTTPException:
        raise
    except vibetube.VibeTubeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Story VibeTube render failed: {str(e)}")


# ============================================
# FILE SERVING
# ============================================

@app.get("/audio/{generation_id}")
async def get_audio(generation_id: str, db: Session = Depends(get_db)):
    """Serve generated audio file."""
    generation = await history.get_generation(generation_id, db)
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    
    audio_path = Path(generation.audio_path)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    
    return FileResponse(
        audio_path,
        media_type="audio/wav",
        filename=f"generation_{generation_id}.wav",
    )


@app.get("/samples/{sample_id}")
async def get_sample_audio(sample_id: str, db: Session = Depends(get_db)):
    """Serve profile sample audio file."""
    from .database import ProfileSample as DBProfileSample
    
    sample = db.query(DBProfileSample).filter_by(id=sample_id).first()
    if not sample:
        raise HTTPException(status_code=404, detail="Sample not found")
    
    audio_path = Path(sample.audio_path)
    if not audio_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    
    return FileResponse(
        audio_path,
        media_type="audio/wav",
        filename=f"sample_{sample_id}.wav",
    )


# ============================================
# MODEL MANAGEMENT
# ============================================

@app.post("/models/load")
async def load_model(model_size: str = "1.7B"):
    """Manually load TTS model."""
    try:
        tts_model = tts.get_tts_model()
        await tts_model.load_model_async(model_size)
        return {"message": f"Model {model_size} loaded successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/models/unload")
async def unload_model():
    """Unload TTS model to free memory."""
    try:
        tts.unload_tts_model()
        return {"message": "Model unloaded successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/models/progress/{model_name}")
async def get_model_progress(model_name: str):
    """Get model download progress via Server-Sent Events."""
    from fastapi.responses import StreamingResponse
    
    progress_manager = get_progress_manager()
    
    async def event_generator():
        """Generate SSE events for progress updates."""
        async for event in progress_manager.subscribe(model_name):
            yield event
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/models/status", response_model=models.ModelStatusListResponse)
async def get_model_status():
    """Get status of all available models."""
    from huggingface_hub import constants as hf_constants
    from pathlib import Path
    
    backend_type = get_backend_type()
    task_manager = get_task_manager()
    
    # Get set of currently downloading model names
    active_download_names = {task.model_name for task in task_manager.get_active_downloads()}
    
    # Try to import scan_cache_dir (might not be available in older versions)
    try:
        from huggingface_hub import scan_cache_dir
        use_scan_cache = True
    except ImportError:
        use_scan_cache = False
    
    def check_tts_loaded(model_size: str):
        """Check if TTS model is loaded with specific size."""
        try:
            tts_model = tts.get_tts_model()
            return tts_model.is_loaded() and getattr(tts_model, 'model_size', None) == model_size
        except Exception:
            return False
    
    def check_whisper_loaded(model_size: str):
        """Check if Whisper model is loaded with specific size."""
        try:
            whisper_model = transcribe.get_whisper_model()
            return whisper_model.is_loaded() and getattr(whisper_model, 'model_size', None) == model_size
        except Exception:
            return False
    
    # Use backend-specific model IDs
    if backend_type == "mlx":
        tts_1_7b_id = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
        tts_0_6b_id = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"  # Fallback to 1.7B
        # MLX backend uses openai/whisper-* models, not mlx-community
        whisper_base_id = "openai/whisper-base"
        whisper_small_id = "openai/whisper-small"
        whisper_medium_id = "openai/whisper-medium"
        whisper_large_id = "openai/whisper-large"
    else:
        tts_1_7b_id = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
        tts_0_6b_id = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
        whisper_base_id = "openai/whisper-base"
        whisper_small_id = "openai/whisper-small"
        whisper_medium_id = "openai/whisper-medium"
        whisper_large_id = "openai/whisper-large"
    
    model_configs = [
        {
            "model_name": "qwen-tts-1.7B",
            "display_name": "Qwen TTS 1.7B",
            "hf_repo_id": tts_1_7b_id,
            "model_size": "1.7B",
            "check_loaded": lambda: check_tts_loaded("1.7B"),
        },
        {
            "model_name": "qwen-tts-0.6B",
            "display_name": "Qwen TTS 0.6B",
            "hf_repo_id": tts_0_6b_id,
            "model_size": "0.6B",
            "check_loaded": lambda: check_tts_loaded("0.6B"),
        },
        {
            "model_name": "whisper-base",
            "display_name": "Whisper Base",
            "hf_repo_id": whisper_base_id,
            "model_size": "base",
            "check_loaded": lambda: check_whisper_loaded("base"),
        },
        {
            "model_name": "whisper-small",
            "display_name": "Whisper Small",
            "hf_repo_id": whisper_small_id,
            "model_size": "small",
            "check_loaded": lambda: check_whisper_loaded("small"),
        },
        {
            "model_name": "whisper-medium",
            "display_name": "Whisper Medium",
            "hf_repo_id": whisper_medium_id,
            "model_size": "medium",
            "check_loaded": lambda: check_whisper_loaded("medium"),
        },
        {
            "model_name": "whisper-large",
            "display_name": "Whisper Large",
            "hf_repo_id": whisper_large_id,
            "model_size": "large",
            "check_loaded": lambda: check_whisper_loaded("large"),
        },
    ]
    
    # Build a mapping of model_name -> hf_repo_id so we can check if shared repos are downloading
    model_to_repo = {cfg["model_name"]: cfg["hf_repo_id"] for cfg in model_configs}
    
    # Get the set of hf_repo_ids that are currently being downloaded
    # This handles the case where multiple models share the same repo (e.g., 0.6B and 1.7B on MLX)
    active_download_repos = {model_to_repo.get(name) for name in active_download_names if name in model_to_repo}
    
    # Get HuggingFace cache info (if available)
    cache_info = None
    if use_scan_cache:
        try:
            cache_info = scan_cache_dir()
        except Exception:
            # Function failed, continue without it
            pass
    
    statuses = []
    
    for config in model_configs:
        try:
            downloaded = False
            size_mb = None
            loaded = False
            
            # Method 1: Try using scan_cache_dir if available
            if cache_info:
                repo_id = config["hf_repo_id"]
                for repo in cache_info.repos:
                    if repo.repo_id == repo_id:
                        # Check if actual model weight files exist (not just config files)
                        # scan_cache_dir only shows completed files, so check if any are model weights
                        has_model_weights = False
                        for rev in repo.revisions:
                            for f in rev.files:
                                fname = f.file_name.lower()
                                if fname.endswith(('.safetensors', '.bin', '.pt', '.pth', '.npz')):
                                    has_model_weights = True
                                    break
                            if has_model_weights:
                                break
                        
                        # Also check for .incomplete files in blobs directory (downloads in progress)
                        has_incomplete = False
                        try:
                            cache_dir = hf_constants.HF_HUB_CACHE
                            blobs_dir = Path(cache_dir) / ("models--" + repo_id.replace("/", "--")) / "blobs"
                            if blobs_dir.exists():
                                has_incomplete = any(blobs_dir.glob("*.incomplete"))
                        except Exception:
                            pass
                        
                        # Only mark as downloaded if we have model weights AND no incomplete files
                        if has_model_weights and not has_incomplete:
                            downloaded = True
                            # Calculate size from cache info
                            try:
                                total_size = sum(revision.size_on_disk for revision in repo.revisions)
                                size_mb = total_size / (1024 * 1024)
                            except Exception:
                                pass
                        break
            
            # Method 2: Fallback to checking cache directory directly (using HuggingFace's OS-specific cache location)
            if not downloaded:
                try:
                    cache_dir = hf_constants.HF_HUB_CACHE
                    repo_cache = Path(cache_dir) / ("models--" + config["hf_repo_id"].replace("/", "--"))
                    
                    if repo_cache.exists():
                        # Check for .incomplete files - if any exist, download is still in progress
                        blobs_dir = repo_cache / "blobs"
                        has_incomplete = blobs_dir.exists() and any(blobs_dir.glob("*.incomplete"))
                        
                        if not has_incomplete:
                            # Check for actual model weight files (not just index files)
                            # in the snapshots directory (symlinks to completed blobs)
                            snapshots_dir = repo_cache / "snapshots"
                            has_model_files = False
                            if snapshots_dir.exists():
                                has_model_files = (
                                    any(snapshots_dir.rglob("*.bin")) or
                                    any(snapshots_dir.rglob("*.safetensors")) or
                                    any(snapshots_dir.rglob("*.pt")) or
                                    any(snapshots_dir.rglob("*.pth")) or
                                    any(snapshots_dir.rglob("*.npz"))
                                )
                            
                            if has_model_files:
                                downloaded = True
                                # Calculate size (exclude .incomplete files)
                                try:
                                    total_size = sum(
                                        f.stat().st_size for f in repo_cache.rglob("*") 
                                        if f.is_file() and not f.name.endswith('.incomplete')
                                    )
                                    size_mb = total_size / (1024 * 1024)
                                except Exception:
                                    pass
                except Exception:
                    pass
            
            # Method 3 removed - checking for config.json is too lenient
            # Methods 1 and 2 properly verify that model weight files exist
            
            # Check if loaded in memory
            try:
                loaded = config["check_loaded"]()
            except Exception:
                loaded = False
            
            # Check if this model (or its shared repo) is currently being downloaded
            is_downloading = config["hf_repo_id"] in active_download_repos
            
            # If downloading, don't report as downloaded (partial files exist)
            if is_downloading:
                downloaded = False
                size_mb = None  # Don't show partial size during download
            
            statuses.append(models.ModelStatus(
                model_name=config["model_name"],
                display_name=config["display_name"],
                downloaded=downloaded,
                downloading=is_downloading,
                size_mb=size_mb,
                loaded=loaded,
            ))
        except Exception as e:
            # If check fails, try to at least check if loaded
            try:
                loaded = config["check_loaded"]()
            except Exception:
                loaded = False
            
            # Check if this model (or its shared repo) is currently being downloaded
            is_downloading = config["hf_repo_id"] in active_download_repos
            
            statuses.append(models.ModelStatus(
                model_name=config["model_name"],
                display_name=config["display_name"],
                downloaded=False,  # Assume not downloaded if check failed
                downloading=is_downloading,
                size_mb=None,
                loaded=loaded,
            ))
    
    return models.ModelStatusListResponse(models=statuses)


@app.post("/models/download")
async def trigger_model_download(request: models.ModelDownloadRequest):
    """Trigger download of a specific model."""
    import asyncio
    
    task_manager = get_task_manager()
    progress_manager = get_progress_manager()
    
    model_configs = {
        "qwen-tts-1.7B": {
            "model_size": "1.7B",
            "load_func": lambda: tts.get_tts_model().load_model("1.7B"),
        },
        "qwen-tts-0.6B": {
            "model_size": "0.6B",
            "load_func": lambda: tts.get_tts_model().load_model("0.6B"),
        },
        "whisper-base": {
            "model_size": "base",
            "load_func": lambda: transcribe.get_whisper_model().load_model("base"),
        },
        "whisper-small": {
            "model_size": "small",
            "load_func": lambda: transcribe.get_whisper_model().load_model("small"),
        },
        "whisper-medium": {
            "model_size": "medium",
            "load_func": lambda: transcribe.get_whisper_model().load_model("medium"),
        },
        "whisper-large": {
            "model_size": "large",
            "load_func": lambda: transcribe.get_whisper_model().load_model("large"),
        },
    }
    
    if request.model_name not in model_configs:
        raise HTTPException(status_code=400, detail=f"Unknown model: {request.model_name}")
    
    config = model_configs[request.model_name]
    
    async def download_in_background():
        """Download model in background without blocking the HTTP request."""
        try:
            # Call the load function (which may be async)
            result = config["load_func"]()
            # If it's a coroutine, await it
            if asyncio.iscoroutine(result):
                await result
            task_manager.complete_download(request.model_name)
        except Exception as e:
            task_manager.error_download(request.model_name, str(e))

    # Start tracking download
    task_manager.start_download(request.model_name)
    
    # Initialize progress state so SSE endpoint has initial data to send.
    # This fixes a race condition where the frontend connects to SSE before
    # any progress callbacks have fired (especially for large models like Qwen
    # where huggingface_hub takes time to fetch metadata for all files).
    progress_manager.update_progress(
        model_name=request.model_name,
        current=0,
        total=0,  # Will be updated once actual total is known
        filename="Connecting to HuggingFace...",
        status="downloading",
    )

    # Start download in background task (don't await)
    asyncio.create_task(download_in_background())

    # Return immediately - frontend should poll progress endpoint
    return {"message": f"Model {request.model_name} download started"}


@app.get("/image-models/stylizedpixel/status", response_model=models.ImageModelStatusResponse)
async def get_stylizedpixel_image_model_status():
    """Return download status for the optional StylizedPixel avatar test model."""
    return _build_image_model_status()


@app.post("/image-models/stylizedpixel/download")
async def download_stylizedpixel_image_model():
    """Download the optional StylizedPixel avatar test model in the background."""
    task_manager = get_task_manager()
    current_status = _build_image_model_status()

    if current_status.downloaded:
        return {"message": f"{_STYLIZED_PIXEL_DISPLAY_NAME} is already downloaded"}

    if task_manager.is_download_active(_STYLIZED_PIXEL_MODEL_NAME):
        return {"message": f"{_STYLIZED_PIXEL_DISPLAY_NAME} download already in progress"}

    async def download_in_background():
        try:
            await asyncio.to_thread(_download_stylized_pixel_model)
            task_manager.complete_download(_STYLIZED_PIXEL_MODEL_NAME)
        except Exception as e:
            task_manager.error_download(_STYLIZED_PIXEL_MODEL_NAME, str(e))

    task_manager.start_download(_STYLIZED_PIXEL_MODEL_NAME)
    asyncio.create_task(download_in_background())
    return {"message": f"{_STYLIZED_PIXEL_DISPLAY_NAME} download started"}


@app.delete("/models/{model_name}")
async def delete_model(model_name: str):
    """Delete a downloaded model from the HuggingFace cache."""
    import shutil
    import os
    from huggingface_hub import constants as hf_constants
    
    # Map model names to HuggingFace repo IDs
    model_configs = {
        "qwen-tts-1.7B": {
            "hf_repo_id": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
            "model_size": "1.7B",
            "model_type": "tts",
        },
        "qwen-tts-0.6B": {
            "hf_repo_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            "model_size": "0.6B",
            "model_type": "tts",
        },
        "whisper-base": {
            "hf_repo_id": "openai/whisper-base",
            "model_size": "base",
            "model_type": "whisper",
        },
        "whisper-small": {
            "hf_repo_id": "openai/whisper-small",
            "model_size": "small",
            "model_type": "whisper",
        },
        "whisper-medium": {
            "hf_repo_id": "openai/whisper-medium",
            "model_size": "medium",
            "model_type": "whisper",
        },
        "whisper-large": {
            "hf_repo_id": "openai/whisper-large",
            "model_size": "large",
            "model_type": "whisper",
        },
    }
    
    if model_name not in model_configs:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_name}")
    
    config = model_configs[model_name]
    hf_repo_id = config["hf_repo_id"]
    
    try:
        # Check if model is loaded and unload it first
        if config["model_type"] == "tts":
            tts_model = tts.get_tts_model()
            if tts_model.is_loaded() and tts_model.model_size == config["model_size"]:
                tts.unload_tts_model()
        elif config["model_type"] == "whisper":
            whisper_model = transcribe.get_whisper_model()
            if whisper_model.is_loaded() and whisper_model.model_size == config["model_size"]:
                transcribe.unload_whisper_model()
        
        # Find and delete the cache directory (using HuggingFace's OS-specific cache location)
        cache_dir = hf_constants.HF_HUB_CACHE
        repo_cache_dir = Path(cache_dir) / ("models--" + hf_repo_id.replace("/", "--"))
        
        # Check if the cache directory exists
        if not repo_cache_dir.exists():
            raise HTTPException(status_code=404, detail=f"Model {model_name} not found in cache")
        
        # Delete the entire cache directory for this model
        try:
            shutil.rmtree(repo_cache_dir)
        except OSError as e:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to delete model cache directory: {str(e)}"
            )
        
        return {"message": f"Model {model_name} deleted successfully"}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete model: {str(e)}")


@app.post("/cache/clear")
async def clear_cache():
    """Clear all voice prompt caches (memory and disk)."""
    try:
        deleted_count = clear_voice_prompt_cache()
        return {
            "message": f"Voice prompt cache cleared successfully",
            "files_deleted": deleted_count,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clear cache: {str(e)}")


# ============================================
# TASK MANAGEMENT
# ============================================

@app.get("/tasks/active", response_model=models.ActiveTasksResponse)
async def get_active_tasks():
    """Return all currently active downloads and generations."""
    task_manager = get_task_manager()
    progress_manager = get_progress_manager()
    
    # Get active downloads from both task manager and progress manager
    # Task manager tracks which downloads are active
    # Progress manager has the actual progress data
    active_downloads = []
    task_manager_downloads = task_manager.get_active_downloads()
    progress_active = progress_manager.get_all_active()
    
    # Combine data from both sources
    download_map = {task.model_name: task for task in task_manager_downloads}
    progress_map = {p["model_name"]: p for p in progress_active}
    
    # Create unified list
    all_model_names = set(download_map.keys()) | set(progress_map.keys())
    for model_name in all_model_names:
        task = download_map.get(model_name)
        progress = progress_map.get(model_name)
        
        if task:
            active_downloads.append(models.ActiveDownloadTask(
                model_name=model_name,
                status=task.status,
                started_at=task.started_at,
            ))
        elif progress:
            # Progress exists but no task - create from progress data
            timestamp_str = progress.get("timestamp")
            if timestamp_str:
                try:
                    started_at = datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))
                except (ValueError, AttributeError):
                    started_at = datetime.utcnow()
            else:
                started_at = datetime.utcnow()
            
            active_downloads.append(models.ActiveDownloadTask(
                model_name=model_name,
                status=progress.get("status", "downloading"),
                started_at=started_at,
            ))
    
    # Get active generations
    active_generations = []
    for gen_task in task_manager.get_active_generations():
        active_generations.append(models.ActiveGenerationTask(
            task_id=gen_task.task_id,
            profile_id=gen_task.profile_id,
            text_preview=gen_task.text_preview,
            started_at=gen_task.started_at,
        ))
    
    return models.ActiveTasksResponse(
        downloads=active_downloads,
        generations=active_generations,
    )


# ============================================
# STARTUP & SHUTDOWN
# ============================================

def _get_gpu_status() -> str:
    """Get GPU availability status."""
    backend_type = get_backend_type()
    if torch.cuda.is_available():
        return f"CUDA ({torch.cuda.get_device_name(0)})"
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        return "MPS (Apple Silicon)"
    elif backend_type == "mlx":
        return "Metal (Apple Silicon via MLX)"
    return "None (CPU only)"


@app.on_event("startup")
async def startup_event():
    """Run on application startup."""
    print("VibeTube API starting up...")
    database.init_db()
    print(f"Database initialized at {database._db_path}")
    backend_type = get_backend_type()
    print(f"Backend: {backend_type.upper()}")
    print(f"GPU available: {_get_gpu_status()}")

    # Initialize progress manager with main event loop for thread-safe operations
    try:
        progress_manager = get_progress_manager()
        progress_manager._set_main_loop(asyncio.get_running_loop())
        print("Progress manager initialized with event loop")
    except Exception as e:
        print(f"Warning: Could not initialize progress manager event loop: {e}")

    # Ensure HuggingFace cache directory exists
    try:
        from huggingface_hub import constants as hf_constants
        cache_dir = Path(hf_constants.HF_HUB_CACHE)
        cache_dir.mkdir(parents=True, exist_ok=True)
        print(f"HuggingFace cache directory: {cache_dir}")
    except Exception as e:
        print(f"Warning: Could not create HuggingFace cache directory: {e}")
        print("Model downloads may fail. Please ensure the directory exists and has write permissions.")


@app.on_event("shutdown")
async def shutdown_event():
    """Run on application shutdown."""
    print("VibeTube API shutting down...")
    # Unload models to free memory
    tts.unload_tts_model()
    transcribe.unload_whisper_model()


# ============================================
# MAIN
# ============================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="VibeTube backend server")
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host to bind to (use 0.0.0.0 for remote access)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to bind to",
    )
    parser.add_argument(
        "--data-dir",
        type=str,
        default=None,
        help="Data directory for database, profiles, and generated audio",
    )
    args = parser.parse_args()

    # Set data directory if provided
    if args.data_dir:
        config.set_data_dir(args.data_dir)

    # Initialize database after data directory is set
    database.init_db()

    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        reload=False,  # Disable reload in production
    )
