"""
LuxTTS backend implementation.

Wraps the LuxTTS (ZipVoice) model for zero-shot voice cloning.
"""

import asyncio
import logging
import tempfile
from typing import Optional, Tuple

import numpy as np

from .base import (
    combine_voice_prompts as _combine_voice_prompts,
    force_hf_offline_if_cached,
    get_torch_device,
    is_model_cached,
    model_load_progress,
)
from ..utils.audio import load_audio, save_audio
from ..utils.cache import cache_voice_prompt, get_cache_key, get_cached_voice_prompt

logger = logging.getLogger(__name__)

LUXTTS_HF_REPO = "YatharthS/LuxTTS"
LUXTTS_WHISPER_DEP_REPO = "openai/whisper-tiny"


class LuxTTSBackend:
    """LuxTTS backend for zero-shot voice cloning."""

    def __init__(self):
        self.model = None
        self.model_size = "default"
        self._device = None

    def _get_device(self):
        return get_torch_device(allow_mps=True)

    @property
    def device(self):
        if self._device is None:
            self._device = self._get_device()
        return self._device

    def is_loaded(self) -> bool:
        return self.model is not None

    def _get_model_path(self, model_size: str = "default") -> str:
        return LUXTTS_HF_REPO

    def _is_model_cached(self, model_size: str = "default") -> bool:
        core_cached = is_model_cached(
            LUXTTS_HF_REPO,
            weight_extensions=(".pt", ".safetensors", ".onnx", ".bin"),
        )
        if not core_cached:
            return False
        # ZipVoice internally depends on Whisper Tiny for prompt transcription.
        return is_model_cached(
            LUXTTS_WHISPER_DEP_REPO,
            weight_extensions=(".safetensors", ".bin", ".pt"),
        )

    async def load_model(self, model_size: str = "default") -> None:
        if self.model is not None:
            return
        await asyncio.to_thread(self._load_model_sync)

    def _load_model_sync(self):
        model_name = "luxtts"
        is_cached = self._is_model_cached()

        with model_load_progress(model_name, is_cached):
            from zipvoice.luxvoice import LuxTTS

            device = self.device
            logger.info("Loading LuxTTS on %s...", device)
            with force_hf_offline_if_cached(is_cached):
                if device == "cpu":
                    import os

                    threads = os.cpu_count() or 4
                    self.model = LuxTTS(
                        model_path=LUXTTS_HF_REPO,
                        device="cpu",
                        threads=min(threads, 8),
                    )
                else:
                    self.model = LuxTTS(model_path=LUXTTS_HF_REPO, device=device)

        logger.info("LuxTTS loaded successfully")

    def unload_model(self) -> None:
        if self.model is not None:
            del self.model
            self.model = None

            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            logger.info("LuxTTS unloaded")

    async def create_voice_prompt(
        self,
        audio_path: str,
        reference_text: str,
        use_cache: bool = True,
    ) -> Tuple[dict, bool]:
        await self.load_model()
        cache_key = ("luxtts_" + get_cache_key(audio_path, reference_text)) if use_cache else None

        if cache_key:
            cached = get_cached_voice_prompt(cache_key)
            if cached is not None and isinstance(cached, dict):
                return cached, True

        def _encode_sync():
            prompt_path = str(audio_path)
            temp_prompt_path: Optional[str] = None
            try:
                # LuxTTS can fail in some environments when extremely short/poorly decoded
                # references produce too few frames for downstream conv kernels.
                audio, sr = load_audio(prompt_path, sample_rate=24000, mono=True)
                min_prompt_samples = int(sr * 0.75)
                if audio.size < min_prompt_samples:
                    logger.warning(
                        "LuxTTS reference prompt is very short (%d samples); padding to %d samples",
                        audio.size,
                        min_prompt_samples,
                    )
                    padded = np.pad(audio.astype(np.float32), (0, min_prompt_samples - audio.size))
                    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
                        temp_prompt_path = tmp_file.name
                    save_audio(padded, temp_prompt_path, sr)
                    prompt_path = temp_prompt_path

                return self.model.encode_prompt(prompt_audio=prompt_path, duration=5, rms=0.01)
            except RuntimeError as exc:
                message = str(exc)
                if "Kernel size can't be greater than actual input size" in message:
                    raise ValueError(
                        "LuxTTS could not process the reference sample. "
                        "Try a longer clean WAV sample (2-30 seconds)."
                    ) from exc
                raise
            finally:
                if temp_prompt_path:
                    try:
                        import os

                        os.unlink(temp_prompt_path)
                    except OSError:
                        pass

        encoded = await asyncio.to_thread(_encode_sync)

        if cache_key:
            cache_voice_prompt(cache_key, encoded)

        return encoded, False

    async def combine_voice_prompts(self, audio_paths, reference_texts):
        return await _combine_voice_prompts(audio_paths, reference_texts, sample_rate=24000)

    async def generate(
        self,
        text: str,
        voice_prompt: dict,
        language: str = "en",
        seed: Optional[int] = None,
        instruct: Optional[str] = None,
    ) -> Tuple[np.ndarray, int]:
        await self.load_model()

        def _generate_sync():
            import torch

            if seed is not None:
                torch.manual_seed(seed)
                if torch.cuda.is_available():
                    torch.cuda.manual_seed(seed)

            try:
                wav = self.model.generate_speech(
                    text=text,
                    encode_dict=voice_prompt,
                    num_steps=4,
                    guidance_scale=3.0,
                    t_shift=0.5,
                    speed=1.0,
                    return_smooth=False,
                )
            except RuntimeError as exc:
                message = str(exc)
                if "Kernel size can't be greater than actual input size" in message:
                    raise ValueError(
                        "LuxTTS generation failed on this input. "
                        "Try longer text and confirm the reference sample is at least 2 seconds."
                    ) from exc
                raise
            if isinstance(wav, torch.Tensor):
                audio = wav.squeeze().detach().cpu().numpy().astype(np.float32)
            else:
                audio = np.asarray(wav, dtype=np.float32).squeeze()
            if audio.size == 0:
                raise ValueError("LuxTTS generated empty audio output")
            if not np.isfinite(audio).all():
                raise ValueError("LuxTTS generated invalid audio values")
            return audio, 48000

        return await asyncio.to_thread(_generate_sync)
