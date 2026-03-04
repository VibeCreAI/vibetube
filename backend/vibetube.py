"""
VibeTube renderer extension for Voicebox backend.
"""

from __future__ import annotations

import contextlib
import json
import math
import random
import shutil
import subprocess
import wave
from bisect import bisect_right
from pathlib import Path
from typing import Optional

from PIL import Image


class VibeTubeError(RuntimeError):
    """Raised when VibeTube rendering fails."""


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
) -> dict:
    """Render a multi-profile VibeTube overlay from explicit speaking segments."""
    if not profile_segments:
        raise VibeTubeError("Story render requires at least one speaking segment.")

    output_dir.mkdir(parents=True, exist_ok=True)
    duration_sec = _wav_duration_seconds(audio_path)
    total_frames = max(1, int(math.ceil(duration_sec * fps)))

    profile_ids = sorted(profile_segments.keys())
    slots = _layout_slots(len(profile_ids), width, height)
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
    )

    captions_path = None
    if text and text.strip():
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
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)

    duration_sec = _wav_duration_seconds(audio_path)
    total_frames = max(1, int(math.ceil(duration_sec * fps)))

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
    )

    captions_path = None
    if text and text.strip():
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
            proc.stdin.write(frame_bytes)
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


def _layout_slots(count: int, width: int, height: int) -> list[dict[str, int]]:
    """Build a simple grid layout for N avatars."""
    if count <= 0:
        return []
    cols = max(1, int(math.ceil(math.sqrt(count))))
    rows = max(1, int(math.ceil(count / cols)))
    slot_w = max(1, width // cols)
    slot_h = max(1, height // rows)
    slots: list[dict[str, int]] = []
    for idx in range(count):
        col = idx % cols
        row = idx // cols
        slots.append(
            {
                "x": col * slot_w,
                "y": row * slot_h,
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

            proc.stdin.write(canvas.tobytes())
    finally:
        proc.stdin.close()

    _, stderr = proc.communicate()
    if proc.returncode != 0:
        raise VibeTubeError(f"ffmpeg failed: {stderr.decode('utf-8', errors='ignore')}")


def _write_srt(text: str, duration_sec: float, out_path: Path) -> None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        lines = ["..."]

    total_ms = max(1, int(round(max(0.0, float(duration_sec)) * 1000.0)))
    total_weight = sum(max(1, len(line)) for line in lines)
    cursor_ms = 0
    cumulative_weight = 0
    blocks: list[str] = []
    line_count = len(lines)
    for idx, line in enumerate(lines, start=1):
        weight = max(1, len(line))
        start_ms = cursor_ms
        if idx == line_count:
            end_ms = total_ms
        else:
            cumulative_weight += weight
            proportional_end = int(round(total_ms * (cumulative_weight / float(total_weight))))

            remaining_lines = line_count - idx
            min_end = start_ms + 1
            max_end = max(min_end, total_ms - remaining_lines)
            end_ms = max(min_end, min(max_end, proportional_end))

        blocks.append(str(idx))
        blocks.append(f"{_srt_time_from_ms(start_ms)} --> {_srt_time_from_ms(end_ms)}")
        blocks.append(line)
        blocks.append("")
        cursor_ms = end_ms
    out_path.write_text("\n".join(blocks), encoding="utf-8")


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
