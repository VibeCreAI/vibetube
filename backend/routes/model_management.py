"""Model management and cache routes."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from .. import models
from ..backends import (
    check_model_loaded,
    get_all_model_configs,
    get_model_config,
    unload_model_by_config,
)
from ..services.errors import extract_error_message
from ..services.model_management import (
    STYLIZED_PIXEL_DISPLAY_NAME,
    STYLIZED_PIXEL_MODEL_NAME,
    build_image_model_status,
    download_stylized_pixel_model,
    is_model_downloaded,
    resolve_model_config,
    run_model_load,
)
from ..utils.cache import clear_voice_prompt_cache
from ..utils.progress import get_progress_manager
from ..utils.tasks import get_task_manager

router = APIRouter()


@router.post("/models/load")
async def load_model(
    model_name: Optional[str] = Query(None),
    model_size: str = Query("1.7B"),
    engine: str = Query("qwen"),
):
    """Manually load TTS/STT model."""
    try:
        model_config = resolve_model_config(
            model_name=model_name,
            model_size=model_size,
            engine=engine,
        )
        await run_model_load(model_config)
        return {"message": f"{model_config.display_name} loaded successfully"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=extract_error_message(exc))


@router.post("/models/unload")
async def unload_model(
    model_name: Optional[str] = Query(None),
    model_size: str = Query("1.7B"),
    engine: str = Query("qwen"),
):
    """Unload TTS/STT model to free memory."""
    try:
        model_config = resolve_model_config(
            model_name=model_name,
            model_size=model_size,
            engine=engine,
        )
        unloaded = unload_model_by_config(model_config)
        if not unloaded:
            return {"message": f"{model_config.display_name} was not loaded"}
        return {"message": f"{model_config.display_name} unloaded successfully"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=extract_error_message(exc))


@router.get("/models/progress/{model_name}")
async def get_model_progress(model_name: str):
    """Get model download progress via Server-Sent Events."""
    progress_manager = get_progress_manager()

    async def event_generator():
        try:
            async for event in progress_manager.subscribe(model_name):
                yield event
        except asyncio.CancelledError:
            return

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/models/status", response_model=models.ModelStatusListResponse)
async def get_model_status():
    """Get status of all available models."""
    task_manager = get_task_manager()
    active_download_names = {task.model_name for task in task_manager.get_active_downloads()}
    model_configs = get_all_model_configs()
    repo_by_model_name = {cfg.model_name: cfg.hf_repo_id for cfg in model_configs}
    active_download_repos = {
        repo_by_model_name[name]
        for name in active_download_names
        if name in repo_by_model_name
    }

    statuses = []
    for model_config in model_configs:
        downloaded, size_mb = is_model_downloaded(model_config)
        downloading = (
            model_config.model_name in active_download_names
            or model_config.hf_repo_id in active_download_repos
        )
        if downloading:
            downloaded = False
            size_mb = None

        statuses.append(
            models.ModelStatus(
                model_name=model_config.model_name,
                display_name=model_config.display_name,
                engine=model_config.engine,
                model_size=model_config.model_size,
                downloaded=downloaded,
                downloading=downloading,
                size_mb=size_mb,
                loaded=check_model_loaded(model_config),
            )
        )

    return models.ModelStatusListResponse(models=statuses)


@router.post("/models/download")
async def trigger_model_download(request: models.ModelDownloadRequest):
    """Trigger download of a specific model."""
    task_manager = get_task_manager()
    progress_manager = get_progress_manager()
    model_config = get_model_config(request.model_name)
    if not model_config:
        raise HTTPException(status_code=400, detail=f"Unknown model: {request.model_name}")

    downloaded, _ = is_model_downloaded(model_config)
    if downloaded:
        return {"message": f"{model_config.display_name} is already downloaded"}

    if task_manager.is_download_active(model_config.model_name):
        return {"message": f"{model_config.display_name} download already in progress"}

    async def download_in_background():
        """Download model in background without blocking the HTTP request."""
        try:
            await run_model_load(model_config)
            progress_manager.mark_complete(model_config.model_name)
            task_manager.complete_download(model_config.model_name)
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

    asyncio.create_task(download_in_background())
    return {"message": f"{model_config.display_name} download started"}


@router.get(
    "/image-models/stylizedpixel/status",
    response_model=models.ImageModelStatusResponse,
)
async def get_stylizedpixel_image_model_status():
    """Return download status for the optional StylizedPixel avatar test model."""
    return build_image_model_status()


@router.post("/image-models/stylizedpixel/download")
async def download_stylizedpixel_image_model():
    """Download the optional StylizedPixel avatar test model in the background."""
    task_manager = get_task_manager()
    current_status = build_image_model_status()

    if current_status.downloaded:
        return {"message": f"{STYLIZED_PIXEL_DISPLAY_NAME} is already downloaded"}

    if task_manager.is_download_active(STYLIZED_PIXEL_MODEL_NAME):
        return {"message": f"{STYLIZED_PIXEL_DISPLAY_NAME} download already in progress"}

    async def download_in_background():
        try:
            await asyncio.to_thread(download_stylized_pixel_model)
            task_manager.complete_download(STYLIZED_PIXEL_MODEL_NAME)
        except Exception as exc:
            task_manager.error_download(STYLIZED_PIXEL_MODEL_NAME, str(exc))

    task_manager.start_download(STYLIZED_PIXEL_MODEL_NAME)
    asyncio.create_task(download_in_background())
    return {"message": f"{STYLIZED_PIXEL_DISPLAY_NAME} download started"}


@router.delete("/models/{model_name}")
async def delete_model(model_name: str):
    """Delete a downloaded model from the HuggingFace cache."""
    from huggingface_hub import constants as hf_constants

    model_config = get_model_config(model_name)
    if not model_config:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_name}")

    try:
        unload_model_by_config(model_config)

        cache_dir = hf_constants.HF_HUB_CACHE
        repo_cache_dir = Path(cache_dir) / ("models--" + model_config.hf_repo_id.replace("/", "--"))

        if not repo_cache_dir.exists():
            raise HTTPException(status_code=404, detail=f"Model {model_name} not found in cache")

        try:
            shutil.rmtree(repo_cache_dir)
        except OSError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to delete model cache directory: {str(exc)}",
            )

        return {"message": f"{model_config.display_name} deleted successfully"}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete model: {extract_error_message(exc)}",
        )


@router.post("/cache/clear")
async def clear_cache():
    """Clear all voice prompt caches (memory and disk)."""
    try:
        deleted_count = clear_voice_prompt_cache()
        return {
            "message": "Voice prompt cache cleared successfully",
            "files_deleted": deleted_count,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to clear cache: {str(exc)}")
