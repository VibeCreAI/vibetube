"""
PyInstaller build script for creating standalone Python server binary.
"""

import os
import platform
import subprocess
import sys
import importlib
from pathlib import Path

import PyInstaller.__main__


def is_apple_silicon():
    """Check if running on Apple Silicon."""
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def ensure_optional_engine_dependencies():
    """
    Ensure optional runtime engine packages are present before bundling.

    Chatterbox is installed without dependencies to avoid conflicting pin sets;
    required sub-dependencies are already covered in backend/requirements.txt.
    """

    def _install_if_missing(module_name: str, pip_args: list[str]) -> None:
        try:
            importlib.import_module(module_name)
            return
        except ModuleNotFoundError:
            print(f"Missing {module_name}; installing {' '.join(pip_args)}")

        subprocess.check_call([sys.executable, "-m", "pip", "install", *pip_args])
        importlib.import_module(module_name)

    _install_if_missing("chatterbox", ["--no-deps", "chatterbox-tts"])


def build_server():
    """Build Python server as standalone binary."""
    backend_dir = Path(__file__).parent

    ensure_optional_engine_dependencies()

    # PyInstaller arguments
    args = [
        'server.py',  # Use server.py as entry point instead of main.py
        '--onefile',
        '--name', 'vibetube-server',
    ]

    # Add local qwen_tts path if specified (for editable installs)
    qwen_tts_path = os.getenv('QWEN_TTS_PATH')
    if qwen_tts_path and Path(qwen_tts_path).exists():
        args.extend(['--paths', str(qwen_tts_path)])
        print(f"Using local qwen_tts source from: {qwen_tts_path}")

    # Add common hidden imports
    args.extend([
        '--hidden-import', 'backend',
        '--hidden-import', 'backend.main',
        '--hidden-import', 'backend.config',
        '--hidden-import', 'backend.database',
        '--hidden-import', 'backend.models',
        '--hidden-import', 'backend.profiles',
        '--hidden-import', 'backend.history',
        '--hidden-import', 'backend.tts',
        '--hidden-import', 'backend.transcribe',
        '--hidden-import', 'backend.platform_detect',
        '--hidden-import', 'backend.backends',
        '--hidden-import', 'backend.backends.base',
        '--hidden-import', 'backend.backends.pytorch_backend',
        '--hidden-import', 'backend.backends.luxtts_backend',
        '--hidden-import', 'backend.backends.chatterbox_backend',
        '--hidden-import', 'backend.backends.chatterbox_turbo_backend',
        '--hidden-import', 'backend.utils.audio',
        '--hidden-import', 'backend.utils.cache',
        '--hidden-import', 'backend.utils.chunked_tts',
        '--hidden-import', 'backend.utils.progress',
        '--hidden-import', 'backend.utils.hf_progress',
        '--hidden-import', 'backend.utils.validation',
        '--hidden-import', 'pedalboard',
        '--hidden-import', 'chatterbox',
        '--hidden-import', 'chatterbox.tts_turbo',
        '--hidden-import', 'chatterbox.mtl_tts',
        '--hidden-import', 'zipvoice',
        '--hidden-import', 'zipvoice.luxvoice',
        '--hidden-import', 'torch',
        '--hidden-import', 'transformers',
        '--hidden-import', 'fastapi',
        '--hidden-import', 'uvicorn',
        '--hidden-import', 'sqlalchemy',
        '--collect-all', 'lazy_loader',
        '--collect-all', 'librosa',
        '--hidden-import', 'soundfile',
        '--hidden-import', 'qwen_tts',
        '--hidden-import', 'qwen_tts.inference',
        '--hidden-import', 'qwen_tts.inference.qwen3_tts_model',
        '--hidden-import', 'qwen_tts.inference.qwen3_tts_tokenizer',
        '--hidden-import', 'qwen_tts.core',
        '--hidden-import', 'qwen_tts.cli',
        '--copy-metadata', 'qwen-tts',
        '--copy-metadata', 'requests',
        '--copy-metadata', 'transformers',
        '--copy-metadata', 'huggingface-hub',
        '--copy-metadata', 'tokenizers',
        '--copy-metadata', 'safetensors',
        '--copy-metadata', 'tqdm',
        '--hidden-import', 'requests',
        '--collect-submodules', 'qwen_tts',
        '--collect-all', 'qwen_tts',
        '--collect-data', 'qwen_tts',
        '--collect-all', 'zipvoice',
        '--collect-all', 'linacodec',
        # Fix for pkg_resources and jaraco namespace packages
        '--hidden-import', 'pkg_resources.extern',
        '--collect-submodules', 'jaraco',
        '--collect-all', 'inflect',
        '--collect-all', 'perth',
        '--collect-all', 'piper_phonemize',
    ])

    # Add MLX-specific imports if building on Apple Silicon
    if is_apple_silicon():
        print("Building for Apple Silicon - including MLX dependencies")
        args.extend([
            '--hidden-import', 'backend.backends.mlx_backend',
            '--hidden-import', 'mlx',
            '--hidden-import', 'mlx.core',
            '--hidden-import', 'mlx.nn',
            '--hidden-import', 'mlx_audio',
            '--hidden-import', 'mlx_audio.tts',
            '--hidden-import', 'mlx_audio.stt',
            '--collect-submodules', 'mlx',
            '--collect-submodules', 'mlx_audio',
            # Use --collect-all so PyInstaller bundles both data files AND
            # native shared libraries (.dylib, .metallib) for MLX.
            # Previously only --collect-data was used, which caused MLX to
            # raise OSError at runtime inside the bundled binary because
            # the Metal shader libraries were missing.
            '--collect-all', 'mlx',
            '--collect-all', 'mlx_audio',
        ])
    else:
        print("Building for non-Apple Silicon platform - PyTorch only")

    args.extend([
        '--noconfirm',
        '--clean',
    ])

    # Change to backend directory
    os.chdir(backend_dir)
    
    # Run PyInstaller
    PyInstaller.__main__.run(args)
    
    print(f"Binary built in {backend_dir / 'dist' / 'vibetube-server'}")


if __name__ == '__main__':
    build_server()

