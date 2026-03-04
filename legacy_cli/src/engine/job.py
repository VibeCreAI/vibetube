from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

from engine.captions.srt import write_srt
from engine.exporter.png_sequence import export_png_sequence
from engine.exporter.webm import ensure_ffmpeg, export_webm_alpha
from engine.lipsync.pytoon_adapter import try_pytoon_timeline
from engine.lipsync.rms import rms_timeline
from engine.renderer.avatar import AvatarRenderer
from engine.tts.manager import VibetubeManagerError, ensure_vibetube_ready
from engine.tts.vibetube_client import VibetubeError, synthesize_with_vibetube
from models.config import RenderConfig
from models.result import RenderResult
from utils.audio import wav_duration_seconds
from utils.logging import get_logger


def render_job(config: RenderConfig) -> RenderResult:
    logger = get_logger("vibetube")
    config.out_dir.mkdir(parents=True, exist_ok=True)

    audio_path = config.out_dir / "voice.wav"
    text = config.resolved_text()

    if config.input_wav is not None:
        if not config.input_wav.exists():
            raise FileNotFoundError(f"Input WAV not found: {config.input_wav}")
        shutil.copy2(config.input_wav, audio_path)
        logger.info("Using existing WAV input: %s", config.input_wav)
    else:
        if not text:
            raise ValueError("Text is required when --input-wav is not provided.")
        if config.voice_profile_id:
            logger.info(
                "Generating speech via Vibetube at %s (profile_id=%s)",
                config.vibetube_url,
                config.voice_profile_id,
            )
        else:
            logger.info("Generating speech via Vibetube at %s", config.vibetube_url)
        try:
            ensure_vibetube_ready(
                vibetube_url=config.vibetube_url,
                logger=logger,
                manage_vibetube=config.manage_vibetube,
                start_command=config.vibetube_start_command,
                workdir=config.vibetube_workdir,
                timeout_sec=config.vibetube_start_timeout_sec,
            )
            synthesize_with_vibetube(
                text=text,
                vibetube_url=config.vibetube_url,
                out_wav=audio_path,
                profile_id=config.voice_profile_id,
                language=config.voice_language,
            )
        except VibetubeManagerError as exc:
            raise RuntimeError(f"Vibetube startup failed. Details: {exc}") from exc
        except VibetubeError as exc:
            raise RuntimeError(
                "Vibetube generation failed. Ensure Vibetube is running and reachable. "
                f"Details: {exc}"
            ) from exc

    duration_sec = wav_duration_seconds(audio_path)
    total_frames = max(1, int(math.ceil(duration_sec * config.fps)))
    logger.info("Audio duration %.2fs (%d frames at %d FPS)", duration_sec, total_frames, config.fps)

    timeline = None
    if config.use_pytoon:
        timeline = try_pytoon_timeline(audio_path, config.fps, total_frames, logger)
    if timeline is None:
        logger.info("Computing RMS lip-sync timeline.")
        timeline = rms_timeline(
            wav_path=audio_path,
            fps=config.fps,
            duration_sec=duration_sec,
            window_ms=config.window_ms,
            smoothing_windows=config.smoothing_windows,
            on_threshold=config.on_threshold,
            off_threshold=config.off_threshold,
            min_hold_frames=config.min_hold_frames,
        )

    timeline_path = config.out_dir / "timeline.json"
    timeline_path.write_text(json.dumps(timeline, indent=2), encoding="utf-8")

    renderer = AvatarRenderer(config.avatar_dir, config.width, config.height, config.fps)
    frame_iter = renderer.frame_bytes(total_frames=total_frames, timeline=timeline)

    video_path = None
    png_dir = None
    if config.format == "webm":
        ensure_ffmpeg()
        video_path = export_webm_alpha(
            frame_iter=frame_iter,
            audio_path=audio_path,
            out_path=config.out_dir / "avatar.webm",
            width=config.width,
            height=config.height,
            fps=config.fps,
            total_frames=total_frames,
            logger=logger,
        )
    else:
        png_dir = export_png_sequence(
            frame_iter=frame_iter,
            out_dir=config.out_dir,
            width=config.width,
            height=config.height,
            fps=config.fps,
            total_frames=total_frames,
            logger=logger,
        )

    captions_path = None
    if text:
        captions_path = write_srt(text=text, duration_sec=duration_sec, out_path=config.out_dir / "captions.srt")

    meta = {
        "fps": config.fps,
        "width": config.width,
        "height": config.height,
        "duration_sec": round(duration_sec, 3),
        "audio": audio_path.name,
        "video": video_path.name if video_path else None,
        "png_dir": png_dir.name if png_dir else None,
        "timeline": timeline_path.name,
        "vibetube_url": config.vibetube_url if config.input_wav is None else None,
        "voice_profile_id": config.voice_profile_id if config.input_wav is None else None,
        "managed_vibetube": config.manage_vibetube if config.input_wav is None else None,
    }
    meta_path = config.out_dir / "meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    logger.info("Render finished. Output: %s", config.out_dir)
    return RenderResult(
        out_dir=config.out_dir,
        audio_path=audio_path,
        duration_sec=duration_sec,
        captions_path=captions_path,
        meta_path=meta_path,
        timeline_path=timeline_path,
        video_path=video_path,
        png_dir=png_dir,
    )

