<p align="center">
  <img src=".github/assets/icon-dark.webp" alt="VibeTube" width="120" height="120" />
</p>

<h1 align="center">VibeTube</h1>

<p align="center">
  <strong>The open-source voice synthesis studio.</strong><br/>
  Clone voices. Generate speech. Build voice-powered apps.<br/>
  All running locally on your machine.
</p>

<p align="center">
  <a href="https://github.com/jamiepine/VibeTube/releases">
    <img src="https://img.shields.io/github/downloads/jamiepine/VibeTube/total?style=flat&color=blue" alt="Downloads" />
  </a>
  <a href="https://github.com/jamiepine/VibeTube/releases/latest">
    <img src="https://img.shields.io/github/v/release/jamiepine/VibeTube?style=flat" alt="Release" />
  </a>
  <a href="https://github.com/jamiepine/VibeTube/stargazers">
    <img src="https://img.shields.io/github/stars/jamiepine/VibeTube?style=flat" alt="Stars" />
  </a>
  <a href="https://github.com/jamiepine/VibeTube/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/jamiepine/VibeTube?style=flat" alt="License" />
  </a>
</p>

<p align="center">
  <a href="https://VibeTube.sh">VibeTube.sh</a> â€¢
  <a href="#download">Download</a> â€¢
  <a href="#features">Features</a> â€¢
  <a href="#api">API</a> â€¢
  <a href="#roadmap">Roadmap</a>
</p>

<br/>

<p align="center">
  <a href="https://VibeTube.sh">
    <img src="landing/public/assets/app-screenshot-1.webp" alt="VibeTube App Screenshot" width="800" />
  </a>
</p>

<p align="center">
  <em>Click the image above to watch the demo video on <a href="https://VibeTube.sh">VibeTube.sh</a></em>
</p>

<br/>

<p align="center">
  <img src="landing/public/assets/app-screenshot-2.webp" alt="VibeTube Screenshot 2" width="800" />
</p>

<p align="center">
  <img src="landing/public/assets/app-screenshot-3.webp" alt="VibeTube Screenshot 3" width="800" />
</p>

<br/>

## What is VibeTube?

VibeTube is a **local-first voice cloning studio** with DAW-like features for professional voice synthesis. Think of it as a **local, free and open-source alternative to ElevenLabs** â€” download models, clone voices, and generate speech entirely on your machine.

Unlike cloud services that lock your voice data behind subscriptions, VibeTube gives you:

- **Complete privacy** â€” models and voice data stay on your machine
- **Professional tools** â€” multi-track timeline editor, audio trimming, conversation mixing
- **Model flexibility** â€” currently powered by Qwen3-TTS, with support for XTTS, Bark, and other models coming soon
- **API-first** â€” use the desktop app or integrate voice synthesis into your own projects
- **Native performance** â€” built with Tauri (Rust), not Electron
- **Super fast on Mac** â€” MLX backend with native Metal acceleration for 4-5x faster inference on Apple Silicon

Download a voice model, clone any voice from a few seconds of audio, and compose multi-voice projects with studio-grade editing tools. No Python install required, no cloud dependency, no limits.

---

## Download

VibeTube is available now for macOS and Windows.

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | [VibeTube_aarch64.app.tar.gz](https://github.com/jamiepine/VibeTube/releases/latest/download/VibeTube_aarch64.app.tar.gz) |
| macOS (Intel) | [VibeTube_x64.app.tar.gz](https://github.com/jamiepine/VibeTube/releases/latest/download/VibeTube_x64.app.tar.gz) |
| Windows (MSI) | [Latest Windows MSI](https://github.com/jamiepine/VibeTube/releases/latest) |
| Windows (Setup) | [Latest Windows Setup](https://github.com/jamiepine/VibeTube/releases/latest) |

> **Linux builds coming soon** â€” Currently blocked by GitHub runner disk space limitations.

---

## Features

### Voice Cloning with Qwen3-TTS

Powered by Alibaba's **Qwen3-TTS** â€” a breakthrough model that achieves near-perfect voice cloning from just a few seconds of audio.

- **Instant cloning** â€” Upload a sample, get a voice profile
- **High fidelity** â€” Natural prosody, emotion, and cadence
- **Multi-language** â€” English, Chinese, and more coming
- **Lightning fast on Mac** â€” MLX backend leverages Apple Silicon's Neural Engine for super fast generation

### Voice Profile Management

- **Create profiles** from audio files or record directly in-app
- **Import/Export** profiles to share or backup
- **Multi-sample support** â€” combine multiple samples for higher quality cloning
- **Organize** with descriptions and language tags

### Speech Generation

- **Text-to-speech** with any cloned voice
- **Batch generation** for long-form content
- **Smart caching** â€” regenerate instantly with voice prompt caching

### Stories Editor

Create multi-voice narratives, podcasts, and conversations with a timeline-based editor.

- **Multi-track composition** â€” arrange multiple voice tracks in a single project
- **Inline audio editing** â€” trim and split clips directly in the timeline
- **Auto-playback** â€” preview stories with synchronized playhead
- **Voice mixing** â€” build conversations with multiple participants

### Recording & Transcription

- **In-app recording** with waveform visualization
- **System audio capture** â€” record desktop audio on macOS and Windows
- **Automatic transcription** powered by Whisper
- **Export recordings** in multiple formats

### Generation History

- **Full history** of all generated audio
- **Search & filter** by voice, text, or date
- **Re-generate** any past generation with one click

### Flexible Deployment

- **Local mode** â€” Everything runs on your machine
- **Remote mode** â€” Connect to a GPU server on your network
- **One-click server** â€” Turn any machine into a VibeTube server

---

## API

VibeTube exposes a full REST API, so you can integrate voice synthesis into your own apps.

```bash
# Generate speech
curl -X POST http://localhost:8000/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "profile_id": "abc123", "language": "en"}'

# List voice profiles
curl http://localhost:8000/profiles

# Create a profile
curl -X POST http://localhost:8000/profiles \
  -H "Content-Type: application/json" \
  -d '{"name": "My Voice", "language": "en"}'
```

**Use cases:**

- Game dialogue systems
- Podcast/video production pipelines
- Accessibility tools
- Voice assistants
- Content creation automation

Full API documentation available at `http://localhost:8000/docs` when running.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop App | Tauri (Rust) |
| Frontend | React, TypeScript, Tailwind CSS |
| State | Zustand, React Query |
| Backend | FastAPI (Python) |
| Voice Model | Qwen3-TTS (PyTorch or MLX) |
| Transcription | Whisper (PyTorch or MLX) |
| Inference Engine | MLX (Apple Silicon) / PyTorch (Windows/Linux/Intel) |
| Database | SQLite |
| Audio | WaveSurfer.js, librosa |

**Why this stack?**

- **Tauri over Electron** â€” 10x smaller bundle, native performance, lower memory
- **FastAPI** â€” Async Python with automatic OpenAPI schema generation
- **Type-safe end-to-end** â€” Generated TypeScript client from OpenAPI spec

---

## Roadmap

VibeTube is the beginning of something bigger. Here's what's coming:

### Coming Soon

| Feature | Description |
|---------|-------------|
| **Real-time Synthesis** | Stream audio as it generates, word by word |
| **Conversation Mode** | Multi-speaker dialogues with automatic turn-taking |
| **Voice Effects** | Pitch shift, reverb, M3GAN-style effects |
| **Timeline Editor** | Audio studio with word-level precision editing |
| **More Models** | XTTS, Bark, and other open-source voice models |

### Future Vision

- **Voice Design** â€” Create new voices from text descriptions
- **Project System** â€” Save and load complex multi-voice sessions
- **Plugin Architecture** â€” Extend with custom models and effects
- **Mobile Companion** â€” Control VibeTube from your phone

VibeTube aims to be the **one-stop shop for everything voice** â€” cloning, synthesis, editing, effects, and beyond.

---

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed setup and contribution guidelines.

**Using the Makefile (recommended):** Run `make help` to see all available commands for setup, development, building, and testing.

### Quick Start

**With Makefile (Unix/macOS/Linux):**

```bash
# Clone the repo
git clone https://github.com/jamiepine/VibeTube.git
cd VibeTube

# Setup everything
make setup

# Start development
make dev
```

**Manual setup (all platforms):**

```bash
# Clone the repo
git clone https://github.com/jamiepine/VibeTube.git
cd VibeTube

# Install dependencies
bun install

# Install Python dependencies
cd backend && pip install -r requirements.txt && cd ..

# Start development
bun run dev
```

**Prerequisites:** [Bun](https://bun.sh), [Rust](https://rustup.rs), [Python 3.11+](https://python.org). [XCode on macOS](https://developer.apple.com/xcode/).

**Performance:** 
- **Apple Silicon (M1/M2/M3)**: Uses MLX backend with native Metal acceleration for 4-5x faster inference
- **Windows/Linux/Intel Mac**: Uses PyTorch backend (CUDA GPU recommended, CPU supported but slower)

### Project Structure

```
VibeTube/
â”œâ”€â”€ app/              # Shared React frontend
â”œâ”€â”€ tauri/            # Desktop app (Tauri + Rust)
â”œâ”€â”€ web/              # Web deployment
â”œâ”€â”€ backend/          # Python FastAPI server
â”œâ”€â”€ landing/          # Marketing website
â””â”€â”€ scripts/          # Build & release scripts
```

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Submit a PR

## Security

Found a security vulnerability? Please report it responsibly. See [SECURITY.md](SECURITY.md) for details.

---

## License

MIT License â€” see [LICENSE](LICENSE) for details.

---

<p align="center">
  <a href="https://VibeTube.sh">VibeTube.sh</a>
</p>
