"""
VibeTube renderer extension for Vibetube backend.
"""

from __future__ import annotations

import contextlib
import json
import math
import random
import re
import shutil
import subprocess
import wave
from bisect import bisect_right
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw, ImageFont


class VibeTubeError(RuntimeError):
    """Raised when VibeTube rendering fails."""


SUBTITLE_STYLE_VALUES = {"minimal", "cinema", "glass"}


def _parse_background_rgba(use_background: bool, background_color: Optional[str]) -> Optional[tuple[int, int, int, int]]:
    if not use_background:
        return None
    if background_color is None:
        return None
    raw = (background_color or "#000000").strip()
    if raw.startswith("#"):
        raw = raw[1:]
    if len(raw) == 6:
        raw = f"{raw}FF"
    if len(raw) != 8:
        raise VibeTubeError("Invalid background color. Use #RRGGBB or #RRGGBBAA.")
    try:
        value = int(raw, 16)
    except ValueError as exc:
        raise VibeTubeError("Invalid background color. Use hexadecimal format.") from exc
    r = (value >> 24) & 0xFF
    g = (value >> 16) & 0xFF
    b = (value >> 8) & 0xFF
    a = value & 0xFF
    return (r, g, b, a)


def _load_background_image(
    background_image_path: Optional[Path],
    width: int,
    height: int,
) -> Optional[Image.Image]:
    if background_image_path is None:
        return None
    if not background_image_path.exists():
        raise VibeTubeError(f"Background image not found: {background_image_path}")

    with Image.open(background_image_path) as img:
        rgba = img.convert("RGBA")
        src_w, src_h = rgba.size
        if src_w <= 0 or src_h <= 0:
            raise VibeTubeError("Invalid background image size.")

        # Cover fit: fill frame while preserving aspect ratio.
        scale = max(width / float(src_w), height / float(src_h))
        new_w = max(1, int(round(src_w * scale)))
        new_h = max(1, int(round(src_h * scale)))
        resized = rgba.resize((new_w, new_h), Image.Resampling.LANCZOS)

        x = max(0, (new_w - width) // 2)
        y = max(0, (new_h - height) // 2)
        cropped = resized.crop((x, y, x + width, y + height))
        return cropped.copy()


def _fit_background_frame(img: Image.Image, width: int, height: int) -> Image.Image:
    rgba = img.convert("RGBA")
    src_w, src_h = rgba.size
    if src_w <= 0 or src_h <= 0:
        raise VibeTubeError("Invalid background image size.")

    scale = max(width / float(src_w), height / float(src_h))
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resized = rgba.resize((new_w, new_h), Image.Resampling.LANCZOS)
    x = max(0, (new_w - width) // 2)
    y = max(0, (new_h - height) // 2)
    return resized.crop((x, y, x + width, y + height))


def _load_background_animation(
    background_image_path: Optional[Path],
    width: int,
    height: int,
) -> tuple[Optional[list[Image.Image]], Optional[list[int]], int]:
    if background_image_path is None:
        return None, None, 0
    if not background_image_path.exists():
        raise VibeTubeError(f"Background image not found: {background_image_path}")

    with Image.open(background_image_path) as img:
        is_gif = (img.format or "").upper() == "GIF"
        if not is_gif:
            single = _fit_background_frame(img, width, height)
            return [single], [100], 100

        frames: list[Image.Image] = []
        durations_ms: list[int] = []
        for i in range(getattr(img, "n_frames", 1)):
            img.seek(i)
            frame = _fit_background_frame(img, width, height).copy()
            duration = int(img.info.get("duration", 100) or 100)
            duration = max(20, duration)
            frames.append(frame)
            durations_ms.append(duration)

        if not frames:
            raise VibeTubeError("Background GIF has no frames.")

        total_ms = max(1, sum(durations_ms))
        return frames, durations_ms, total_ms


def _background_frame_at_time(
    background_frames: Optional[list[Image.Image]],
    frame_cumulative_ms: Optional[list[int]],
    total_duration_ms: int,
    t_ms: int,
) -> tuple[Optional[Image.Image], int]:
    if not background_frames:
        return None, -1
    if len(background_frames) == 1 or not frame_cumulative_ms or total_duration_ms <= 0:
        return background_frames[0], 0

    local_t = t_ms % total_duration_ms
    idx = bisect_right(frame_cumulative_ms, local_t)
    idx = min(max(0, idx), len(background_frames) - 1)
    return background_frames[idx], idx


def render_story_overlay(
    audio_path: Path,
    profile_segments: dict[str, list[tuple[float, float]]],
    avatar_dirs: dict[str, Path],
    output_dir: Path,
    fps: int = 30,
    width: int = 512,
    height: int = 512,
    on_threshold: float = 0.024,
    off_threshold: float = 0.016,
    smoothing_windows: int = 3,
    min_hold_windows: int = 1,
    blink_min_interval_sec: float = 3.5,
    blink_max_interval_sec: float = 5.5,
    blink_duration_frames: int = 3,
    head_motion_amount_px: float = 3.0,
    head_motion_change_sec: float = 2.8,
    head_motion_smoothness: float = 0.04,
    voice_bounce_amount_px: float = 4.0,
    voice_bounce_sensitivity: float = 1.0,
    use_background: bool = False,
    background_color: Optional[str] = None,
    background_image_path: Optional[Path] = None,
    text: Optional[str] = None,
    subtitle_enabled: bool = False,
    subtitle_style: str = "minimal",
    subtitle_text_color: str = "#FFFFFF",
    subtitle_outline_color: str = "#000000",
    subtitle_outline_width: int = 2,
    subtitle_font_family: str = "sans",
    subtitle_bold: bool = True,
    subtitle_italic: bool = False,
    story_layout_style: str = "balanced",
    show_profile_names: bool = True,
    profile_display_names: Optional[dict[str, str]] = None,
    subtitle_cues: Optional[list[dict[str, int | str]]] = None,
) -> dict:
    """Render a multi-profile VibeTube overlay from explicit speaking segments."""
    if not profile_segments:
        raise VibeTubeError("Story render requires at least one speaking segment.")

    output_dir.mkdir(parents=True, exist_ok=True)
    duration_sec = _wav_duration_seconds(audio_path)
    total_frames = max(1, int(math.ceil(duration_sec * fps)))
    subtitle_style = _normalize_subtitle_style(subtitle_style)
    generated_subtitle_cues = subtitle_cues if subtitle_cues is not None else _build_subtitle_cues(text=text, duration_sec=duration_sec)
    render_subtitle_cues = generated_subtitle_cues if subtitle_enabled else []

    profile_ids = sorted(profile_segments.keys())
    slots = _layout_slots(
        len(profile_ids),
        width,
        height,
        reserve_bottom_ratio=0.14,
        story_layout_style=story_layout_style,
    )
    rms_talk_frames = _rms_talk_frames(
        wav_path=audio_path,
        duration_sec=duration_sec,
        fps=fps,
        on_threshold=on_threshold,
        off_threshold=off_threshold,
        smoothing_windows=smoothing_windows,
        min_hold_windows=min_hold_windows,
    )
    rms_frame_levels = _rms_frame_levels(
        wav_path=audio_path,
        duration_sec=duration_sec,
        fps=fps,
        on_threshold=on_threshold,
        off_threshold=off_threshold,
        smoothing_windows=smoothing_windows,
        sensitivity=voice_bounce_sensitivity,
    )

    segment_events: dict[str, dict[int, int]] = {}
    for profile_id, segments in profile_segments.items():
        events: dict[int, int] = {}
        for start_sec, end_sec in segments:
            start_frame = max(0, min(total_frames - 1, int(math.floor(start_sec * fps))))
            end_frame = max(start_frame, min(total_frames - 1, int(math.ceil(end_sec * fps)) - 1))
            events[start_frame] = events.get(start_frame, 0) + 1
            off_frame = end_frame + 1
            if off_frame < total_frames:
                events[off_frame] = events.get(off_frame, 0) - 1
        segment_events[profile_id] = events

    states = [{"frame": 0, "state": "idle"}]
    timeline_path = output_dir / "timeline.json"
    timeline_path.write_text(json.dumps(states, indent=2), encoding="utf-8")

    avatars: dict[str, dict[str, Optional[Image.Image]]] = {}
    for idx, profile_id in enumerate(profile_ids):
        avatar_dir = avatar_dirs.get(profile_id)
        if avatar_dir is None:
            raise VibeTubeError(f"Missing avatar directory for profile: {profile_id}")
        slot = slots[idx]
        avatars[profile_id] = _load_avatar_assets_to_slot(
            avatar_dir=avatar_dir,
            slot_width=slot["width"],
            slot_height=slot["height"],
        )

    background_frames, background_durations_ms, background_total_ms = (
        _load_background_animation(background_image_path, width, height)
        if use_background
        else (None, None, 0)
    )

    _export_story_webm(
        audio_path=audio_path,
        out_path=output_dir / "avatar.webm",
        fps=fps,
        width=width,
        height=height,
        total_frames=total_frames,
        profile_ids=profile_ids,
        segment_events=segment_events,
        rms_talk_frames=rms_talk_frames,
        avatars=avatars,
        slots=slots,
        blink_min_interval_sec=blink_min_interval_sec,
        blink_max_interval_sec=blink_max_interval_sec,
        blink_duration_frames=blink_duration_frames,
        head_motion_amount_px=head_motion_amount_px,
        head_motion_change_sec=head_motion_change_sec,
        head_motion_smoothness=head_motion_smoothness,
        voice_bounce_amount_px=voice_bounce_amount_px,
        rms_frame_levels=rms_frame_levels,
        background_rgba=_parse_background_rgba(use_background, background_color),
        background_frames=background_frames,
        background_durations_ms=background_durations_ms,
        background_total_ms=background_total_ms,
        subtitle_cues=render_subtitle_cues,
        subtitle_style=subtitle_style,
        subtitle_text_color=subtitle_text_color,
        subtitle_outline_color=subtitle_outline_color,
        subtitle_outline_width=subtitle_outline_width,
        subtitle_font_family=subtitle_font_family,
        subtitle_bold=subtitle_bold,
        subtitle_italic=subtitle_italic,
        show_profile_names=show_profile_names,
        profile_display_names=profile_display_names or {},
    )

    captions_path = None
    if generated_subtitle_cues:
        captions_path = output_dir / "captions.srt"
        _write_srt_from_cues(generated_subtitle_cues, captions_path)
    elif text and text.strip():
        captions_path = output_dir / "captions.srt"
        _write_srt(text=text.strip(), duration_sec=duration_sec, out_path=captions_path)

    meta = {
        "fps": fps,
        "width": width,
        "height": height,
        "duration_sec": round(duration_sec, 3),
        "audio": audio_path.name,
        "video": "avatar.webm",
        "timeline": "timeline.json",
        "captions": captions_path.name if captions_path else None,
        "profiles": profile_ids,
        "blink": {
            "min_interval_sec": blink_min_interval_sec,
            "max_interval_sec": blink_max_interval_sec,
            "duration_frames": blink_duration_frames,
        },
        "mouth_detection": {
            "on_threshold": on_threshold,
            "off_threshold": off_threshold,
            "smoothing_windows": smoothing_windows,
            "min_hold_windows": min_hold_windows,
        },
        "head_motion": {
            "amount_px": head_motion_amount_px,
            "change_sec": head_motion_change_sec,
            "smoothness": head_motion_smoothness,
        },
        "voice_bounce": {
            "amount_px": voice_bounce_amount_px,
            "sensitivity": voice_bounce_sensitivity,
        },
        "background": {
            "enabled": use_background,
            "color": background_color if use_background else None,
            "image": str(background_image_path) if (use_background and background_image_path) else None,
        },
        "subtitles": {
            "enabled": subtitle_enabled,
            "style": subtitle_style if subtitle_enabled else None,
            "text_color": subtitle_text_color if subtitle_enabled else None,
            "outline_color": subtitle_outline_color if subtitle_enabled else None,
            "outline_width": subtitle_outline_width if subtitle_enabled else None,
            "font_family": subtitle_font_family if subtitle_enabled else None,
            "bold": subtitle_bold if subtitle_enabled else None,
            "italic": subtitle_italic if subtitle_enabled else None,
        },
        "story_layout": {
            "style": story_layout_style,
        },
    }
    meta_path = output_dir / "meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return {
        "duration_sec": duration_sec,
        "frames": total_frames,
        "video_path": str(output_dir / "avatar.webm"),
        "timeline_path": str(timeline_path),
        "captions_path": str(captions_path) if captions_path else None,
        "meta_path": str(meta_path),
    }


def render_overlay(
    audio_path: Path,
    avatar_dir: Path,
    output_dir: Path,
    fps: int = 30,
    width: int = 512,
    height: int = 512,
    on_threshold: float = 0.03,
    off_threshold: float = 0.02,
    smoothing_windows: int = 3,
    min_hold_windows: int = 1,
    blink_min_interval_sec: float = 3.5,
    blink_max_interval_sec: float = 5.5,
    blink_duration_frames: int = 3,
    head_motion_amount_px: float = 3.0,
    head_motion_change_sec: float = 2.8,
    head_motion_smoothness: float = 0.04,
    voice_bounce_amount_px: float = 4.0,
    voice_bounce_sensitivity: float = 1.0,
    use_background: bool = False,
    background_color: Optional[str] = None,
    background_image_path: Optional[Path] = None,
    text: Optional[str] = None,
    subtitle_enabled: bool = False,
    subtitle_style: str = "minimal",
    subtitle_text_color: str = "#FFFFFF",
    subtitle_outline_color: str = "#000000",
    subtitle_outline_width: int = 2,
    subtitle_font_family: str = "sans",
    subtitle_bold: bool = True,
    subtitle_italic: bool = False,
    show_profile_names: bool = True,
    profile_display_name: Optional[str] = None,
    subtitle_cues: Optional[list[dict[str, int | str]]] = None,
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)

    duration_sec = _wav_duration_seconds(audio_path)
    total_frames = max(1, int(math.ceil(duration_sec * fps)))
    subtitle_style = _normalize_subtitle_style(subtitle_style)
    generated_subtitle_cues = subtitle_cues if subtitle_cues is not None else _build_subtitle_cues(text=text, duration_sec=duration_sec)
    render_subtitle_cues = generated_subtitle_cues if subtitle_enabled else []

    timeline = _rms_timeline(
        wav_path=audio_path,
        duration_sec=duration_sec,
        fps=fps,
        on_threshold=on_threshold,
        off_threshold=off_threshold,
        smoothing_windows=smoothing_windows,
        min_hold_windows=min_hold_windows,
    )
    rms_frame_levels = _rms_frame_levels(
        wav_path=audio_path,
        duration_sec=duration_sec,
        fps=fps,
        on_threshold=on_threshold,
        off_threshold=off_threshold,
        smoothing_windows=smoothing_windows,
        sensitivity=voice_bounce_sensitivity,
    )
    timeline_path = output_dir / "timeline.json"
    timeline_path.write_text(json.dumps(timeline, indent=2), encoding="utf-8")

    assets = _load_avatar_assets(avatar_dir=avatar_dir, width=width, height=height)
    background_frames, background_durations_ms, background_total_ms = (
        _load_background_animation(background_image_path, width, height)
        if use_background
        else (None, None, 0)
    )

    _export_webm(
        audio_path=audio_path,
        out_path=output_dir / "avatar.webm",
        fps=fps,
        width=width,
        height=height,
        total_frames=total_frames,
        timeline=timeline,
        assets=assets,
        blink_min_interval_sec=blink_min_interval_sec,
        blink_max_interval_sec=blink_max_interval_sec,
        blink_duration_frames=blink_duration_frames,
        head_motion_amount_px=head_motion_amount_px,
        head_motion_change_sec=head_motion_change_sec,
        head_motion_smoothness=head_motion_smoothness,
        voice_bounce_amount_px=voice_bounce_amount_px,
        rms_frame_levels=rms_frame_levels,
        background_rgba=_parse_background_rgba(use_background, background_color),
        background_frames=background_frames,
        background_durations_ms=background_durations_ms,
        background_total_ms=background_total_ms,
        subtitle_cues=render_subtitle_cues,
        subtitle_style=subtitle_style,
        subtitle_text_color=subtitle_text_color,
        subtitle_outline_color=subtitle_outline_color,
        subtitle_outline_width=subtitle_outline_width,
        subtitle_font_family=subtitle_font_family,
        subtitle_bold=subtitle_bold,
        subtitle_italic=subtitle_italic,
        show_profile_names=show_profile_names,
        profile_display_name=profile_display_name,
    )

    captions_path = None
    if generated_subtitle_cues:
        captions_path = output_dir / "captions.srt"
        _write_srt_from_cues(generated_subtitle_cues, captions_path)
    elif text and text.strip():
        captions_path = output_dir / "captions.srt"
        _write_srt(text=text.strip(), duration_sec=duration_sec, out_path=captions_path)

    meta = {
        "fps": fps,
        "width": width,
        "height": height,
        "duration_sec": round(duration_sec, 3),
        "audio": audio_path.name,
        "video": "avatar.webm",
        "timeline": "timeline.json",
        "captions": captions_path.name if captions_path else None,
        "blink": {
            "min_interval_sec": blink_min_interval_sec,
            "max_interval_sec": blink_max_interval_sec,
            "duration_frames": blink_duration_frames,
        },
        "head_motion": {
            "amount_px": head_motion_amount_px,
            "change_sec": head_motion_change_sec,
            "smoothness": head_motion_smoothness,
        },
        "voice_bounce": {
            "amount_px": voice_bounce_amount_px,
            "sensitivity": voice_bounce_sensitivity,
        },
        "background": {
            "enabled": use_background,
            "color": background_color if use_background else None,
            "image": str(background_image_path) if (use_background and background_image_path) else None,
        },
        "subtitles": {
            "enabled": subtitle_enabled,
            "style": subtitle_style if subtitle_enabled else None,
            "text_color": subtitle_text_color if subtitle_enabled else None,
            "outline_color": subtitle_outline_color if subtitle_enabled else None,
            "outline_width": subtitle_outline_width if subtitle_enabled else None,
            "font_family": subtitle_font_family if subtitle_enabled else None,
            "bold": subtitle_bold if subtitle_enabled else None,
            "italic": subtitle_italic if subtitle_enabled else None,
        },
    }
    meta_path = output_dir / "meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return {
        "duration_sec": duration_sec,
        "frames": total_frames,
        "video_path": str(output_dir / "avatar.webm"),
        "timeline_path": str(timeline_path),
        "captions_path": str(captions_path) if captions_path else None,
        "meta_path": str(meta_path),
    }


def export_mp4(webm_path: Path, mp4_path: Path) -> Path:
    """Transcode rendered WebM to MP4 (H.264 + AAC)."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise VibeTubeError("ffmpeg not found on PATH.")

    if not webm_path.exists():
        raise VibeTubeError(f"Rendered video not found: {webm_path}")

    mp4_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(webm_path),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        str(mp4_path),
    ]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise VibeTubeError(f"ffmpeg MP4 export failed: {proc.stderr}")

    return mp4_path


def _wav_duration_seconds(wav_path: Path) -> float:
    with contextlib.closing(wave.open(str(wav_path), "rb")) as stream:
        frames = stream.getnframes()
        rate = stream.getframerate()
        if rate <= 0:
            raise VibeTubeError(f"Invalid sample rate in WAV: {wav_path}")
        return frames / float(rate)


def _rms_timeline(
    wav_path: Path,
    duration_sec: float,
    fps: int,
    on_threshold: float,
    off_threshold: float,
    smoothing_windows: int,
    min_hold_windows: int,
) -> list[dict[str, str | int]]:
    values = _windowed_rms(wav_path=wav_path, window_ms=20)
    if not values:
        return [{"frame": 0, "state": "idle"}]

    smoothed = _moving_average(values, max(1, smoothing_windows))
    states = _hysteresis_states(
        smoothed,
        on_threshold=on_threshold,
        off_threshold=off_threshold,
        min_hold_windows=max(1, min_hold_windows),
    )

    total_frames = max(1, int(math.ceil(duration_sec * fps)))
    timeline: list[dict[str, str | int]] = [{"frame": 0, "state": "idle"}]
    prev = "idle"
    window_sec = 0.02
    for frame in range(total_frames):
        t = frame / float(fps)
        idx = min(len(states) - 1, int(t / window_sec))
        state = states[idx]
        if state != prev:
            timeline.append({"frame": frame, "state": state})
            prev = state
    return timeline


def _rms_talk_frames(
    wav_path: Path,
    duration_sec: float,
    fps: int,
    on_threshold: float,
    off_threshold: float,
    smoothing_windows: int,
    min_hold_windows: int,
) -> list[bool]:
    values = _windowed_rms(wav_path=wav_path, window_ms=20)
    total_frames = max(1, int(math.ceil(duration_sec * fps)))
    if not values:
        return [False] * total_frames

    smoothed = _moving_average(values, max(1, smoothing_windows))
    states = _hysteresis_states(
        smoothed,
        on_threshold=on_threshold,
        off_threshold=off_threshold,
        min_hold_windows=max(1, min_hold_windows),
    )
    window_sec = 0.02
    out: list[bool] = []
    for frame in range(total_frames):
        t = frame / float(fps)
        idx = min(len(states) - 1, int(t / window_sec))
        out.append(states[idx] == "talk")
    return out


def _rms_frame_levels(
    wav_path: Path,
    duration_sec: float,
    fps: int,
    on_threshold: float,
    off_threshold: float,
    smoothing_windows: int,
    sensitivity: float,
) -> list[float]:
    values = _windowed_rms(wav_path=wav_path, window_ms=20)
    total_frames = max(1, int(math.ceil(duration_sec * fps)))
    if not values:
        return [0.0] * total_frames

    smoothed = _moving_average(values, max(1, smoothing_windows))
    dynamic_range = max(0.001, on_threshold - off_threshold)
    gain = max(0.05, float(sensitivity))

    window_levels: list[float] = []
    for value in smoothed:
        normalized = (value - off_threshold) / dynamic_range
        normalized = max(0.0, min(1.0, normalized * gain))
        window_levels.append(normalized)

    window_levels = _moving_average(window_levels, 2)
    window_sec = 0.02
    out: list[float] = []
    for frame in range(total_frames):
        t = frame / float(fps)
        idx = min(len(window_levels) - 1, int(t / window_sec))
        out.append(window_levels[idx])
    return out


def _windowed_rms(wav_path: Path, window_ms: int) -> list[float]:
    values: list[float] = []
    with contextlib.closing(wave.open(str(wav_path), "rb")) as stream:
        channels = stream.getnchannels()
        sample_width = stream.getsampwidth()
        sample_rate = stream.getframerate()
        if sample_width != 2:
            raise VibeTubeError("Only 16-bit PCM WAV is currently supported for VibeTube rendering.")

        samples_per_window = max(1, int(sample_rate * (window_ms / 1000.0)))
        while True:
            chunk = stream.readframes(samples_per_window)
            if not chunk:
                break
            values.append(_rms_chunk(chunk, channels))
    return values


def _rms_chunk(chunk: bytes, channels: int) -> float:
    total = 0.0
    count = 0
    stride = 2 * channels
    for i in range(0, len(chunk) - (len(chunk) % stride), stride):
        sample_sum = 0.0
        for channel in range(channels):
            offset = i + channel * 2
            sample = int.from_bytes(chunk[offset : offset + 2], byteorder="little", signed=True)
            sample_sum += float(sample)
        avg = sample_sum / channels
        norm = avg / 32768.0
        total += norm * norm
        count += 1
    if count == 0:
        return 0.0
    return math.sqrt(total / count)


def _moving_average(values: list[float], n: int) -> list[float]:
    out: list[float] = []
    acc = 0.0
    queue: list[float] = []
    for value in values:
        queue.append(value)
        acc += value
        if len(queue) > n:
            acc -= queue.pop(0)
        out.append(acc / len(queue))
    return out


def _hysteresis_states(
    values: list[float],
    on_threshold: float,
    off_threshold: float,
    min_hold_windows: int,
) -> list[str]:
    state = "idle"
    hold = 0
    out: list[str] = []
    for value in values:
        target = state
        if state == "idle" and value >= on_threshold:
            target = "talk"
        elif state == "talk" and value <= off_threshold:
            target = "idle"

        if target != state:
            hold += 1
            if hold >= min_hold_windows:
                state = target
                hold = 0
        else:
            hold = 0
        out.append(state)
    return out


def _load_avatar_assets(avatar_dir: Path, width: int, height: int) -> dict[str, Optional[Image.Image]]:
    return {
        "idle": _load_image(avatar_dir / "idle.png", width, height, required=True),
        "talk": _load_image(avatar_dir / "talk.png", width, height, required=True),
        "idle_blink": _load_image(avatar_dir / "idle_blink.png", width, height, required=False),
        "talk_blink": _load_image(avatar_dir / "talk_blink.png", width, height, required=False),
        "blink": _load_image(avatar_dir / "blink.png", width, height, required=False),
    }


def _load_image(path: Path, width: int, height: int, required: bool) -> Optional[Image.Image]:
    if not path.exists():
        if required:
            raise VibeTubeError(f"Missing avatar file: {path.name}")
        return None
    with Image.open(path) as img:
        rgba = img.convert("RGBA").resize((width, height), Image.Resampling.LANCZOS)
        # Avoid color fringe on fully transparent edges.
        pixels = list(rgba.getdata())
        cleaned = [(0, 0, 0, 0) if a == 0 else (r, g, b, a) for (r, g, b, a) in pixels]
        rgba.putdata(cleaned)
        return rgba.copy()


def _export_webm(
    audio_path: Path,
    out_path: Path,
    fps: int,
    width: int,
    height: int,
    total_frames: int,
    timeline: list[dict[str, str | int]],
    assets: dict[str, Optional[Image.Image]],
    blink_min_interval_sec: float,
    blink_max_interval_sec: float,
    blink_duration_frames: int,
    head_motion_amount_px: float,
    head_motion_change_sec: float,
    head_motion_smoothness: float,
    voice_bounce_amount_px: float,
    rms_frame_levels: list[float],
    background_rgba: Optional[tuple[int, int, int, int]],
    background_frames: Optional[list[Image.Image]],
    background_durations_ms: Optional[list[int]],
    background_total_ms: int,
    subtitle_cues: list[dict[str, int | str]],
    subtitle_style: str,
    subtitle_text_color: str,
    subtitle_outline_color: str,
    subtitle_outline_width: int,
    subtitle_font_family: str,
    subtitle_bold: bool,
    subtitle_italic: bool,
    show_profile_names: bool,
    profile_display_name: Optional[str],
) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise VibeTubeError("ffmpeg not found on PATH.")

    cmd = [
        ffmpeg,
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        f"{width}x{height}",
        "-r",
        str(fps),
        "-i",
        "-",
        "-i",
        str(audio_path),
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-c:a",
        "libopus",
        "-shortest",
        str(out_path),
    ]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None

    change_idx = 0
    current_state = str(timeline[0]["state"]) if timeline else "idle"
    next_frame = int(timeline[1]["frame"]) if len(timeline) > 1 else total_frames
    min_interval = max(0.2, float(blink_min_interval_sec))
    max_interval = max(min_interval, float(blink_max_interval_sec))
    blink_frames = max(1, int(blink_duration_frames))
    rng = random.Random(1337)
    next_blink_frame = max(1, int(round(min_interval * fps)))
    blink_remaining = 0
    frame_cache: dict[tuple[str, int, int, int, int, int, int], bytes] = {}

    max_motion = max(0.0, float(head_motion_amount_px))
    max_offset = int(round(max_motion))
    move_change_sec = max(0.25, float(head_motion_change_sec))
    smoothness = min(1.0, max(0.001, float(head_motion_smoothness)))
    cur_x = 0.0
    cur_y = 0.0
    target_x = 0.0
    target_y = 0.0
    next_motion_change = 0
    if max_offset > 0:
        target_x = rng.uniform(-max_motion, max_motion)
        target_y = rng.uniform(-max_motion, max_motion)
        next_motion_change = max(1, int(round(move_change_sec * fps)))

    bounce_amount = max(0.0, float(voice_bounce_amount_px))
    bounce_hz = 4.0
    subtitle_palette = _resolve_subtitle_palette(
        subtitle_style=subtitle_style,
        subtitle_text_color=subtitle_text_color,
        subtitle_outline_color=subtitle_outline_color,
        subtitle_outline_width=subtitle_outline_width,
    )
    subtitle_font_size = _subtitle_base_font_size(height)
    name_tag_font = _load_name_tag_font(height)
    subtitle_cursor = 0
    background_cumulative_ms: Optional[list[int]] = None
    if background_durations_ms:
        background_cumulative_ms = []
        running = 0
        for duration in background_durations_ms:
            running += duration
            background_cumulative_ms.append(running)

    try:
        for frame in range(total_frames):
            if frame >= next_frame:
                change_idx += 1
                current_state = str(timeline[change_idx]["state"])
                next_frame = int(timeline[change_idx + 1]["frame"]) if change_idx + 1 < len(timeline) else total_frames

            if frame >= next_blink_frame:
                blink_remaining = blink_frames
                next_interval = rng.uniform(min_interval, max_interval)
                next_blink_frame = frame + max(1, int(round(next_interval * fps)))

            blinking = blink_remaining > 0
            if blink_remaining > 0:
                blink_remaining -= 1

            if max_offset > 0 and frame >= next_motion_change:
                target_x = rng.uniform(-max_motion, max_motion)
                target_y = rng.uniform(-max_motion, max_motion)
                interval_scale = rng.uniform(0.8, 1.35)
                next_motion_change = frame + max(1, int(round(move_change_sec * interval_scale * fps)))

            if max_offset > 0:
                cur_x += (target_x - cur_x) * smoothness
                cur_y += (target_y - cur_y) * smoothness
                offset_x = int(round(max(-max_motion, min(max_motion, cur_x))))
                offset_y = int(round(max(-max_motion, min(max_motion, cur_y))))
            else:
                offset_x = 0
                offset_y = 0

            if bounce_amount > 0 and frame < len(rms_frame_levels):
                level = max(0.0, min(1.0, rms_frame_levels[frame]))
                bounce_amp = bounce_amount * level
                bounce_offset_y = int(round(math.sin((frame / float(fps)) * (2.0 * math.pi * bounce_hz)) * bounce_amp))
            else:
                bounce_offset_y = 0

            if current_state == "talk":
                asset_key = "talk_blink" if blinking and assets["talk_blink"] else None
                asset_key = asset_key or ("blink" if blinking and assets["blink"] else None)
                asset_key = asset_key or "talk"
            else:
                asset_key = "idle_blink" if blinking and assets["idle_blink"] else None
                asset_key = asset_key or ("blink" if blinking and assets["blink"] else None)
                asset_key = asset_key or "idle"

            bg_image, bg_frame_idx = _background_frame_at_time(
                background_frames=background_frames,
                frame_cumulative_ms=background_cumulative_ms,
                total_duration_ms=background_total_ms,
                t_ms=int(round((frame / float(fps)) * 1000.0)),
            )

            frame_bytes = _frame_bytes_for_asset(
                assets=assets,
                asset_key=asset_key,
                offset_x=offset_x,
                offset_y=offset_y + bounce_offset_y,
                width=width,
                height=height,
                frame_cache=frame_cache,
                background_rgba=background_rgba,
                background_image=bg_image,
                background_frame_idx=bg_frame_idx,
            )
            if frame_bytes is None:
                raise VibeTubeError("Avatar assets were not loaded correctly.")
            frame_image = Image.frombytes("RGBA", (width, height), frame_bytes)
            if show_profile_names and profile_display_name:
                _draw_single_profile_name_tag(
                    image=frame_image,
                    profile_display_name=profile_display_name,
                    font=name_tag_font,
                    subtitle_enabled=bool(subtitle_cues),
                )
            if subtitle_cues:
                subtitle_cursor = _draw_subtitle_for_time(
                    image=frame_image,
                    subtitle_cues=subtitle_cues,
                    time_ms=int(round((frame / float(fps)) * 1000.0)),
                    initial_font_size=subtitle_font_size,
                    subtitle_style=subtitle_style,
                    subtitle_palette=subtitle_palette,
                    subtitle_font_family=subtitle_font_family,
                    subtitle_bold=subtitle_bold,
                    subtitle_italic=subtitle_italic,
                    cue_cursor=subtitle_cursor,
                )
                proc.stdin.write(frame_image.tobytes())
            else:
                proc.stdin.write(frame_image.tobytes())
    finally:
        proc.stdin.close()

    _, stderr = proc.communicate()
    if proc.returncode != 0:
        raise VibeTubeError(f"ffmpeg failed: {stderr.decode('utf-8', errors='ignore')}")


def _frame_bytes_for_asset(
    assets: dict[str, Optional[Image.Image]],
    asset_key: str,
    offset_x: int,
    offset_y: int,
    width: int,
    height: int,
    frame_cache: dict[tuple[str, int, int, int, int, int, int], bytes],
    background_rgba: Optional[tuple[int, int, int, int]],
    background_image: Optional[Image.Image],
    background_frame_idx: int = -1,
) -> Optional[bytes]:
    src = assets.get(asset_key)
    if src is None:
        return None

    if background_image is not None:
        bg_key = (background_frame_idx, -2, -2, -2)
    else:
        bg_key = background_rgba if background_rgba is not None else (-1, -1, -1, -1)
    cache_key = (asset_key, offset_x, offset_y, bg_key[0], bg_key[1], bg_key[2], bg_key[3])
    cached = frame_cache.get(cache_key)
    if cached is not None:
        return cached

    bg = background_rgba if background_rgba is not None else (0, 0, 0, 0)
    if offset_x == 0 and offset_y == 0 and background_rgba is None and background_image is None:
        frame = src
    else:
        if background_image is not None:
            frame = background_image.copy()
        else:
            frame = Image.new("RGBA", (width, height), bg)
        frame.alpha_composite(src, (offset_x, offset_y))

    out = frame.tobytes()
    frame_cache[cache_key] = out
    return out


def _layout_slots(
    count: int,
    width: int,
    height: int,
    reserve_bottom_ratio: float = 0.0,
    story_layout_style: str = "balanced",
) -> list[dict[str, int]]:
    """Build story avatar layouts with hand-tuned templates for common counts."""
    if count <= 0:
        return []

    aspect = width / float(max(1, height))
    safe_top = max(18, int(round(height * 0.05)))
    safe_bottom = max(18, int(round(height * max(0.06, reserve_bottom_ratio))))
    usable_height = max(1, height - safe_top - safe_bottom)

    template_slots = _layout_slots_from_template(
        count=count,
        width=width,
        safe_top=safe_top,
        usable_height=usable_height,
        aspect=aspect,
        story_layout_style=story_layout_style,
    )
    if template_slots is not None:
        return template_slots

    return _layout_slots_grid_fallback(
        count=count,
        width=width,
        safe_top=safe_top,
        safe_bottom=safe_bottom,
        height=height,
    )


def _layout_slots_from_template(
    count: int,
    width: int,
    safe_top: int,
    usable_height: int,
    aspect: float,
    story_layout_style: str,
) -> Optional[list[dict[str, int]]]:
    orientation = "portrait" if aspect < 0.82 else "landscape" if aspect > 1.18 else "square"

    templates: dict[str, dict[str, dict[int, list[tuple[float, float, float, float]]]]] = {
        "balanced": {
            "portrait": {
                1: [(0.5, 0.34, 0.60, 0.52)],
                2: [(0.30, 0.32, 0.46, 0.42), (0.70, 0.32, 0.46, 0.42)],
                3: [(0.26, 0.24, 0.42, 0.38), (0.74, 0.24, 0.42, 0.38), (0.5, 0.58, 0.46, 0.42)],
                4: [(0.28, 0.22, 0.36, 0.34), (0.72, 0.22, 0.36, 0.34), (0.28, 0.56, 0.36, 0.34), (0.72, 0.56, 0.36, 0.34)],
            },
            "square": {
                1: [(0.5, 0.40, 0.64, 0.58)],
                2: [(0.30, 0.42, 0.46, 0.46), (0.70, 0.42, 0.46, 0.46)],
                3: [(0.27, 0.25, 0.42, 0.40), (0.73, 0.25, 0.42, 0.40), (0.5, 0.66, 0.46, 0.42)],
                4: [(0.28, 0.26, 0.38, 0.36), (0.72, 0.26, 0.38, 0.36), (0.28, 0.66, 0.38, 0.36), (0.72, 0.66, 0.38, 0.36)],
            },
            "landscape": {
                1: [(0.5, 0.46, 0.46, 0.72)],
                2: [(0.30, 0.46, 0.34, 0.62), (0.70, 0.46, 0.34, 0.62)],
                3: [(0.20, 0.46, 0.28, 0.56), (0.50, 0.46, 0.28, 0.56), (0.80, 0.46, 0.28, 0.56)],
                4: [(0.16, 0.28, 0.25, 0.44), (0.50, 0.28, 0.25, 0.44), (0.84, 0.28, 0.25, 0.44), (0.50, 0.72, 0.28, 0.48)],
            },
        },
        "stage": {
            "portrait": {
                1: [(0.5, 0.36, 0.58, 0.50)],
                2: [(0.32, 0.36, 0.42, 0.40), (0.68, 0.36, 0.42, 0.40)],
                3: [(0.22, 0.32, 0.36, 0.34), (0.50, 0.35, 0.42, 0.40), (0.78, 0.32, 0.36, 0.34)],
                4: [(0.18, 0.30, 0.30, 0.28), (0.41, 0.35, 0.34, 0.34), (0.64, 0.35, 0.34, 0.34), (0.86, 0.30, 0.30, 0.28)],
            },
            "square": {
                1: [(0.5, 0.42, 0.62, 0.58)],
                2: [(0.32, 0.44, 0.40, 0.44), (0.68, 0.44, 0.40, 0.44)],
                3: [(0.20, 0.44, 0.30, 0.38), (0.50, 0.44, 0.36, 0.44), (0.80, 0.44, 0.30, 0.38)],
                4: [(0.18, 0.40, 0.26, 0.34), (0.40, 0.50, 0.28, 0.38), (0.60, 0.50, 0.28, 0.38), (0.82, 0.40, 0.26, 0.34)],
            },
            "landscape": {
                1: [(0.5, 0.48, 0.48, 0.74)],
                2: [(0.34, 0.50, 0.32, 0.62), (0.66, 0.50, 0.32, 0.62)],
                3: [(0.22, 0.52, 0.26, 0.54), (0.50, 0.50, 0.30, 0.64), (0.78, 0.52, 0.26, 0.54)],
                4: [(0.14, 0.52, 0.22, 0.46), (0.38, 0.50, 0.24, 0.56), (0.62, 0.50, 0.24, 0.56), (0.86, 0.52, 0.22, 0.46)],
            },
        },
        "compact": {
            "portrait": {
                1: [(0.5, 0.38, 0.50, 0.42)],
                2: [(0.32, 0.36, 0.38, 0.34), (0.68, 0.36, 0.38, 0.34)],
                3: [(0.28, 0.28, 0.34, 0.30), (0.72, 0.28, 0.34, 0.30), (0.5, 0.56, 0.38, 0.34)],
                4: [(0.30, 0.28, 0.30, 0.28), (0.70, 0.28, 0.30, 0.28), (0.30, 0.56, 0.30, 0.28), (0.70, 0.56, 0.30, 0.28)],
            },
            "square": {
                1: [(0.5, 0.42, 0.56, 0.50)],
                2: [(0.30, 0.42, 0.38, 0.38), (0.70, 0.42, 0.38, 0.38)],
                3: [(0.28, 0.28, 0.34, 0.32), (0.72, 0.28, 0.34, 0.32), (0.5, 0.62, 0.38, 0.36)],
                4: [(0.30, 0.30, 0.30, 0.30), (0.70, 0.30, 0.30, 0.30), (0.30, 0.64, 0.30, 0.30), (0.70, 0.64, 0.30, 0.30)],
            },
            "landscape": {
                1: [(0.5, 0.48, 0.40, 0.64)],
                2: [(0.30, 0.48, 0.30, 0.54), (0.70, 0.48, 0.30, 0.54)],
                3: [(0.22, 0.46, 0.24, 0.48), (0.50, 0.46, 0.26, 0.50), (0.78, 0.46, 0.24, 0.48)],
                4: [(0.18, 0.34, 0.22, 0.40), (0.42, 0.34, 0.22, 0.40), (0.58, 0.34, 0.22, 0.40), (0.82, 0.34, 0.22, 0.40)],
            },
        },
    }

    style_key = story_layout_style if story_layout_style in templates else "balanced"
    template = templates.get(style_key, {}).get(orientation, {}).get(count)
    if template is None:
        return None

    slots: list[dict[str, int]] = []
    for cx, cy, w_frac, h_frac in template:
        slot_w = max(1, int(round(width * w_frac)))
        slot_h = max(1, int(round(usable_height * h_frac)))
        x = int(round(cx * width - slot_w / 2.0))
        y = safe_top + int(round(cy * usable_height - slot_h / 2.0))
        x = max(0, min(width - slot_w, x))
        y = max(safe_top, y)
        slots.append({"x": x, "y": y, "width": slot_w, "height": slot_h})
    return slots


def _layout_slots_grid_fallback(
    count: int,
    width: int,
    safe_top: int,
    safe_bottom: int,
    height: int,
) -> list[dict[str, int]]:
    outer_pad_x = max(18, int(round(width * 0.05)))
    usable_width = max(1, width - (outer_pad_x * 2))
    usable_height = max(1, height - safe_top - safe_bottom)
    cols = max(1, int(math.ceil(math.sqrt(count))))
    rows = max(1, int(math.ceil(count / cols)))
    gap_x = max(10, int(round(min(width, height) * 0.03)))
    gap_y = max(12, int(round(min(width, height) * 0.03)))
    slot_w = max(1, int((usable_width - gap_x * (cols - 1)) // cols))
    slot_h = max(1, int((usable_height - gap_y * (rows - 1)) // rows))
    total_grid_w = cols * slot_w + max(0, cols - 1) * gap_x
    total_grid_h = rows * slot_h + max(0, rows - 1) * gap_y
    grid_x = outer_pad_x + max(0, (usable_width - total_grid_w) // 2)
    grid_y = safe_top + max(0, (usable_height - total_grid_h) // 2)

    slots: list[dict[str, int]] = []
    for idx in range(count):
        col = idx % cols
        row = idx // cols
        slots.append(
            {
                "x": grid_x + col * (slot_w + gap_x),
                "y": grid_y + row * (slot_h + gap_y),
                "width": slot_w,
                "height": slot_h,
            }
        )
    return slots


def _load_avatar_assets_to_slot(
    avatar_dir: Path,
    slot_width: int,
    slot_height: int,
) -> dict[str, Optional[Image.Image]]:
    return {
        "idle": _load_image_to_slot(avatar_dir / "idle.png", slot_width, slot_height, required=True),
        "talk": _load_image_to_slot(avatar_dir / "talk.png", slot_width, slot_height, required=True),
        "idle_blink": _load_image_to_slot(
            avatar_dir / "idle_blink.png", slot_width, slot_height, required=False
        ),
        "talk_blink": _load_image_to_slot(
            avatar_dir / "talk_blink.png", slot_width, slot_height, required=False
        ),
        "blink": _load_image_to_slot(avatar_dir / "blink.png", slot_width, slot_height, required=False),
    }


def _load_image_to_slot(
    path: Path,
    slot_width: int,
    slot_height: int,
    required: bool,
) -> Optional[Image.Image]:
    if not path.exists():
        if required:
            raise VibeTubeError(f"Missing avatar file: {path.name}")
        return None

    with Image.open(path) as img:
        rgba = img.convert("RGBA")
        # Keep aspect ratio and center inside slot.
        rgba.thumbnail((slot_width, slot_height), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (slot_width, slot_height), (0, 0, 0, 0))
        x = max(0, (slot_width - rgba.width) // 2)
        y = max(0, (slot_height - rgba.height) // 2)
        canvas.alpha_composite(rgba, (x, y))
        return canvas


def _export_story_webm(
    audio_path: Path,
    out_path: Path,
    fps: int,
    width: int,
    height: int,
    total_frames: int,
    profile_ids: list[str],
    segment_events: dict[str, dict[int, int]],
    rms_talk_frames: list[bool],
    avatars: dict[str, dict[str, Optional[Image.Image]]],
    slots: list[dict[str, int]],
    blink_min_interval_sec: float,
    blink_max_interval_sec: float,
    blink_duration_frames: int,
    head_motion_amount_px: float,
    head_motion_change_sec: float,
    head_motion_smoothness: float,
    voice_bounce_amount_px: float,
    rms_frame_levels: list[float],
    background_rgba: Optional[tuple[int, int, int, int]],
    background_frames: Optional[list[Image.Image]],
    background_durations_ms: Optional[list[int]],
    background_total_ms: int,
    subtitle_cues: list[dict[str, int | str]],
    subtitle_style: str,
    subtitle_text_color: str,
    subtitle_outline_color: str,
    subtitle_outline_width: int,
    subtitle_font_family: str,
    subtitle_bold: bool,
    subtitle_italic: bool,
    show_profile_names: bool,
    profile_display_names: dict[str, str],
) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise VibeTubeError("ffmpeg not found on PATH.")

    cmd = [
        ffmpeg,
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        f"{width}x{height}",
        "-r",
        str(fps),
        "-i",
        "-",
        "-i",
        str(audio_path),
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-c:a",
        "libopus",
        "-shortest",
        str(out_path),
    ]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None

    min_interval = max(0.2, float(blink_min_interval_sec))
    max_interval = max(min_interval, float(blink_max_interval_sec))
    blink_frames = max(1, int(blink_duration_frames))
    max_motion = max(0.0, float(head_motion_amount_px))
    move_change_sec = max(0.25, float(head_motion_change_sec))
    smoothness = min(1.0, max(0.001, float(head_motion_smoothness)))

    talk_counts = {pid: 0 for pid in profile_ids}
    blink_remaining = {pid: 0 for pid in profile_ids}
    next_blink_frame = {pid: 1 for pid in profile_ids}
    cur_x = {pid: 0.0 for pid in profile_ids}
    cur_y = {pid: 0.0 for pid in profile_ids}
    target_x = {pid: 0.0 for pid in profile_ids}
    target_y = {pid: 0.0 for pid in profile_ids}
    next_motion_change = {pid: 0 for pid in profile_ids}

    seed_rng = random.SystemRandom()
    rngs: dict[str, random.Random] = {}
    for idx, profile_id in enumerate(profile_ids):
        rng = random.Random(seed_rng.randint(1, 2_147_483_647) + idx * 97)
        rngs[profile_id] = rng
        initial_blink_sec = rng.uniform(min_interval, max_interval)
        next_blink_frame[profile_id] = max(1, int(round(initial_blink_sec * fps)))
        if max_motion > 0:
            target_x[profile_id] = rng.uniform(-max_motion, max_motion)
            target_y[profile_id] = rng.uniform(-max_motion, max_motion)
            initial_motion_scale = rng.uniform(0.6, 1.4)
            next_motion_change[profile_id] = max(
                1, int(round(move_change_sec * initial_motion_scale * fps))
            )
    bounce_amount = max(0.0, float(voice_bounce_amount_px))
    bounce_hz = {pid: rngs[pid].uniform(3.2, 4.8) for pid in profile_ids}
    bounce_phase = {pid: rngs[pid].uniform(0.0, 2.0 * math.pi) for pid in profile_ids}
    subtitle_palette = _resolve_subtitle_palette(
        subtitle_style=subtitle_style,
        subtitle_text_color=subtitle_text_color,
        subtitle_outline_color=subtitle_outline_color,
        subtitle_outline_width=subtitle_outline_width,
    )
    subtitle_font_size = _subtitle_base_font_size(height)
    name_tag_font = _load_name_tag_font(height)
    subtitle_cursor = 0
    background_cumulative_ms: Optional[list[int]] = None
    if background_durations_ms:
        background_cumulative_ms = []
        running = 0
        for duration in background_durations_ms:
            running += duration
            background_cumulative_ms.append(running)

    try:
        for frame in range(total_frames):
            bg_image, _bg_idx = _background_frame_at_time(
                background_frames=background_frames,
                frame_cumulative_ms=background_cumulative_ms,
                total_duration_ms=background_total_ms,
                t_ms=int(round((frame / float(fps)) * 1000.0)),
            )
            if bg_image is not None:
                canvas = bg_image.copy()
            else:
                bg = background_rgba if background_rgba is not None else (0, 0, 0, 0)
                canvas = Image.new("RGBA", (width, height), bg)

            for idx, profile_id in enumerate(profile_ids):
                events = segment_events.get(profile_id, {})
                delta = events.get(frame)
                if delta:
                    talk_counts[profile_id] += delta

                if frame >= next_blink_frame[profile_id]:
                    blink_remaining[profile_id] = blink_frames
                    next_interval = rngs[profile_id].uniform(min_interval, max_interval)
                    next_blink_frame[profile_id] = frame + max(1, int(round(next_interval * fps)))

                blinking = blink_remaining[profile_id] > 0
                if blink_remaining[profile_id] > 0:
                    blink_remaining[profile_id] -= 1

                if max_motion > 0 and frame >= next_motion_change[profile_id]:
                    target_x[profile_id] = rngs[profile_id].uniform(-max_motion, max_motion)
                    target_y[profile_id] = rngs[profile_id].uniform(-max_motion, max_motion)
                    interval_scale = rngs[profile_id].uniform(0.8, 1.35)
                    next_motion_change[profile_id] = frame + max(
                        1, int(round(move_change_sec * interval_scale * fps))
                    )

                if max_motion > 0:
                    cur_x[profile_id] += (target_x[profile_id] - cur_x[profile_id]) * smoothness
                    cur_y[profile_id] += (target_y[profile_id] - cur_y[profile_id]) * smoothness
                    offset_x = int(round(max(-max_motion, min(max_motion, cur_x[profile_id]))))
                    offset_y = int(round(max(-max_motion, min(max_motion, cur_y[profile_id]))))
                else:
                    offset_x = 0
                    offset_y = 0

                speaking = talk_counts[profile_id] > 0 and rms_talk_frames[frame]
                if bounce_amount > 0 and speaking and frame < len(rms_frame_levels):
                    level = max(0.0, min(1.0, rms_frame_levels[frame]))
                    amp = bounce_amount * level
                    bounce = math.sin(
                        (frame / float(fps)) * (2.0 * math.pi * bounce_hz[profile_id])
                        + bounce_phase[profile_id]
                    )
                    bounce_offset_y = int(round(bounce * amp))
                else:
                    bounce_offset_y = 0
                assets = avatars[profile_id]
                if speaking:
                    asset_key = "talk_blink" if blinking and assets["talk_blink"] else None
                    asset_key = asset_key or ("blink" if blinking and assets["blink"] else None)
                    asset_key = asset_key or "talk"
                else:
                    asset_key = "idle_blink" if blinking and assets["idle_blink"] else None
                    asset_key = asset_key or ("blink" if blinking and assets["blink"] else None)
                    asset_key = asset_key or "idle"

                sprite = assets.get(asset_key)
                if sprite is None:
                    raise VibeTubeError("Avatar assets were not loaded correctly.")

                slot = slots[idx]
                canvas.alpha_composite(
                    sprite,
                    (slot["x"] + offset_x, slot["y"] + offset_y + bounce_offset_y),
                )
                if show_profile_names:
                    _draw_story_profile_name_tag(
                        image=canvas,
                        slot=slot,
                        profile_display_name=profile_display_names.get(profile_id, profile_id),
                        font=name_tag_font,
                    )

            if subtitle_cues:
                subtitle_cursor = _draw_subtitle_for_time(
                    image=canvas,
                    subtitle_cues=subtitle_cues,
                    time_ms=int(round((frame / float(fps)) * 1000.0)),
                    initial_font_size=subtitle_font_size,
                    subtitle_style=subtitle_style,
                    subtitle_palette=subtitle_palette,
                    subtitle_font_family=subtitle_font_family,
                    subtitle_bold=subtitle_bold,
                    subtitle_italic=subtitle_italic,
                    cue_cursor=subtitle_cursor,
                )
            proc.stdin.write(canvas.tobytes())
    finally:
        proc.stdin.close()

    _, stderr = proc.communicate()
    if proc.returncode != 0:
        raise VibeTubeError(f"ffmpeg failed: {stderr.decode('utf-8', errors='ignore')}")


def _write_srt(text: str, duration_sec: float, out_path: Path) -> None:
    cues = _build_subtitle_cues(text=text, duration_sec=duration_sec)
    _write_srt_from_cues(cues, out_path)


def _write_srt_from_cues(cues: list[dict[str, int | str]], out_path: Path) -> None:
    blocks: list[str] = []
    for idx, cue in enumerate(cues, start=1):
        blocks.append(str(idx))
        blocks.append(f"{_srt_time_from_ms(int(cue['start_ms']))} --> {_srt_time_from_ms(int(cue['end_ms']))}")
        blocks.append(str(cue["text"]))
        blocks.append("")
    out_path.write_text("\n".join(blocks), encoding="utf-8")


def _normalize_subtitle_style(subtitle_style: str) -> str:
    style = (subtitle_style or "minimal").strip().lower()
    if style not in SUBTITLE_STYLE_VALUES:
        raise VibeTubeError(f"Unsupported subtitle style: {subtitle_style}")
    return style


def _build_subtitle_cues(text: Optional[str], duration_sec: float) -> list[dict[str, int | str]]:
    segments = _subtitle_text_segments(text)
    if not segments:
        segments = ["..."]

    total_ms = max(1, int(round(max(0.0, float(duration_sec)) * 1000.0)))
    total_weight = sum(max(1, len(segment)) for segment in segments)
    cursor_ms = 0
    cumulative_weight = 0
    cues: list[dict[str, int | str]] = []
    segment_count = len(segments)
    for idx, segment in enumerate(segments, start=1):
        weight = max(1, len(segment))
        start_ms = cursor_ms
        if idx == segment_count:
            end_ms = total_ms
        else:
            cumulative_weight += weight
            proportional_end = int(round(total_ms * (cumulative_weight / float(total_weight))))
            remaining_segments = segment_count - idx
            min_end = start_ms + 1
            max_end = max(min_end, total_ms - remaining_segments)
            end_ms = max(min_end, min(max_end, proportional_end))
        cues.append({"start_ms": start_ms, "end_ms": end_ms, "text": segment})
        cursor_ms = end_ms
    return cues


def _subtitle_text_segments(text: Optional[str]) -> list[str]:
    raw_lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    if not raw_lines:
        return []

    parts: list[str] = []
    for raw_line in raw_lines:
        split_parts = re.split(r"(?<=[.!?])\s+|(?<=,)\s+", raw_line)
        for part in split_parts:
            normalized = re.sub(r"\s+", " ", part).strip()
            if not normalized:
                continue
            words = normalized.split(" ")
            current: list[str] = []
            for word in words:
                candidate = " ".join(current + [word]).strip()
                if current and len(candidate) > 52:
                    parts.append(" ".join(current))
                    current = [word]
                else:
                    current.append(word)
            if current:
                parts.append(" ".join(current))
    return parts


def _subtitle_base_font_size(height: int) -> int:
    return max(18, int(round(height * 0.055)))


def _load_subtitle_font(
    font_size: int,
    subtitle_font_family: str,
    subtitle_bold: bool,
    subtitle_italic: bool,
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for font_name in _subtitle_font_candidates(subtitle_font_family, subtitle_bold, subtitle_italic):
        with contextlib.suppress(OSError):
            return ImageFont.truetype(font_name, font_size)
    return ImageFont.load_default()


def _subtitle_font_candidates(
    subtitle_font_family: str,
    subtitle_bold: bool,
    subtitle_italic: bool,
) -> list[str]:
    family = (subtitle_font_family or "sans").strip().lower()
    style_key = (
        "bold-italic"
        if subtitle_bold and subtitle_italic
        else "bold"
        if subtitle_bold
        else "italic"
        if subtitle_italic
        else "regular"
    )
    family_map = {
        "sans": {
            "regular": ["DejaVuSans.ttf", "arial.ttf"],
            "bold": ["DejaVuSans-Bold.ttf", "arialbd.ttf", "arial.ttf"],
            "italic": ["DejaVuSans-Oblique.ttf", "ariali.ttf", "DejaVuSans.ttf"],
            "bold-italic": ["DejaVuSans-BoldOblique.ttf", "arialbi.ttf", "DejaVuSans-Bold.ttf"],
        },
        "serif": {
            "regular": ["DejaVuSerif.ttf", "times.ttf", "Georgia.ttf"],
            "bold": ["DejaVuSerif-Bold.ttf", "timesbd.ttf", "Georgia Bold.ttf", "DejaVuSerif.ttf"],
            "italic": ["DejaVuSerif-Italic.ttf", "timesi.ttf", "Georgia Italic.ttf", "DejaVuSerif.ttf"],
            "bold-italic": ["DejaVuSerif-BoldItalic.ttf", "timesbi.ttf", "DejaVuSerif-Bold.ttf"],
        },
        "mono": {
            "regular": ["DejaVuSansMono.ttf", "consola.ttf", "cour.ttf"],
            "bold": ["DejaVuSansMono-Bold.ttf", "consolab.ttf", "courbd.ttf", "DejaVuSansMono.ttf"],
            "italic": ["DejaVuSansMono-Oblique.ttf", "consolai.ttf", "DejaVuSansMono.ttf"],
            "bold-italic": ["DejaVuSansMono-BoldOblique.ttf", "consolaz.ttf", "DejaVuSansMono-Bold.ttf"],
        },
    }
    return family_map.get(family, family_map["sans"])[style_key]


def _load_name_tag_font(height: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return _load_subtitle_font(max(14, int(round(height * 0.024))), "sans", True, False)


def _draw_story_profile_name_tag(
    image: Image.Image,
    slot: dict[str, int],
    profile_display_name: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> None:
    label = (profile_display_name or "").strip()
    if not label:
        return
    draw = ImageDraw.Draw(image, "RGBA")
    bbox = draw.textbbox((0, 0), label, font=font)
    text_width = max(1, bbox[2] - bbox[0])
    text_height = max(1, bbox[3] - bbox[1])
    pad_x = max(8, int(round(slot["width"] * 0.04)))
    pad_y = max(4, int(round(slot["height"] * 0.03)))
    box_width = text_width + pad_x * 2
    box_height = text_height + pad_y * 2
    x = slot["x"] + max(0, (slot["width"] - box_width) // 2)
    y = min(
        image.size[1] - box_height - 4,
        slot["y"] + slot["height"] - box_height - max(4, int(round(slot["height"] * 0.02))),
    )
    draw.rounded_rectangle(
        (x, y, x + box_width, y + box_height),
        radius=max(8, int(round(box_height * 0.35))),
        fill=(8, 15, 30, 180),
        outline=(255, 255, 255, 48),
        width=1,
    )
    draw.text((x + pad_x, y + pad_y - 1), label, font=font, fill=(255, 255, 255, 235))


def _draw_single_profile_name_tag(
    image: Image.Image,
    profile_display_name: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    subtitle_enabled: bool,
) -> None:
    label = (profile_display_name or "").strip()
    if not label:
        return
    draw = ImageDraw.Draw(image, "RGBA")
    width, height = image.size
    bbox = draw.textbbox((0, 0), label, font=font)
    text_width = max(1, bbox[2] - bbox[0])
    text_height = max(1, bbox[3] - bbox[1])
    pad_x = max(10, int(round(width * 0.02)))
    pad_y = max(5, int(round(height * 0.01)))
    box_width = text_width + pad_x * 2
    box_height = text_height + pad_y * 2
    x = max(8, int(round((width - box_width) / 2.0)))
    base_y_ratio = 0.72 if subtitle_enabled else 0.84
    y = min(height - box_height - 8, max(8, int(round(height * base_y_ratio)) - box_height))
    draw.rounded_rectangle(
        (x, y, x + box_width, y + box_height),
        radius=max(10, int(round(box_height * 0.4))),
        fill=(8, 15, 30, 180),
        outline=(255, 255, 255, 48),
        width=1,
    )
    draw.text((x + pad_x, y + pad_y - 1), label, font=font, fill=(255, 255, 255, 235))


def _draw_subtitle_for_time(
    image: Image.Image,
    subtitle_cues: list[dict[str, int | str]],
    time_ms: int,
    initial_font_size: int,
    subtitle_style: str,
    subtitle_palette: dict[str, tuple[int, int, int, int] | int],
    subtitle_font_family: str,
    subtitle_bold: bool,
    subtitle_italic: bool,
    cue_cursor: int,
) -> int:
    cue_count = len(subtitle_cues)
    while cue_cursor < cue_count and int(subtitle_cues[cue_cursor]["end_ms"]) <= time_ms:
        cue_cursor += 1
    if cue_cursor >= cue_count:
        return cue_cursor

    cue = subtitle_cues[cue_cursor]
    if int(cue["start_ms"]) > time_ms or int(cue["end_ms"]) <= time_ms:
        return cue_cursor

    text = str(cue["text"]).strip()
    if not text:
        return cue_cursor

    draw = ImageDraw.Draw(image, "RGBA")
    width, height = image.size
    max_lines = 3 if height >= width else 2
    text_block = _fit_subtitle_text_block(
        draw=draw,
        text=text,
        width=width,
        height=height,
        initial_font_size=initial_font_size,
        stroke_width=int(subtitle_palette["stroke_width"]),
        max_lines=max_lines,
        subtitle_font_family=subtitle_font_family,
        subtitle_bold=subtitle_bold,
        subtitle_italic=subtitle_italic,
    )
    if text_block is None:
        return cue_cursor

    font = text_block["font"]
    lines = text_block["lines"]
    if not lines:
        return cue_cursor

    line_gap = max(6, int(round(height * 0.01)))
    stroke_width = int(subtitle_palette["stroke_width"])
    metrics = [draw.textbbox((0, 0), line, font=font, stroke_width=stroke_width) for line in lines]
    line_heights = [max(1, bbox[3] - bbox[1]) for bbox in metrics]
    total_height = sum(line_heights) + (line_gap * (len(lines) - 1))
    bottom_margin = max(18, int(round(height * 0.055)))
    left_padding = max(10, int(round(width * 0.06)))
    right_padding = left_padding
    text_width = max(max(1, bbox[2] - bbox[0]) for bbox in metrics)
    left = max(8, int(round((width - text_width) / 2.0)))
    right = min(width - 8, left + text_width)
    top = max(8, height - bottom_margin - total_height)
    _draw_subtitle_style_background(
        draw,
        subtitle_style,
        max(8, left - left_padding),
        top,
        min(width - 8, right + right_padding),
        top + total_height,
        width,
        height,
        subtitle_palette,
    )

    y = top
    for line, bbox, line_height in zip(lines, metrics, line_heights):
        line_width = max(1, bbox[2] - bbox[0])
        x = int(round((width - line_width) / 2.0))
        _draw_subtitle_line(draw, subtitle_style, x, y, line, font, subtitle_palette)
        y += line_height + line_gap
    return cue_cursor


def _fit_subtitle_text_block(
    draw: ImageDraw.ImageDraw,
    text: str,
    width: int,
    height: int,
    initial_font_size: int,
    stroke_width: int,
    max_lines: int,
    subtitle_font_family: str,
    subtitle_bold: bool,
    subtitle_italic: bool,
) -> Optional[dict[str, object]]:
    max_width = max(100, int(width * 0.84))
    max_text_height = max(40, int(height * 0.22))
    for font_size in range(initial_font_size, 13, -2):
        font = _load_subtitle_font(font_size, subtitle_font_family, subtitle_bold, subtitle_italic)
        lines = _wrap_subtitle_text(draw, text, font, max_width=max_width, stroke_width=stroke_width)
        if not lines or len(lines) > max_lines:
            continue
        line_gap = max(4, int(round(height * 0.01)))
        metrics = [draw.textbbox((0, 0), line, font=font, stroke_width=stroke_width) for line in lines]
        total_height = sum(max(1, bbox[3] - bbox[1]) for bbox in metrics) + (line_gap * (len(lines) - 1))
        widest = max(max(1, bbox[2] - bbox[0]) for bbox in metrics)
        if widest <= max_width and total_height <= max_text_height:
            return {"font": font, "lines": lines}

    font = _load_subtitle_font(14, subtitle_font_family, subtitle_bold, subtitle_italic)
    lines = _wrap_subtitle_text(draw, text, font, max_width=max_width, stroke_width=stroke_width)
    if not lines:
        return None
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and draw.textbbox((0, 0), f"{last}...", font=font, stroke_width=stroke_width)[2] > max_width:
            last = last[:-1].rstrip()
        lines[-1] = f"{last}..." if last else "..."
    return {"font": font, "lines": lines}


def _wrap_subtitle_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    max_width: int,
    stroke_width: int,
) -> list[str]:
    words = text.split()
    if not words:
        return []

    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        bbox = draw.textbbox((0, 0), candidate, font=font, stroke_width=stroke_width)
        if (bbox[2] - bbox[0]) <= max_width:
            current = candidate
            continue
        lines.append(current)
        current = word
    lines.append(current)
    return lines


def _draw_subtitle_style_background(
    draw: ImageDraw.ImageDraw,
    subtitle_style: str,
    left: int,
    top: int,
    right: int,
    bottom: int,
    width: int,
    height: int,
    subtitle_palette: dict[str, tuple[int, int, int, int] | int],
) -> None:
    pad_x = max(12, int(round(width * 0.02)))
    pad_y = max(8, int(round(height * 0.012)))
    box = (left - pad_x, top - pad_y, right + pad_x, bottom + pad_y)
    if subtitle_style == "minimal":
        return
    if subtitle_style == "cinema":
        draw.rounded_rectangle(
            box,
            radius=max(10, int(round(height * 0.015))),
            fill=subtitle_palette["background_fill"],
        )
        return
    if subtitle_style == "glass":
        draw.rounded_rectangle(
            box,
            radius=max(14, int(round(height * 0.02))),
            fill=subtitle_palette["background_fill"],
        )
        draw.rounded_rectangle(
            box,
            radius=max(14, int(round(height * 0.02))),
            outline=subtitle_palette["panel_outline"],
            width=2,
        )


def _draw_subtitle_line(
    draw: ImageDraw.ImageDraw,
    subtitle_style: str,
    x: int,
    y: int,
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    subtitle_palette: dict[str, tuple[int, int, int, int] | int],
) -> None:
    draw.text(
        (x, y),
        text,
        font=font,
        fill=subtitle_palette["fill"],
        stroke_width=int(subtitle_palette["stroke_width"]),
        stroke_fill=subtitle_palette["stroke_fill"],
    )


def _resolve_subtitle_palette(
    subtitle_style: str,
    subtitle_text_color: str,
    subtitle_outline_color: str,
    subtitle_outline_width: int,
) -> dict[str, tuple[int, int, int, int] | int]:
    fill = _parse_hex_color(subtitle_text_color, 255)
    stroke_fill = _parse_hex_color(subtitle_outline_color, 255)
    if subtitle_style == "glass":
        background_fill = (15, 23, 42, 150)
        panel_outline = (255, 255, 255, 120)
    elif subtitle_style == "cinema":
        background_fill = (0, 0, 0, 170)
        panel_outline = (0, 0, 0, 0)
    else:
        background_fill = (0, 0, 0, 0)
        panel_outline = (0, 0, 0, 0)
    return {
        "fill": fill,
        "stroke_fill": stroke_fill,
        "stroke_width": max(0, int(subtitle_outline_width)),
        "background_fill": background_fill,
        "panel_outline": panel_outline,
    }


def _parse_hex_color(raw: str, alpha: int) -> tuple[int, int, int, int]:
    value = (raw or "").strip()
    if value.startswith("#"):
        value = value[1:]
    if len(value) != 6:
        raise VibeTubeError("Invalid subtitle color. Use #RRGGBB.")
    try:
        int_value = int(value, 16)
    except ValueError as exc:
        raise VibeTubeError("Invalid subtitle color. Use hexadecimal format.") from exc
    return (
        (int_value >> 16) & 0xFF,
        (int_value >> 8) & 0xFF,
        int_value & 0xFF,
        alpha,
    )


def _srt_time(seconds: float) -> str:
    ms_total = int(round(max(0.0, float(seconds)) * 1000.0))
    return _srt_time_from_ms(ms_total)


def _srt_time_from_ms(ms_total: int) -> str:
    ms_total = max(0, int(ms_total))
    ms = ms_total % 1000
    sec_total = ms_total // 1000
    sec = sec_total % 60
    min_total = sec_total // 60
    minute = min_total % 60
    hour = min_total // 60
    return f"{hour:02d}:{minute:02d}:{sec:02d},{ms:03d}"
