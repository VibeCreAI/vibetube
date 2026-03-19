"""Shared helpers for model lookup, loading, and local model assets."""

from __future__ import annotations

import asyncio
import re
import shutil
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from .. import config, models
from ..backends import get_engine_config, get_model_config, get_model_load_func
from ..utils.tasks import get_task_manager

STYLIZED_PIXEL_MODEL_NAME = "stylizedpixel-m80"
STYLIZED_PIXEL_DISPLAY_NAME = "StylizedPixel M80"
LUXTTS_WHISPER_DEP_REPO = "openai/whisper-tiny"
STYLIZED_PIXEL_DOWNLOAD_URL = (
    "https://civitai.com/api/download/models/153325"
    "?type=Model&format=SafeTensor&size=full&fp=fp16"
)


def get_model_cache_dir(hf_repo_id: str) -> Optional[Path]:
    try:
        from huggingface_hub import constants as hf_constants

        return Path(hf_constants.HF_HUB_CACHE) / ("models--" + hf_repo_id.replace("/", "--"))
    except Exception:
        return None


def _inspect_repo_download(hf_repo_id: str) -> tuple[bool, Optional[float]]:
    cache_dir = get_model_cache_dir(hf_repo_id)
    if not cache_dir or not cache_dir.exists():
        return False, None

    blobs_dir = cache_dir / "blobs"
    if blobs_dir.exists() and any(blobs_dir.glob("*.incomplete")):
        return False, None

    snapshots_dir = cache_dir / "snapshots"
    if not snapshots_dir.exists():
        return False, None

    has_weights = any(
        any(snapshots_dir.rglob(ext))
        for ext in ("*.safetensors", "*.bin", "*.pt", "*.pth", "*.npz", "*.onnx")
    )
    if not has_weights:
        return False, None

    size_mb = None
    try:
        size_bytes = sum(
            f.stat().st_size
            for f in cache_dir.rglob("*")
            if f.is_file() and not f.name.endswith(".incomplete")
        )
        size_mb = size_bytes / (1024 * 1024)
    except Exception:
        pass
    return True, size_mb


def is_model_downloaded(model_config) -> tuple[bool, Optional[float]]:
    downloaded, size_mb = _inspect_repo_download(model_config.hf_repo_id)
    if not downloaded:
        return False, None

    # LuxTTS requires Whisper Tiny for prompt transcription in ZipVoice.
    if model_config.engine == "luxtts":
        dep_downloaded, dep_size_mb = _inspect_repo_download(LUXTTS_WHISPER_DEP_REPO)
        if not dep_downloaded:
            return False, None
        if size_mb is not None and dep_size_mb is not None:
            size_mb += dep_size_mb

    return downloaded, size_mb


def get_generation_model_config(engine: str, model_size: str):
    config = get_engine_config(engine, model_size)
    if config:
        return config
    raise HTTPException(
        status_code=400,
        detail=f"Unsupported engine/model combination: {engine}/{model_size}",
    )


def resolve_model_config(
    *,
    model_name: Optional[str] = None,
    model_size: str = "1.7B",
    engine: str = "qwen",
):
    model_config = get_model_config(model_name) if model_name else None
    if model_config is None:
        if engine == "whisper":
            model_config = get_model_config(f"whisper-{model_size}")
        else:
            resolved_size = model_size if engine == "qwen" else "default"
            model_config = get_engine_config(engine, resolved_size)

    if model_config is None:
        target = model_name or f"{engine}/{model_size}"
        raise HTTPException(status_code=400, detail=f"Unknown model: {target}")
    return model_config


def model_download_message(model_config) -> str:
    if model_config.engine == "qwen":
        return f"Model {model_config.model_size} is being downloaded. Please wait and try again."
    if model_config.engine == "luxtts":
        return (
            "LuxTTS (including Whisper Tiny dependency) is being downloaded. "
            "Please wait and try again."
        )
    return f"{model_config.display_name} is being downloaded. Please wait and try again."


def _is_hf_auth_error(raw_message: str) -> bool:
    msg = raw_message.lower()
    return (
        "huggingface" in msg
        and (
            "401" in msg
            or "403" in msg
            or "unauthorized" in msg
            or "gated" in msg
            or "forbidden" in msg
            or "access to model" in msg
        )
    )


def _is_hf_offline_error(raw_message: str) -> bool:
    msg = raw_message.lower()
    return (
        "offline mode is enabled" in msg
        or "hf_hub_offline" in msg
        or "transformers_offline" in msg
    )


def normalize_model_load_error(model_config, exc: Exception) -> str:
    """Convert upstream model-loader errors into readable, actionable text."""
    raw_message = str(exc).strip() or exc.__class__.__name__

    if _is_hf_auth_error(raw_message):
        return (
            f"Cannot download {model_config.display_name} ({model_config.hf_repo_id}): "
            "Hugging Face returned 401 Unauthorized (gated/private model). "
            "Set HF_TOKEN with access to this model, restart VibeTube, and retry."
        )

    if _is_hf_offline_error(raw_message):
        return (
            f"Cannot reach Hugging Face to download {model_config.display_name}. "
            "Offline mode is enabled. Unset HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE, "
            "restart VibeTube, and retry."
        )

    return re.sub(r"\s+", " ", raw_message).strip()


async def run_model_load(model_config) -> None:
    try:
        result = get_model_load_func(model_config)()
        if asyncio.iscoroutine(result):
            await result
    except Exception as exc:
        raise RuntimeError(normalize_model_load_error(model_config, exc)) from exc


def stylized_pixel_model_path() -> Path:
    checkpoints_dir = config.get_models_dir() / "checkpoints"
    checkpoints_dir.mkdir(parents=True, exist_ok=True)
    return checkpoints_dir / "stylizedpixel_m80.safetensors"


def build_image_model_status() -> models.ImageModelStatusResponse:
    model_path = stylized_pixel_model_path()
    task_manager = get_task_manager()
    downloaded = model_path.exists() and model_path.is_file()
    return models.ImageModelStatusResponse(
        model_name=STYLIZED_PIXEL_MODEL_NAME,
        display_name=STYLIZED_PIXEL_DISPLAY_NAME,
        downloaded=downloaded,
        downloading=task_manager.is_download_active(STYLIZED_PIXEL_MODEL_NAME),
        download_url=STYLIZED_PIXEL_DOWNLOAD_URL,
        file_path=str(model_path) if downloaded else None,
        size_bytes=model_path.stat().st_size if downloaded else None,
    )


def download_stylized_pixel_model() -> None:
    target_path = stylized_pixel_model_path()
    temp_path = target_path.with_suffix(f"{target_path.suffix}.part")
    temp_path.parent.mkdir(parents=True, exist_ok=True)
    if temp_path.exists():
        temp_path.unlink()

    try:
        with urllib.request.urlopen(STYLIZED_PIXEL_DOWNLOAD_URL) as response:
            with temp_path.open("wb") as destination:
                shutil.copyfileobj(response, destination)
        temp_path.replace(target_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()
