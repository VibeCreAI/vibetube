# Contributing to VibeTube

This document covers the current development workflow for the VibeTube repo.

## Code of Conduct

- Be respectful and constructive.
- Assume good intent and communicate clearly.
- Keep feedback specific and actionable.

## Repo Overview

VibeTube is a multi-part project:

- `app/` shared application UI
- `web/` web runtime
- `tauri/` desktop runtime
- `backend/` FastAPI backend and model orchestration
- `docs/` documentation site
- `scripts/` build and maintenance scripts

## Prerequisites

- [Bun](https://bun.sh)
- [Python 3.11+](https://python.org)
- [Rust](https://rustup.rs) for Tauri development
- Git

Check your versions:

```bash
bun --version
python --version
rustc --version
```

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/VibeCreAI/vibetube.git
cd vibetube
```

### 2. Install JavaScript dependencies

```bash
bun install
```

### 3. Create a Python environment

From the repo root:

```bash
python -m venv .venv
```

Activate it:

```bash
# macOS / Linux
source .venv/bin/activate

# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

Install backend dependencies:

```bash
pip install -r backend/requirements.txt
pip install git+https://github.com/QwenLM/Qwen3-TTS.git
```

Apple Silicon only:

```bash
pip install -r backend/requirements-mlx.txt
```

### 4. Run development servers

Start the backend first:

```bash
python -m uvicorn backend.main:app --host 127.0.0.1 --port 17493 --reload
```

Then run either the web app or the desktop app in a second terminal.

Web:

```bash
bun run dev:web -- --host 127.0.0.1
```

Desktop:

```bash
bun run dev
```

Current development URLs:

- backend: `http://127.0.0.1:17493`
- API docs: `http://127.0.0.1:17493/docs`
- web UI: `http://127.0.0.1:5173`

For a Windows-oriented dev run example, see [DEV_RUN.md](DEV_RUN.md).

## Optional Makefile Workflow

A `Makefile` exists for Unix-like environments. It is optional, not the primary documented path.

Common commands:

```bash
make help
make setup
make dev
make dev-web
make build
```

Windows contributors should use the direct commands above unless working in WSL.

## Models

Models are downloaded on demand and cached locally.

- Qwen3-TTS is used for generation
- Whisper models are used for transcription

First use may take longer because models are downloaded and initialized.

## Building

Build the packaged desktop app:

```bash
bun run build
```

Build only the backend sidecar:

```bash
bun run build:server
```

Build only the web app:

```bash
bun run build:web
```

## API Client Generation

After the backend is running:

```bash
bun run generate:api
```

This regenerates the TypeScript API client in `app/src/lib/api/`.

## Development Workflow

### Branching

```bash
git checkout -b feature/your-change
```

or

```bash
git checkout -b fix/your-fix
```

### While making changes

- Keep changes scoped.
- Follow existing patterns in the area you touch.
- Update docs when behavior or setup changes.
- Prefer current product terminology such as `Characters`, `Generate`, `Stories`, and `Settings` in user-facing copy.

### Before opening a PR

- Run the relevant app flow manually.
- Confirm backend endpoints still behave correctly.
- Run repo checks where relevant.

Useful commands:

```bash
bun run check
bun run lint
bun run format:check
```

If you have backend tests available locally:

```bash
pytest backend/tests -v
```

## Code Style

### TypeScript / React

- Use TypeScript.
- Prefer functional components.
- Prefer named exports.
- Use Biome for formatting and linting.

### Python

- Follow PEP 8.
- Use type hints where practical.
- Use async patterns for I/O-heavy code.

### Rust

- Follow standard Rust conventions.
- Handle errors explicitly.
- Run `rustfmt` when touching Rust code.

## API Changes

When adding or changing backend endpoints:

1. Update routes in `backend/main.py` or the appropriate backend module.
2. Update request/response models in `backend/models.py` when needed.
3. Regenerate the TypeScript client with `bun run generate:api`.
4. Update documentation that references the changed behavior.

## Pull Requests

Include:

- a clear summary of the change
- screenshots for UI changes
- testing notes
- any follow-up work or limitations

PR checklist:

- [ ] Code follows existing style
- [ ] Documentation updated where needed
- [ ] Manually tested
- [ ] Breaking changes called out clearly

## Releases

Releases are managed by maintainers.

The repo includes `.bumpversion.cfg` for version updates:

```bash
bumpversion patch
```

or:

```bash
bumpversion minor
bumpversion major
```

Only use the release flow if you are acting as a maintainer for an actual release.

## Troubleshooting

- Backend will not start: verify Python version, virtual environment activation, and installed backend dependencies.
- Web app cannot reach the backend: confirm the server is running on `127.0.0.1:17493`.
- Tauri dev mode fails: make sure the backend is already running and Rust/Tauri prerequisites are installed.
- API client generation fails: check `http://127.0.0.1:17493/openapi.json`.

## Additional Resources

- [README.md](README.md)
- [DEV_RUN.md](DEV_RUN.md)
- [backend/README.md](backend/README.md)
- [SECURITY.md](SECURITY.md)
- [CHANGELOG.md](CHANGELOG.md)

## License

By contributing, you agree that your contributions will be licensed under the MIT License in [LICENSE](LICENSE).
