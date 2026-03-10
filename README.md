<p align="center">
  <img src=".github/assets/icon-dark.webp" alt="VibeTube" width="120" height="120" />
</p>

# VibeTube

Local-first voice cloning, character creation, story assembly, and talking-character rendering.

> VibeTube started from a fork/vendor of [Voicebox](https://github.com/jamiepine/voicebox). Huge credit to the original project. This repo now evolves that foundation into VibeTube's own workflow and UI.

VibeTube is a local-first app for building voice-driven character content with a React frontend and a FastAPI backend. In development it runs as a web app against a local server; in packaged use it runs as a Tauri desktop app with a bundled backend. The current product centers on Characters, Generate, Stories, and VibeTube rendering, with support for local runtime by default and configurable server connections where needed.

## What VibeTube Includes

### Characters

- Create and edit characters from voice samples
- Attach avatar images and VibeTube avatar state packs
- Import and export voice-profile data where supported
- Assign characters to channels for generation workflows

### Generate

- Generate speech with the Qwen3-TTS-backed workflow
- Reuse saved characters in the main generation flow
- Review generation history and replay outputs locally
- Download generated audio from the app

### Stories

- Build multi-clip, multi-character story compositions
- Arrange clips in a timeline/track editor
- Reuse generated clips inside story workflows
- Keep story editing separate from one-off generations

### VibeTube Rendering

- Render talking-character output from avatar states
- Tune render settings for motion, timing, and output size
- Use background color or uploaded background images
- Support character/video workflows, not just standalone audio

### Transcription and Audio Capture

- Record audio inside the app
- Transcribe audio with Whisper-backed tooling
- Capture system audio where the platform supports it
- Manage model downloads needed for transcription and generation

### Runtime and Model Management

- Bundled backend in packaged desktop builds
- Separate backend process in development
- Model download, status, and cache management
- Local-first operation with configurable server connection settings

## Download

Public download links are not published yet. This section is intentionally left as a placeholder and will be updated once releases are ready.

| Platform | Download |
| --- | --- |
| macOS | TBD |
| Windows | TBD |
| Linux | TBD |

## Development

For full setup and contribution details, see [CONTRIBUTING.md](CONTRIBUTING.md) and [DEV_RUN.md](DEV_RUN.md).

### Quick local run

```bash
# Install JavaScript dependencies
bun install

# Start the backend on http://127.0.0.1:17493
python -m uvicorn backend.main:app --host 127.0.0.1 --port 17493 --reload

# In another terminal, start the web app on http://127.0.0.1:5173
bun run dev:web -- --host 127.0.0.1
```

### Desktop app

```bash
# Starts the Tauri app in development mode
bun run dev
```

In development, the desktop app expects the backend to be started separately. In packaged desktop builds, the backend is bundled and started by the app.

## API

VibeTube exposes a FastAPI backend for the same core workflows used by the app:

- characters / voice profiles
- generation
- transcription
- stories
- models
- active task tracking

When the backend is running locally, interactive API docs are available at:

- `http://127.0.0.1:17493/docs`

## Project Structure

```text
VibeTube/
|-- app/         # Shared application UI
|-- web/         # Web wrapper/runtime
|-- tauri/       # Desktop wrapper/runtime
|-- backend/     # FastAPI backend and model orchestration
|-- docs/        # Documentation site content
|-- scripts/     # Build and maintenance scripts
`-- legacy_cli/  # Archived legacy CLI work
```

## Contributing

Contribution guidelines live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Security reporting information is in [SECURITY.md](SECURITY.md).

## License

VibeTube is released under the MIT License. See [LICENSE](LICENSE).
