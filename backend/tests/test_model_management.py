from pathlib import Path

from backend.backends import get_model_config
from backend.services import model_management


def _repo_cache_dir(base: Path, repo_id: str) -> Path:
    return base / ("models--" + repo_id.replace("/", "--"))


def _write_cached_repo(base: Path, repo_id: str, weight_name: str) -> None:
    repo_dir = _repo_cache_dir(base, repo_id)
    snapshot_dir = repo_dir / "snapshots" / "test-snapshot"
    blobs_dir = repo_dir / "blobs"
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    blobs_dir.mkdir(parents=True, exist_ok=True)
    (snapshot_dir / "config.json").write_text("{}", encoding="utf-8")
    (snapshot_dir / weight_name).write_bytes(b"weights")


def test_luxtts_download_requires_whisper_dependency(monkeypatch, tmp_path: Path):
    luxtts = get_model_config("luxtts")
    assert luxtts is not None

    def fake_get_model_cache_dir(repo_id: str):
        return _repo_cache_dir(tmp_path, repo_id)

    monkeypatch.setattr(model_management, "get_model_cache_dir", fake_get_model_cache_dir)

    # Core LuxTTS files present.
    _write_cached_repo(tmp_path, luxtts.hf_repo_id, "model.pt")

    downloaded, size_mb = model_management.is_model_downloaded(luxtts)
    assert downloaded is False
    assert size_mb is None


def test_luxtts_download_true_when_dependency_present(monkeypatch, tmp_path: Path):
    luxtts = get_model_config("luxtts")
    assert luxtts is not None

    def fake_get_model_cache_dir(repo_id: str):
        return _repo_cache_dir(tmp_path, repo_id)

    monkeypatch.setattr(model_management, "get_model_cache_dir", fake_get_model_cache_dir)

    _write_cached_repo(tmp_path, luxtts.hf_repo_id, "model.pt")
    _write_cached_repo(tmp_path, model_management.LUXTTS_WHISPER_DEP_REPO, "model.safetensors")

    downloaded, size_mb = model_management.is_model_downloaded(luxtts)
    assert downloaded is True
    assert size_mb is not None and size_mb > 0


def test_non_luxtts_download_check_unchanged(monkeypatch, tmp_path: Path):
    qwen = get_model_config("qwen-tts-1.7B")
    assert qwen is not None

    def fake_get_model_cache_dir(repo_id: str):
        return _repo_cache_dir(tmp_path, repo_id)

    monkeypatch.setattr(model_management, "get_model_cache_dir", fake_get_model_cache_dir)

    _write_cached_repo(tmp_path, qwen.hf_repo_id, "model.safetensors")

    downloaded, size_mb = model_management.is_model_downloaded(qwen)
    assert downloaded is True
    assert size_mb is not None and size_mb > 0


def test_normalize_model_load_error_for_hf_401():
    qwen = get_model_config("qwen-tts-0.6B")
    assert qwen is not None

    exc = RuntimeError(
        "401 Client Error: Unauthorized for url: "
        "https://huggingface.co/api/models/Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    )

    message = model_management.normalize_model_load_error(qwen, exc)
    assert "401 Unauthorized" in message
    assert "HF_TOKEN" in message
    assert qwen.hf_repo_id in message


def test_normalize_model_load_error_for_offline_mode():
    qwen = get_model_config("qwen-tts-1.7B")
    assert qwen is not None

    exc = RuntimeError(
        "Cannot reach https://huggingface.co/api/models/Qwen/Qwen3-TTS-12Hz-1.7B-Base: "
        "offline mode is enabled. To disable it, please unset the `HF_HUB_OFFLINE` environment variable."
    )

    message = model_management.normalize_model_load_error(qwen, exc)
    assert "Offline mode is enabled" in message
    assert "HF_HUB_OFFLINE" in message
