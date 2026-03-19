import numpy as np
import pytest
from unittest.mock import AsyncMock

from backend.backends.luxtts_backend import LuxTTSBackend

pytestmark = pytest.mark.asyncio


class _FailingLuxModel:
    def encode_prompt(self, *args, **kwargs):
        raise RuntimeError(
            "Calculated padded input size per channel: (6). Kernel size: (7). "
            "Kernel size can't be greater than actual input size"
        )

    def generate_speech(self, *args, **kwargs):
        raise RuntimeError(
            "Calculated padded input size per channel: (6). Kernel size: (7). "
            "Kernel size can't be greater than actual input size"
        )


async def test_luxtts_create_voice_prompt_maps_kernel_error(monkeypatch):
    backend = LuxTTSBackend()
    backend.model = _FailingLuxModel()
    backend.load_model = AsyncMock(return_value=None)

    monkeypatch.setattr(
        "backend.backends.luxtts_backend.load_audio",
        lambda *args, **kwargs: (np.zeros(100, dtype=np.float32), 24000),
    )
    monkeypatch.setattr("backend.backends.luxtts_backend.save_audio", lambda *args, **kwargs: None)

    with pytest.raises(ValueError, match="could not process the reference sample"):
        await backend.create_voice_prompt("dummy.wav", "hello world", use_cache=False)


async def test_luxtts_generate_maps_kernel_error(monkeypatch):
    backend = LuxTTSBackend()
    backend.model = _FailingLuxModel()
    backend.load_model = AsyncMock(return_value=None)

    with pytest.raises(ValueError, match="generation failed on this input"):
        await backend.generate("short text", voice_prompt={"dummy": True})

