"""
Local in-process avatar pack generation using Diffusers.

Generation order:
1. Generate idle from text prompt.
2. Generate talk / idle_blink / talk_blink from idle image via img2img.
"""

from __future__ import annotations

import threading
import random
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Optional

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat


class AvatarGenerationError(RuntimeError):
    """Raised when local avatar generation fails."""


SYSTEM_PROMPT = (
    "pixel art, upper-body portrait, front-facing, centered, transparent background, crisp pixels"
)

DEFAULT_NEGATIVE_PROMPT = (
    "blurry, anti-aliased smooth shading, realistic photo, 3d render, "
    "text, watermark, background scene, low quality"
)

STATE_SUFFIXES = {
    "idle": "neutral face, mouth closed, both eyes clearly open, pupils visible",
    "talk": "same character, open mouth only, keep eyes open",
    "idle_blink": "same character, close eyes only, keep mouth closed",
    "talk_blink": "same character, close eyes only, keep mouth open",
}


@dataclass
class _Pipelines:
    txt2img: object
    img2img: object
    inpaint: Optional[object]
    device: str
    torch: object


_PIPELINE_LOCK = threading.Lock()
_PIPELINE_CACHE: dict[tuple[str, Optional[str], float], _Pipelines] = {}


def _import_runtime():
    try:
        import torch
        from diffusers import AutoPipelineForImage2Image, AutoPipelineForText2Image
        try:
            from diffusers import AutoPipelineForInpainting
        except Exception:
            AutoPipelineForInpainting = None
    except Exception as exc:
        raise AvatarGenerationError(
            "Local avatar generation requires diffusers runtime. "
            "Install: pip install diffusers transformers accelerate safetensors"
        ) from exc
    return torch, AutoPipelineForText2Image, AutoPipelineForImage2Image, AutoPipelineForInpainting


def _resolve_device(torch: object) -> tuple[str, object]:
    if torch.cuda.is_available():
        return "cuda", torch.float16
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps", torch.float16
    return "cpu", torch.float32


def _resolve_single_file_checkpoint(model_id: str) -> Optional[Path]:
    raw = (model_id or "").strip()
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    if not p.exists() or not p.is_file():
        return None
    if p.suffix.lower() not in {".safetensors", ".ckpt", ".pt", ".pth"}:
        return None
    return p


def _create_txt2img_pipeline(
    model_id: str,
    lora_id: Optional[str],
    lora_scale: float,
    torch: object,
    AutoPipelineForText2Image: object,
) -> tuple[object, str]:
    device, dtype = _resolve_device(torch)

    kwargs = {"torch_dtype": dtype}
    txt2img = None
    load_errors: list[str] = []
    single_file_path = _resolve_single_file_checkpoint(model_id)

    if single_file_path is not None:
        try:
            if hasattr(AutoPipelineForText2Image, "from_single_file"):
                txt2img = AutoPipelineForText2Image.from_single_file(
                    str(single_file_path),
                    **kwargs,
                )
            else:
                # Backward-compatible path for older diffusers builds.
                from diffusers import StableDiffusionPipeline

                txt2img = StableDiffusionPipeline.from_single_file(
                    str(single_file_path),
                    **kwargs,
                )
        except Exception as exc:
            load_errors.append(str(exc))
            txt2img = None
            raise AvatarGenerationError(
                f"Failed to load avatar checkpoint file '{single_file_path}'. "
                f"Error: {exc}"
            ) from exc
    else:
        for try_variant in (True, False):
            try:
                if try_variant and device != "cpu":
                    txt2img = AutoPipelineForText2Image.from_pretrained(
                        model_id,
                        variant="fp16",
                        **kwargs,
                    )
                else:
                    txt2img = AutoPipelineForText2Image.from_pretrained(
                        model_id,
                        **kwargs,
                    )
                break
            except Exception as exc:
                load_errors.append(str(exc))
                txt2img = None

    if txt2img is None:
        raise AvatarGenerationError(
            f"Failed to load avatar model '{model_id}'. "
            f"Errors: {' | '.join(load_errors[-2:])}"
        )

    txt2img = txt2img.to(device)
    if device == "cpu":
        try:
            txt2img.enable_attention_slicing()
        except Exception:
            pass

    if lora_id:
        try:
            txt2img.load_lora_weights(lora_id)
            try:
                txt2img.fuse_lora(lora_scale=lora_scale)
            except Exception:
                # Some pipelines don't support fuse_lora; still usable.
                pass
        except Exception as exc:
            raise AvatarGenerationError(
                f"Failed to load/fuse LoRA '{lora_id}': {exc}"
            ) from exc

    # For local avatar generation we disable pipeline NSFW replacement,
    # because flagged outputs are replaced by black images that break preview flow.
    try:
        txt2img.safety_checker = None
    except Exception:
        pass
    try:
        txt2img.requires_safety_checker = False
    except Exception:
        pass

    return txt2img, device


def _get_pipelines(model_id: str, lora_id: Optional[str], lora_scale: float) -> _Pipelines:
    key = (model_id, lora_id, round(float(lora_scale), 4))
    with _PIPELINE_LOCK:
        cached = _PIPELINE_CACHE.get(key)
        if cached is not None:
            return cached

        torch, AutoPipelineForText2Image, AutoPipelineForImage2Image, AutoPipelineForInpainting = _import_runtime()
        txt2img, device = _create_txt2img_pipeline(
            model_id=model_id,
            lora_id=lora_id,
            lora_scale=lora_scale,
            torch=torch,
            AutoPipelineForText2Image=AutoPipelineForText2Image,
        )

        try:
            img2img = AutoPipelineForImage2Image.from_pipe(txt2img)
            img2img = img2img.to(device)
            try:
                img2img.safety_checker = None
            except Exception:
                pass
            try:
                img2img.requires_safety_checker = False
            except Exception:
                pass
        except Exception as exc:
            try:
                from diffusers import StableDiffusionImg2ImgPipeline

                img2img = StableDiffusionImg2ImgPipeline.from_pipe(txt2img)
                img2img = img2img.to(device)
                try:
                    img2img.safety_checker = None
                except Exception:
                    pass
                try:
                    img2img.requires_safety_checker = False
                except Exception:
                    pass
            except Exception as inner_exc:
                raise AvatarGenerationError(
                    f"Failed to create img2img pipeline from model '{model_id}': {inner_exc}"
                ) from exc

        inpaint = None
        if AutoPipelineForInpainting is not None:
            try:
                inpaint = AutoPipelineForInpainting.from_pipe(txt2img)
                inpaint = inpaint.to(device)
                try:
                    inpaint.safety_checker = None
                except Exception:
                    pass
                try:
                    inpaint.requires_safety_checker = False
                except Exception:
                    pass
            except Exception:
                try:
                    from diffusers import StableDiffusionInpaintPipeline

                    inpaint = StableDiffusionInpaintPipeline.from_pipe(txt2img)
                    inpaint = inpaint.to(device)
                    try:
                        inpaint.safety_checker = None
                    except Exception:
                        pass
                    try:
                        inpaint.requires_safety_checker = False
                    except Exception:
                        pass
                except Exception:
                    inpaint = None

        pipelines = _Pipelines(
            txt2img=txt2img,
            img2img=img2img,
            inpaint=inpaint,
            device=device,
            torch=torch,
        )
        _PIPELINE_CACHE[key] = pipelines
        return pipelines


def _make_background_transparent_if_flat(img: Image.Image, tolerance: int = 10) -> Image.Image:
    rgba = img.convert("RGBA")
    alpha = rgba.getchannel("A")
    if alpha.getextrema() != (255, 255):
        return rgba

    pixels = rgba.load()
    width, height = rgba.size
    corners = [
        pixels[0, 0],
        pixels[width - 1, 0],
        pixels[0, height - 1],
        pixels[width - 1, height - 1],
    ]
    bg = max(set(corners), key=corners.count)
    br, bgc, bb, _ = bg

    def is_bg(px: tuple[int, int, int, int]) -> bool:
        r, g, b, _ = px
        return abs(r - br) <= tolerance and abs(g - bgc) <= tolerance and abs(b - bb) <= tolerance

    # Flood-fill from image borders only, so dark interior details are preserved.
    stack: list[tuple[int, int]] = []
    visited = set()
    for x in range(width):
        stack.append((x, 0))
        stack.append((x, height - 1))
    for y in range(height):
        stack.append((0, y))
        stack.append((width - 1, y))

    while stack:
        x, y = stack.pop()
        if x < 0 or x >= width or y < 0 or y >= height:
            continue
        if (x, y) in visited:
            continue
        visited.add((x, y))

        px = pixels[x, y]
        if not is_bg(px):
            continue

        r, g, b, _ = px
        pixels[x, y] = (r, g, b, 0)
        stack.extend(
            [
                (x + 1, y),
                (x - 1, y),
                (x, y + 1),
                (x, y - 1),
            ]
        )
    return rgba


def _postprocess_and_save(
    image: Image.Image,
    out_path: Path,
    generation_size: int,
    pixel_size: int,
    output_size: int,
    palette_colors: int,
    alpha_override: Optional[Image.Image] = None,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img = image.convert("RGBA")
    if img.size != (generation_size, generation_size):
        img = img.resize((generation_size, generation_size), Image.Resampling.NEAREST)

    img = _make_background_transparent_if_flat(img)
    if pixel_size < generation_size:
        img = img.resize((pixel_size, pixel_size), Image.Resampling.NEAREST)

    if alpha_override is not None:
        alpha = alpha_override.convert("L")
        if alpha.size != img.size:
            alpha = alpha.resize(img.size, Image.Resampling.NEAREST)
    else:
        alpha = img.getchannel("A")
    quantized = img.convert("RGB").quantize(
        colors=palette_colors,
        method=Image.Quantize.MEDIANCUT,
    )
    result = quantized.convert("RGBA")
    result.putalpha(alpha)

    # Reject effectively empty outputs so UI doesn't show misleading blank previews.
    alpha_hist = result.getchannel("A").histogram()
    non_transparent = sum(alpha_hist[1:])
    if non_transparent < 50:
        raise AvatarGenerationError("Generated image is empty/fully transparent. Try regenerating.")

    if output_size != pixel_size:
        result = result.resize((output_size, output_size), Image.Resampling.NEAREST)
    result.save(out_path, format="PNG", optimize=True)


def _limit_words(text: str, max_words: int) -> str:
    words = text.strip().split()
    if len(words) <= max_words:
        return " ".join(words)
    return " ".join(words[:max_words])


def _build_prompt(user_prompt: str, state: str) -> str:
    # SD1.x CLIP text encoder effectively caps prompt length; keep prompts compact.
    # Priority: user prompt first, then short style/system hints, then required state.
    user = _limit_words(user_prompt, 24)
    system = _limit_words(SYSTEM_PROMPT, 20)
    state_text = _limit_words(STATE_SUFFIXES[state], 12)
    return f"{user}, {system}, {state_text}"


def _build_negative_prompt(base_negative_prompt: str, state: str) -> str:
    base = _limit_words(base_negative_prompt or DEFAULT_NEGATIVE_PROMPT, 40)
    if state in {"idle", "talk"}:
        extra = "closed eyes, wink, sleeping, eyes shut"
    else:
        extra = "wide open eyes, staring eyes"
    return f"{base}, {extra}"


def _build_rest_state_prompt(state: str) -> str:
    prompts = {
        "talk": "same character, same framing, open mouth, eyes open",
        "idle_blink": "same character, same framing, eyes closed, mouth closed",
        "talk_blink": "same character, same framing, eyes closed, mouth open",
    }
    return prompts[state]


def _region_change_score(
    source_rgba: Image.Image,
    candidate_rgba: Image.Image,
    target_mask: Image.Image,
) -> float:
    src = source_rgba.convert("L")
    cand = candidate_rgba.convert("L")
    diff = ImageChops.difference(src, cand)
    target = target_mask.convert("L")
    inv = target.point(lambda v: 255 - v)
    target_mean = ImageStat.Stat(diff, mask=target).mean[0]
    outside_mean = ImageStat.Stat(diff, mask=inv).mean[0]
    return float(target_mean - (0.5 * outside_mean))


def _eye_open_score(image_rgba: Image.Image) -> float:
    eyes_mask, _ = _build_expression_masks(image_rgba)
    gray = image_rgba.convert("L")
    stats = ImageStat.Stat(gray, mask=eyes_mask)
    return float(stats.stddev[0] if stats.stddev else 0.0)


def _run_pipeline_image(pipe: object, **kwargs) -> Image.Image:
    try:
        result = pipe(**kwargs)
    except TypeError:
        # Some pipelines do not support negative_prompt in specific modes.
        kwargs.pop("negative_prompt", None)
        result = pipe(**kwargs)
    image = result.images[0]
    if not isinstance(image, Image.Image):
        raise AvatarGenerationError("Model pipeline returned invalid image output.")
    return image


def _to_pil_png(img: Image.Image) -> Image.Image:
    """Round-trip through PNG bytes to normalize image mode/data."""
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Image.open(buf).convert("RGBA")


def _load_single_reference_image(
    reference_paths: list[Path],
    render_size: int,
    seed: int,
) -> tuple[Optional[Image.Image], Optional[Image.Image]]:
    """Load one deterministic reference image instead of blending many."""
    valid_paths: list[Path] = []
    for path in reference_paths:
        if path.exists() and path.is_file():
            valid_paths.append(path)
    if not valid_paths:
        return None, None
    idx = seed % len(valid_paths)
    chosen = valid_paths[idx]
    try:
        ref = Image.open(chosen).convert("RGBA")
        if ref.size != (render_size, render_size):
            ref = ref.resize((render_size, render_size), Image.Resampling.NEAREST)
        return ref.convert("RGB"), ref.getchannel("A")
    except Exception:
        return None, None


def _pick_dark_color(img_rgba: Image.Image) -> tuple[int, int, int, int]:
    """Pick a stable dark ink color from non-transparent pixels."""
    rgba = img_rgba.convert("RGBA")
    alpha = rgba.getchannel("A")
    if alpha.getbbox() is None:
        return (30, 30, 30, 255)
    rgb = rgba.convert("RGB")
    stat = ImageStat.Stat(rgb, mask=alpha)
    avg = [int(v) for v in stat.mean]
    # Darken average color to make expression lines visible.
    return (max(0, avg[0] - 90), max(0, avg[1] - 90), max(0, avg[2] - 90), 255)


def _build_face_landmarks(base_rgba: Image.Image) -> dict[str, int]:
    alpha = base_rgba.getchannel("A")
    bbox = alpha.getbbox() or (0, 0, base_rgba.width, base_rgba.height)
    x0, y0, x1, y1 = bbox
    bw = max(1, x1 - x0)
    bh = max(1, y1 - y0)
    cx = x0 + bw // 2
    eye_y = y0 + int(bh * 0.36)
    mouth_y = y0 + int(bh * 0.62)
    eye_dx = max(4, int(bw * 0.15))
    return {
        "cx": cx,
        "eye_y": eye_y,
        "mouth_y": mouth_y,
        "eye_dx": eye_dx,
        "bw": bw,
        "bh": bh,
    }


def _apply_open_mouth_pixel_edit(base_rgba: Image.Image) -> Image.Image:
    img = base_rgba.convert("RGBA")
    lm = _build_face_landmarks(img)
    draw = ImageDraw.Draw(img)
    ink = _pick_dark_color(img)
    mouth_w = max(6, int(lm["bw"] * 0.14))
    mouth_h = max(4, int(lm["bh"] * 0.07))
    box = (
        lm["cx"] - mouth_w // 2,
        lm["mouth_y"] - mouth_h // 2,
        lm["cx"] + mouth_w // 2,
        lm["mouth_y"] + mouth_h // 2,
    )
    draw.ellipse(box, fill=ink)
    return img


def _apply_closed_eyes_pixel_edit(base_rgba: Image.Image) -> Image.Image:
    img = base_rgba.convert("RGBA")
    lm = _build_face_landmarks(img)
    draw = ImageDraw.Draw(img)
    ink = _pick_dark_color(img)
    eye_w = max(5, int(lm["bw"] * 0.1))
    left_x = lm["cx"] - lm["eye_dx"]
    right_x = lm["cx"] + lm["eye_dx"]
    y = lm["eye_y"]
    draw.line((left_x - eye_w // 2, y, left_x + eye_w // 2, y), fill=ink, width=2)
    draw.line((right_x - eye_w // 2, y, right_x + eye_w // 2, y), fill=ink, width=2)
    return img


def _save_pixel_master_state(master_rgba: Image.Image, out_path: Path, output_size: int) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    result = master_rgba.convert("RGBA")
    if result.size != (output_size, output_size):
        result = result.resize((output_size, output_size), Image.Resampling.NEAREST)
    result.save(out_path, format="PNG", optimize=True)


def _build_expression_masks(base_rgba: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Build eye and mouth masks for localized inpainting edits."""
    rgba = base_rgba.convert("RGBA")
    width, height = rgba.size
    alpha_bin = rgba.getchannel("A").point(lambda a: 255 if a > 8 else 0)
    bbox = alpha_bin.getbbox() or (0, 0, width, height)
    x0, y0, x1, y1 = bbox
    bw = max(1, x1 - x0)
    bh = max(1, y1 - y0)
    cx = x0 + bw // 2

    eyes = Image.new("L", (width, height), 0)
    mouth = Image.new("L", (width, height), 0)
    draw_eyes = ImageDraw.Draw(eyes)
    draw_mouth = ImageDraw.Draw(mouth)

    eye_y = y0 + int(bh * 0.34)
    eye_w = max(16, int(bw * 0.16))
    eye_h = max(10, int(bh * 0.06))
    eye_dx = max(20, int(bw * 0.16))

    left_eye = (cx - eye_dx - eye_w // 2, eye_y - eye_h // 2, cx - eye_dx + eye_w // 2, eye_y + eye_h // 2)
    right_eye = (cx + eye_dx - eye_w // 2, eye_y - eye_h // 2, cx + eye_dx + eye_w // 2, eye_y + eye_h // 2)
    draw_eyes.rounded_rectangle(left_eye, radius=max(2, eye_h // 3), fill=255)
    draw_eyes.rounded_rectangle(right_eye, radius=max(2, eye_h // 3), fill=255)

    mouth_y = y0 + int(bh * 0.58)
    mouth_w = max(22, int(bw * 0.2))
    mouth_h = max(12, int(bh * 0.08))
    mouth_box = (cx - mouth_w // 2, mouth_y - mouth_h // 2, cx + mouth_w // 2, mouth_y + mouth_h // 2)
    draw_mouth.rounded_rectangle(mouth_box, radius=max(2, mouth_h // 3), fill=255)

    # Keep edits inside the character silhouette and soften mask edges.
    eyes = ImageChops.multiply(eyes, alpha_bin).filter(ImageFilter.GaussianBlur(radius=1.2))
    mouth = ImageChops.multiply(mouth, alpha_bin).filter(ImageFilter.GaussianBlur(radius=1.2))
    return eyes, mouth


def _run_state_edit(
    pipelines: _Pipelines,
    *,
    prompt: str,
    negative_prompt: str,
    source_image: Image.Image,
    mask_image: Image.Image,
    render_size: int,
    num_inference_steps: int,
    guidance_scale: float,
    generator: object,
    inpaint_strength: float,
    fallback_strength: float,
) -> Image.Image:
    if pipelines.inpaint is not None:
        return _run_pipeline_image(
            pipelines.inpaint,
            prompt=prompt,
            negative_prompt=negative_prompt,
            image=source_image,
            mask_image=mask_image,
            width=render_size,
            height=render_size,
            strength=inpaint_strength,
            num_inference_steps=num_inference_steps,
            guidance_scale=guidance_scale,
            generator=generator,
        )
    return _run_pipeline_image(
        pipelines.img2img,
        prompt=prompt,
        negative_prompt=negative_prompt,
        image=source_image,
        width=render_size,
        height=render_size,
        strength=fallback_strength,
        num_inference_steps=num_inference_steps,
        guidance_scale=guidance_scale,
        generator=generator,
    )


def generate_avatar_pack(
    profile_id: str,
    out_dir: Path,
    user_prompt: str,
    *,
    model_id: str,
    lora_id: Optional[str] = None,
    lora_scale: float = 0.85,
    seed: Optional[int] = None,
    size: int = 512,
    output_size: int = 512,
    palette_colors: int = 64,
    seed_step: int = 1,
    negative_prompt: str = DEFAULT_NEGATIVE_PROMPT,
    num_inference_steps: int = 24,
    guidance_scale: float = 7.0,
    variation_strength: float = 0.2,
    reference_idle_path: Optional[Path] = None,
    reference_idle_paths: Optional[list[Path]] = None,
    reference_strength: float = 0.2,
) -> int:
    if not user_prompt.strip():
        raise AvatarGenerationError("Prompt is required.")
    if size < 64 or size > 1024:
        raise AvatarGenerationError("size must be between 64 and 1024.")
    if output_size < 64 or output_size > 2048:
        raise AvatarGenerationError("output_size must be between 64 and 2048.")
    if palette_colors < 2 or palette_colors > 256:
        raise AvatarGenerationError("palette_colors must be between 2 and 256.")
    if variation_strength < 0.0 or variation_strength > 1.0:
        raise AvatarGenerationError("variation_strength must be between 0.0 and 1.0.")
    if reference_strength < 0.0 or reference_strength > 1.0:
        raise AvatarGenerationError("reference_strength must be between 0.0 and 1.0.")

    try:
        pipelines = _get_pipelines(model_id=model_id, lora_id=lora_id, lora_scale=lora_scale)
        torch = pipelines.torch
        device = pipelines.device
        base_seed = seed if seed is not None else random.randint(1, 2_147_483_000)
        pixel_size = size
        # Keep native generation at requested size (default 512x512) to avoid
        # quality loss from downscale+upscale passes.
        render_size = size

        out_dir.mkdir(parents=True, exist_ok=True)
        idle_path = out_dir / "idle.png"
        ref_alpha: Optional[Image.Image] = None
        reference_paths: list[Path] = []
        if reference_idle_paths:
            reference_paths.extend(reference_idle_paths)
        if reference_idle_path is not None:
            reference_paths.append(reference_idle_path)
        # De-duplicate while preserving order.
        reference_paths = list(dict.fromkeys(reference_paths))
        ref_rgb, ref_alpha = _load_single_reference_image(
            reference_paths=reference_paths,
            render_size=render_size,
            seed=base_seed,
        )

        idle_gen = torch.Generator(device=device).manual_seed(base_seed)
        if ref_rgb is not None:
            idle_img = _run_pipeline_image(
                pipelines.img2img,
                prompt=_build_prompt(user_prompt, "idle"),
                negative_prompt=_build_negative_prompt(negative_prompt, "idle"),
                image=ref_rgb,
                width=render_size,
                height=render_size,
                strength=reference_strength,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                generator=idle_gen,
            )
        else:
            idle_img = _run_pipeline_image(
                pipelines.txt2img,
                prompt=_build_prompt(user_prompt, "idle"),
                negative_prompt=_build_negative_prompt(negative_prompt, "idle"),
                width=render_size,
                height=render_size,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                generator=idle_gen,
            )
        idle_img = _to_pil_png(idle_img)
        _postprocess_and_save(
            idle_img,
            idle_path,
            generation_size=render_size,
            pixel_size=pixel_size,
            output_size=output_size,
            palette_colors=palette_colors,
            alpha_override=ref_alpha,
        )
        idle_base = idle_img.convert("RGB")
        if idle_base.size != (render_size, render_size):
            idle_base = idle_base.resize((render_size, render_size), Image.Resampling.NEAREST)
        idle_saved_rgba = Image.open(idle_path).convert("RGBA")
        # Hybrid deterministic state edits:
        # - Keep AI generation for idle
        # - Convert to 128 master sprite
        # - Derive talk/blink states with direct pixel edits for consistency
        master_size = 128
        idle_master = idle_saved_rgba.resize((master_size, master_size), Image.Resampling.NEAREST)
        talk_master = _apply_open_mouth_pixel_edit(idle_master.copy())
        idle_blink_master = _apply_closed_eyes_pixel_edit(idle_master.copy())
        talk_blink_master = _apply_closed_eyes_pixel_edit(talk_master.copy())

        _save_pixel_master_state(idle_master, idle_path, output_size=output_size)
        _save_pixel_master_state(talk_master, out_dir / "talk.png", output_size=output_size)
        _save_pixel_master_state(
            idle_blink_master,
            out_dir / "idle_blink.png",
            output_size=output_size,
        )
        _save_pixel_master_state(
            talk_blink_master,
            out_dir / "talk_blink.png",
            output_size=output_size,
        )

        return base_seed
    except AvatarGenerationError:
        raise
    except RuntimeError as exc:
        message = str(exc)
        if "cannot reshape tensor of 0 elements" in message:
            raise AvatarGenerationError(
                f"Model '{model_id}' does not support {size}x{size} generation. "
                "Try SD 1.5-base models or use a different generation size."
            ) from exc
        raise AvatarGenerationError(f"Model runtime error: {message}") from exc
    except Exception as exc:
        raise AvatarGenerationError(f"Unexpected avatar generation error: {exc}") from exc


def generate_avatar_idle(
    profile_id: str,
    out_dir: Path,
    user_prompt: str,
    *,
    model_id: str,
    lora_id: Optional[str] = None,
    lora_scale: float = 0.85,
    seed: Optional[int] = None,
    size: int = 512,
    output_size: int = 512,
    palette_colors: int = 64,
    negative_prompt: str = DEFAULT_NEGATIVE_PROMPT,
    num_inference_steps: int = 24,
    guidance_scale: float = 7.0,
    reference_idle_path: Optional[Path] = None,
    reference_idle_paths: Optional[list[Path]] = None,
    reference_strength: float = 0.2,
) -> int:
    """Generate only the idle state and save it in preview dir."""
    if not user_prompt.strip():
        raise AvatarGenerationError("Prompt is required.")
    if size < 64 or size > 1024:
        raise AvatarGenerationError("size must be between 64 and 1024.")
    if output_size < 64 or output_size > 2048:
        raise AvatarGenerationError("output_size must be between 64 and 2048.")
    if palette_colors < 2 or palette_colors > 256:
        raise AvatarGenerationError("palette_colors must be between 2 and 256.")
    if reference_strength < 0.0 or reference_strength > 1.0:
        raise AvatarGenerationError("reference_strength must be between 0.0 and 1.0.")

    try:
        pipelines = _get_pipelines(model_id=model_id, lora_id=lora_id, lora_scale=lora_scale)
        torch = pipelines.torch
        device = pipelines.device
        base_seed = seed if seed is not None else random.randint(1, 2_147_483_000)
        render_size = size
        out_dir.mkdir(parents=True, exist_ok=True)

        reference_paths: list[Path] = []
        if reference_idle_paths:
            reference_paths.extend(reference_idle_paths)
        if reference_idle_path is not None:
            reference_paths.append(reference_idle_path)
        reference_paths = list(dict.fromkeys(reference_paths))
        ref_rgb, ref_alpha = _load_single_reference_image(
            reference_paths=reference_paths,
            render_size=render_size,
            seed=base_seed,
        )

        idle_gen = torch.Generator(device=device).manual_seed(base_seed)
        if ref_rgb is not None:
            idle_img = _run_pipeline_image(
                pipelines.img2img,
                prompt=_build_prompt(user_prompt, "idle"),
                negative_prompt=_build_negative_prompt(negative_prompt, "idle"),
                image=ref_rgb,
                width=render_size,
                height=render_size,
                strength=reference_strength,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                generator=idle_gen,
            )
        else:
            idle_img = _run_pipeline_image(
                pipelines.txt2img,
                prompt=_build_prompt(user_prompt, "idle"),
                negative_prompt=_build_negative_prompt(negative_prompt, "idle"),
                width=render_size,
                height=render_size,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                generator=idle_gen,
            )
        idle_img = _to_pil_png(idle_img)
        _postprocess_and_save(
            idle_img,
            out_dir / "idle.png",
            generation_size=render_size,
            pixel_size=render_size,
            output_size=output_size,
            palette_colors=palette_colors,
            alpha_override=ref_alpha,
        )
        return base_seed
    except AvatarGenerationError:
        raise
    except Exception as exc:
        raise AvatarGenerationError(f"Unexpected idle generation error: {exc}") from exc


def generate_avatar_states_from_idle(
    out_dir: Path,
    user_prompt: str,
    *,
    model_id: str,
    lora_id: Optional[str] = None,
    lora_scale: float = 0.85,
    seed: Optional[int] = None,
    size: int = 512,
    output_size: int = 512,
    palette_colors: int = 64,
    seed_step: int = 1,
    negative_prompt: str = DEFAULT_NEGATIVE_PROMPT,
    num_inference_steps: int = 24,
    guidance_scale: float = 7.0,
    variation_strength: float = 0.22,
) -> int:
    """Generate talk / idle_blink / talk_blink using AI img2img from existing idle."""
    if not user_prompt.strip():
        raise AvatarGenerationError("Prompt is required.")
    if size < 64 or size > 1024:
        raise AvatarGenerationError("size must be between 64 and 1024.")
    if output_size < 64 or output_size > 2048:
        raise AvatarGenerationError("output_size must be between 64 and 2048.")
    if palette_colors < 2 or palette_colors > 256:
        raise AvatarGenerationError("palette_colors must be between 2 and 256.")
    if variation_strength < 0.0 or variation_strength > 1.0:
        raise AvatarGenerationError("variation_strength must be between 0.0 and 1.0.")

    idle_path = out_dir / "idle.png"
    if not idle_path.exists():
        raise AvatarGenerationError("Idle preview is missing. Generate idle first.")
    try:
        pipelines = _get_pipelines(model_id=model_id, lora_id=lora_id, lora_scale=lora_scale)
        torch = pipelines.torch
        device = pipelines.device
        base_seed = seed if seed is not None else random.randint(1, 2_147_483_000)
        render_size = size

        idle_saved_rgba = Image.open(idle_path).convert("RGBA")
        idle_alpha = idle_saved_rgba.getchannel("A")
        idle_base = idle_saved_rgba.convert("RGB")
        if idle_base.size != (render_size, render_size):
            idle_base = idle_base.resize((render_size, render_size), Image.Resampling.NEAREST)

        talk_base: Optional[Image.Image] = None
        source_rgba = idle_saved_rgba
        for i, state in enumerate(("talk", "idle_blink", "talk_blink"), start=1):
            source = (talk_base if state == "talk_blink" and talk_base is not None else idle_base)
            source_rgba_for_state = (
                Image.open(out_dir / "talk.png").convert("RGBA")
                if state == "talk_blink" and (out_dir / "talk.png").exists()
                else source_rgba
            )
            eyes_mask, mouth_mask = _build_expression_masks(source_rgba_for_state)
            target_mask = mouth_mask if state == "talk" else eyes_mask
            state_seed = base_seed + (i * seed_step)
            state_gen = torch.Generator(device=device).manual_seed(state_seed)
            state_img = _run_pipeline_image(
                pipelines.img2img,
                prompt=_build_rest_state_prompt(state),
                negative_prompt=_build_negative_prompt(negative_prompt, state),
                image=source,
                width=render_size,
                height=render_size,
                strength=max(variation_strength, 0.42),
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                generator=state_gen,
            )
            state_img = _to_pil_png(state_img)
            _postprocess_and_save(
                state_img,
                out_dir / f"{state}.png",
                generation_size=render_size,
                pixel_size=render_size,
                output_size=output_size,
                palette_colors=palette_colors,
                alpha_override=idle_alpha,
            )
            if state == "talk":
                talk_base = state_img.convert("RGB")
                if talk_base.size != (render_size, render_size):
                    talk_base = talk_base.resize((render_size, render_size), Image.Resampling.NEAREST)
                source_rgba = state_img.convert("RGBA")
        return base_seed
    except AvatarGenerationError:
        raise
    except Exception as exc:
        raise AvatarGenerationError(f"Unexpected state generation error: {exc}") from exc
