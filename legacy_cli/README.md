# VibeTube

VibeTube is a CLI-first local rendering tool for PNGtuber overlays.

Pipeline:
- Text -> Vibetube REST TTS (`voice.wav`) OR existing WAV input.
- Lip-sync timeline via optional PyToon adapter or RMS fallback.
- Streamed avatar frame rendering (`idle.png` / `talk.png` / optional `blink.png`).
- Transparent WebM export (VP9 + alpha) or PNG sequence export.
- Caption generation (`captions.srt`) and metadata (`meta.json`).

## Project Layout

```
/vibetube
  /src
    engine/
      tts/
      lipsync/
      timeline/
      renderer/
      exporter/
      captions/
    cli/
    models/
    utils/
  pyproject.toml
  README.md
  LICENSE
  THIRD_PARTY_NOTICES.md
```

## Install

```bash
pip install -e .
```

Requirements:
- Python 3.10+
- `ffmpeg` on PATH (required for `--format webm`)
- Optional: local Vibetube server (default `http://localhost:17493`; many Vibetube installs use `http://localhost:8000`)
- Optional: `pip install .[pytoon]`

If you cloned from git and want bundled managed Vibetube from submodule:

```bash
git submodule update --init --recursive
```

## Avatar Pack

`--avatar` directory must include:
- `idle.png`
- `talk.png`
- optional `idle_blink.png`
- optional `talk_blink.png`
- optional `blink.png` (legacy fallback when specific blink states are not provided)

## CLI Usage

Render using existing WAV (first implementation mode):

```bash
vibetube render \
  --input-wav ./voice.wav \
  --text ./script.txt \
  --avatar ./avatar_pack \
  --out ./output \
  --fps 30 \
  --width 512 \
  --height 512 \
  --format webm
```

Render with Vibetube TTS:

```bash
vibetube render \
  --text ./script.txt \
  --voice-profile-id <your_profile_id> \
  --avatar ./avatar_pack \
  --out ./output \
  --fps 30 \
  --width 512 \
  --height 512 \
  --format webm \
  --vibetube-url http://localhost:17493
```

Managed Vibetube mode (required for text-to-speech renders):

```bash
vibetube render \
  --text ./script.txt \
  --voice-profile-id <your_profile_id> \
  --avatar ./avatar_pack \
  --out ./output \
  --vibetube-url http://localhost:17493
```

When `third_party/vibetube` is present, VibeTube auto-uses:
`python -m backend.server --host <host> --port <port>` with `third_party/vibetube` as working directory.
If Vibetube is already running externally on the same URL, VibeTube will fail fast so startup stays app-managed.

You can also set the start command once:

```bash
set VIBETUBE_VIBETUBE_START_COMMAND=python -m backend.server --host 127.0.0.1 --port 17493
```

List Vibetube profiles:

```bash
vibetube voices list --vibetube-url http://localhost:17493
```

Create a Vibetube profile:

```bash
vibetube voices create --name "Sam Clone" --language en --vibetube-url http://localhost:17493
```

Create a profile and attempt sample upload:

```bash
vibetube voices create \
  --name "Sam Clone" \
  --language en \
  --sample-wav ./sample.wav \
  --sample-text "optional transcript" \
  --vibetube-url http://localhost:17493
```

PNG sequence export:

```bash
vibetube render --input-wav ./voice.wav --avatar ./avatar_pack --out ./output --format png
```

## Engine API

Core API exposed for future UI layers:

```python
from engine.job import render_job
from models.config import RenderConfig

result = render_job(RenderConfig(
    avatar_dir=Path("./avatar_pack"),
    out_dir=Path("./output"),
    input_wav=Path("./voice.wav"),
    text_path=Path("./script.txt"),
))
```

The CLI only parses args and calls `render_job(config)`.

## Output Artifacts

- `voice.wav`
- `avatar.webm` (if `--format webm`) or `frames/*.png` (if `--format png`)
- `captions.srt` (when text is provided)
- `timeline.json`
- `meta.json`

## Notes

- Frame rendering and WebM export are streamed; full frame sets are not kept in RAM.
- RMS lip-sync uses 10-20ms windows, smoothing, hysteresis, and hold logic to reduce flicker.
- Vibetube failures are reported with actionable error messages.
- Managed Vibetube mode starts a background Vibetube process and waits for API readiness.

