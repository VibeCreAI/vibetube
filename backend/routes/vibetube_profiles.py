"""Profile-scoped VibeTube avatar pack/preview routes."""

from __future__ import annotations

from datetime import datetime
import os
from pathlib import Path
import random
import shutil
import tempfile
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ExifTags
from sqlalchemy.orm import Session

from .. import config, models
from ..database import VoiceProfile as DBVoiceProfile
from ..database import get_db
from ..utils import avatar_local
from ..services import profiles

router = APIRouter()

_VIBETUBE_AVATAR_STATES = {"idle", "talk", "idle_blink", "talk_blink"}
_DEFAULT_AVATAR_MODEL_ID = os.environ.get(
    "VIBETUBE_AVATAR_MODEL_ID",
    "runwayml/stable-diffusion-v1-5",
)
_DEFAULT_AVATAR_LORA_ID = os.environ.get("VIBETUBE_AVATAR_LORA_ID") or None


def _vibetube_avatar_pack_dir(profile_id: str) -> Path:
    return config.get_profiles_dir() / profile_id / "vibetube_avatar"


def _vibetube_avatar_preview_dir(profile_id: str) -> Path:
    return config.get_profiles_dir() / profile_id / "vibetube_avatar_preview"


def _avatar_style_refs_dir() -> Path:
    return config.get_data_dir() / "avatar_style_refs"


def _bundled_avatar_style_refs_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "assets" / "avatar_style_refs"


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

        img = img.convert("RGBA")
        img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(output_path, format="PNG", optimize=True)


@router.post("/profiles/{profile_id}/vibetube-avatar-pack", response_model=models.VibeTubeAvatarPackResponse)
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


@router.get("/profiles/{profile_id}/vibetube-avatar-pack", response_model=models.VibeTubeAvatarPackResponse)
async def get_vibetube_avatar_pack(
    profile_id: str,
    db: Session = Depends(get_db),
):
    """Get metadata for a saved VibeTube avatar pack."""
    profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    return _build_vibetube_avatar_pack_response(profile_id)


@router.get("/profiles/{profile_id}/vibetube-avatar-pack/{state}")
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


@router.post(
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


@router.post(
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


@router.post(
    "/profiles/{profile_id}/vibetube-avatar-pack/generate-spritesheet-preview",
    response_model=models.VibeTubeAvatarPreviewResponse,
)
async def generate_vibetube_avatar_spritesheet_preview(
    profile_id: str,
    data: models.VibeTubeAvatarGenerateRequest,
    db: Session = Depends(get_db),
):
    """Generate all 4 avatar states from a single sprite sheet generation (one-shot)."""
    profile = db.query(DBVoiceProfile).filter_by(id=profile_id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    preview_dir = _vibetube_avatar_preview_dir(profile_id)
    if preview_dir.exists():
        shutil.rmtree(preview_dir, ignore_errors=True)
    preview_dir.mkdir(parents=True, exist_ok=True)

    max_attempts = 3
    base_seed = data.seed if data.seed is not None else random.randint(1, 2_147_000_000)

    try:
        for attempt in range(max_attempts):
            try:
                attempt_seed = base_seed + (attempt * 9973)
                avatar_local.generate_avatar_spritesheet(
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
                )
                break
            except avatar_local.AvatarGenerationError as exc:
                msg = str(exc).lower()
                if "empty" in msg and attempt < (max_attempts - 1):
                    continue
                raise HTTPException(status_code=400, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Sprite sheet generation failed: {exc}")

    return _build_vibetube_avatar_preview_response(profile_id)


@router.post(
    "/profiles/{profile_id}/vibetube-avatar-pack/generate",
    response_model=models.VibeTubeAvatarPreviewResponse,
)
@router.post(
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


@router.get(
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


@router.get("/profiles/{profile_id}/vibetube-avatar-preview/{state}")
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


@router.post(
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
