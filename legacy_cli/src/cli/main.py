from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

from engine.job import render_job
from engine.tts.vibetube_client import VibetubeError, create_profile, list_profiles
from models.config import RenderConfig


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vibetube", description="Local PNGtuber rendering tool")
    subparsers = parser.add_subparsers(dest="command", required=True)

    render = subparsers.add_parser("render", help="Render an avatar video or frame sequence")
    render.add_argument("--text", help="Path to text file OR inline text content")
    render.add_argument("--input-wav", help="Existing WAV file (skips Vibetube generation)")
    render.add_argument("--avatar", required=True, help="Avatar folder with idle/talk state PNGs")
    render.add_argument("--out", required=True, help="Output directory")
    render.add_argument("--fps", type=int, default=30)
    render.add_argument("--width", type=int, default=512)
    render.add_argument("--height", type=int, default=512)
    render.add_argument("--format", choices=["webm", "png"], default="webm")
    render.add_argument("--vibetube-url", default="http://localhost:17493")
    render.add_argument("--voice-profile-id", help="Vibetube profile id for cloned/custom voice")
    render.add_argument("--voice-language", default=None, help="Vibetube language override (example: en)")
    render.add_argument(
        "--vibetube-start-command",
        default=None,
        help="Command used to start managed Vibetube",
    )
    render.add_argument(
        "--vibetube-workdir",
        default=None,
        help="Working directory for --vibetube-start-command",
    )
    render.add_argument(
        "--vibetube-start-timeout",
        type=float,
        default=45.0,
        help="Seconds to wait for managed Vibetube startup",
    )
    render.add_argument("--no-pytoon", action="store_true", help="Disable optional PyToon enhancement")
    render.add_argument("--window-ms", type=int, default=20, help="RMS analysis window in ms (10-20)")
    render.add_argument("--smoothing-windows", type=int, default=5, help="RMS moving average window count")
    render.add_argument("--on-threshold", type=float, default=0.05, help="RMS threshold to switch to talk")
    render.add_argument("--off-threshold", type=float, default=0.03, help="RMS threshold to switch back to idle")
    render.add_argument("--min-hold-frames", type=int, default=2, help="Consecutive windows required before switching")

    voices = subparsers.add_parser("voices", help="Manage Vibetube voice profiles")
    voices.add_argument("--vibetube-url", default="http://localhost:17493")
    voices_subparsers = voices.add_subparsers(dest="voices_command", required=True)

    voices_subparsers.add_parser("list", help="List available Vibetube profiles")

    create = voices_subparsers.add_parser("create", help="Create a new Vibetube profile")
    create.add_argument("--name", required=True, help="Profile display name")
    create.add_argument("--language", default="en", help="Profile language code")
    create.add_argument("--sample-wav", help="Optional WAV sample to upload after profile creation")
    create.add_argument("--sample-text", help="Optional transcript for sample audio")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "render":
            return _run_render(args)
        if args.command == "voices":
            return _run_voices(args)
        parser.error("Unsupported command")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


def _run_render(args: argparse.Namespace) -> int:
    text = None
    text_path = None
    if args.text:
        possible = Path(args.text)
        if possible.exists() and possible.is_file():
            text_path = possible
        else:
            text = args.text

    auto_start_command, auto_workdir = _resolve_vibetube_start(
        vibetube_url=args.vibetube_url,
        explicit_command=args.vibetube_start_command or os.getenv("VIBETUBE_VIBETUBE_START_COMMAND"),
        explicit_workdir=Path(args.vibetube_workdir) if args.vibetube_workdir else None,
        manage_vibetube=True,
    )

    config = RenderConfig(
        avatar_dir=Path(args.avatar),
        out_dir=Path(args.out),
        fps=args.fps,
        width=args.width,
        height=args.height,
        format=args.format,
        vibetube_url=args.vibetube_url,
        voice_profile_id=args.voice_profile_id,
        voice_language=args.voice_language,
        manage_vibetube=True,
        vibetube_start_command=auto_start_command,
        vibetube_workdir=auto_workdir,
        vibetube_start_timeout_sec=args.vibetube_start_timeout,
        text=text,
        text_path=text_path,
        input_wav=Path(args.input_wav) if args.input_wav else None,
        use_pytoon=not args.no_pytoon,
        window_ms=args.window_ms,
        smoothing_windows=args.smoothing_windows,
        on_threshold=args.on_threshold,
        off_threshold=args.off_threshold,
        min_hold_frames=args.min_hold_frames,
    )

    result = render_job(config)
    print(f"Output directory: {result.out_dir}")
    print(f"Audio: {result.audio_path}")
    if result.video_path:
        print(f"Video: {result.video_path}")
    if result.png_dir:
        print(f"PNG frames: {result.png_dir}")
    if result.captions_path:
        print(f"Captions: {result.captions_path}")
    print(f"Meta: {result.meta_path}")
    return 0


def _run_voices(args: argparse.Namespace) -> int:
    if args.voices_command == "list":
        profiles = list_profiles(vibetube_url=args.vibetube_url)
        if not profiles:
            print("No Vibetube profiles found.")
            return 0
        print("Vibetube profiles:")
        for profile in profiles:
            language = profile.language or "-"
            print(f"- id={profile.profile_id} | name={profile.name} | language={language}")
        return 0

    if args.voices_command == "create":
        sample = Path(args.sample_wav) if args.sample_wav else None
        profile = create_profile(
            vibetube_url=args.vibetube_url,
            name=args.name,
            language=args.language,
            sample_wav=sample,
            transcript=args.sample_text,
        )
        print("Vibetube profile created:")
        print(f"- id={profile.profile_id}")
        print(f"- name={profile.name}")
        print(f"- language={profile.language or '-'}")
        if sample:
            print(f"- sample uploaded from {sample}")
        return 0

    raise VibetubeError(f"Unsupported voices command: {args.voices_command}")


def _resolve_vibetube_start(
    vibetube_url: str,
    explicit_command: str | None,
    explicit_workdir: Path | None,
    manage_vibetube: bool,
) -> tuple[str | None, Path | None]:
    if explicit_command:
        return explicit_command, explicit_workdir
    if not manage_vibetube:
        return None, explicit_workdir

    bundled_root = Path("third_party") / "vibetube"
    bundled_server = bundled_root / "backend" / "server.py"
    if not bundled_server.exists():
        return None, explicit_workdir

    parsed = urlparse(vibetube_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 8000
    command = f"python -m backend.server --host {host} --port {port}"
    return command, bundled_root


if __name__ == "__main__":
    raise SystemExit(main())
