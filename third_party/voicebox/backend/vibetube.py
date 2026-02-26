"""
VibeTube renderer extension for Voicebox backend.
"""

from __future__ import annotations

import contextlib
import json
import math
import shutil
import subprocess
import wave
from pathlib import Path
from typing import Optional

from PIL import Image


class VibeTubeError(RuntimeError):
    """Raised when VibeTube rendering fails."""


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
    timeline_path = output_dir / "timeline.json"
    timeline_path.write_text(json.dumps(timeline, indent=2), encoding="utf-8")

    assets = _load_avatar_assets(avatar_dir=avatar_dir, width=width, height=height)
    _export_webm(
        audio_path=audio_path,
        out_path=output_dir / "avatar.webm",
        fps=fps,
        width=width,
        height=height,
        total_frames=total_frames,
        timeline=timeline,
        assets=assets,
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


def _load_avatar_assets(avatar_dir: Path, width: int, height: int) -> dict[str, Optional[bytes]]:
    return {
        "idle": _load_image(avatar_dir / "idle.png", width, height, required=True),
        "talk": _load_image(avatar_dir / "talk.png", width, height, required=True),
        "idle_blink": _load_image(avatar_dir / "idle_blink.png", width, height, required=False),
        "talk_blink": _load_image(avatar_dir / "talk_blink.png", width, height, required=False),
        "blink": _load_image(avatar_dir / "blink.png", width, height, required=False),
    }


def _load_image(path: Path, width: int, height: int, required: bool) -> Optional[bytes]:
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
        return rgba.tobytes()


def _export_webm(
    audio_path: Path,
    out_path: Path,
    fps: int,
    width: int,
    height: int,
    total_frames: int,
    timeline: list[dict[str, str | int]],
    assets: dict[str, Optional[bytes]],
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

    try:
        for frame in range(total_frames):
            if frame >= next_frame:
                change_idx += 1
                current_state = str(timeline[change_idx]["state"])
                next_frame = int(timeline[change_idx + 1]["frame"]) if change_idx + 1 < len(timeline) else total_frames

            blinking = (frame % (fps * 4)) in (0, 1, 2)
            if current_state == "talk":
                frame_bytes = assets["talk_blink"] if blinking and assets["talk_blink"] else None
                frame_bytes = frame_bytes or (assets["blink"] if blinking and assets["blink"] else None)
                frame_bytes = frame_bytes or assets["talk"]
            else:
                frame_bytes = assets["idle_blink"] if blinking and assets["idle_blink"] else None
                frame_bytes = frame_bytes or (assets["blink"] if blinking and assets["blink"] else None)
                frame_bytes = frame_bytes or assets["idle"]

            if frame_bytes is None:
                raise VibeTubeError("Avatar assets were not loaded correctly.")
            proc.stdin.write(frame_bytes)
    finally:
        proc.stdin.close()

    _, stderr = proc.communicate()
    if proc.returncode != 0:
        raise VibeTubeError(f"ffmpeg failed: {stderr.decode('utf-8', errors='ignore')}")


def _write_srt(text: str, duration_sec: float, out_path: Path) -> None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        lines = ["..."]

    total_weight = sum(max(1, len(line)) for line in lines)
    cursor = 0.0
    blocks: list[str] = []
    for idx, line in enumerate(lines, start=1):
        weight = max(1, len(line))
        seg = duration_sec * (weight / total_weight)
        start = cursor
        end = duration_sec if idx == len(lines) else min(duration_sec, cursor + seg)

        blocks.append(str(idx))
        blocks.append(f"{_srt_time(start)} --> {_srt_time(end)}")
        blocks.append(line)
        blocks.append("")
        cursor = end
    out_path.write_text("\n".join(blocks), encoding="utf-8")


def _srt_time(seconds: float) -> str:
    ms_total = int(seconds * 1000)
    ms = ms_total % 1000
    sec_total = ms_total // 1000
    sec = sec_total % 60
    min_total = sec_total // 60
    minute = min_total % 60
    hour = min_total // 60
    return f"{hour:02d}:{minute:02d}:{sec:02d},{ms:03d}"
