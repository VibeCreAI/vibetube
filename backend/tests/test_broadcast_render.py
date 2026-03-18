import asyncio
import json
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient

from backend import main


class _FakeQuery:
    def __init__(self, result):
        self._result = result

    def filter_by(self, **_kwargs):
        return self

    def first(self):
        return self._result


class _FakeDB:
    def __init__(self, profile=None, generation=None):
        self.profile = profile
        self.generation = generation

    def query(self, model):
        if model is main.DBVoiceProfile:
            return _FakeQuery(self.profile)
        if model is main.DBGeneration:
            return _FakeQuery(self.generation)
        raise AssertionError(f"Unexpected model query: {model}")


def _override_db(fake_db):
    def _get_db():
        yield fake_db

    return _get_db


def _write_complete_pack(pack_dir: Path):
    pack_dir.mkdir(parents=True, exist_ok=True)
    for state in ("idle", "talk", "idle_blink", "talk_blink"):
        (pack_dir / f"{state}.png").write_bytes(b"png")


def test_render_audio_requires_multipart_fields():
    main.app.dependency_overrides[main.get_db] = _override_db(_FakeDB())
    client = TestClient(main.app)
    try:
        response = client.post("/vibetube/render-audio", data={})
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 422


def test_render_audio_rejects_incomplete_avatar_pack(monkeypatch, tmp_path):
    profile = type("Profile", (), {"id": "profile-1", "name": "Streamer"})()
    fake_db = _FakeDB(profile=profile)
    data_dir = tmp_path / "data"
    pack_dir = tmp_path / "profiles" / profile.id / "vibetube_avatar"

    monkeypatch.setattr(main.config, "get_data_dir", lambda: data_dir)
    monkeypatch.setattr(main, "_vibetube_avatar_pack_dir", lambda _profile_id: pack_dir)

    main.app.dependency_overrides[main.get_db] = _override_db(fake_db)
    client = TestClient(main.app)
    try:
        response = client.post(
            "/vibetube/render-audio",
            data={"profile_id": profile.id},
            files={"audio": ("sample.wav", BytesIO(b"wav-bytes"), "audio/wav")},
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 400
    assert "complete 4-state VibeTube avatar pack" in response.json()["detail"]


def test_render_audio_creates_broadcast_job(monkeypatch, tmp_path):
    profile = type("Profile", (), {"id": "profile-1", "name": "Streamer"})()
    fake_db = _FakeDB(profile=profile)
    data_dir = tmp_path / "data"
    pack_dir = tmp_path / "profiles" / profile.id / "vibetube_avatar"
    _write_complete_pack(pack_dir)

    monkeypatch.setattr(main.config, "get_data_dir", lambda: data_dir)
    monkeypatch.setattr(main, "_vibetube_avatar_pack_dir", lambda _profile_id: pack_dir)

    def _fake_render_overlay(*, output_dir: Path, text=None, **_kwargs):
        output_dir.mkdir(parents=True, exist_ok=True)
        video_path = output_dir / "avatar.webm"
        timeline_path = output_dir / "timeline.json"
        meta_path = output_dir / "meta.json"
        captions_path = output_dir / "captions.srt"

        video_path.write_bytes(b"webm")
        timeline_path.write_text("{}", encoding="utf-8")
        meta_path.write_text(json.dumps({"duration_sec": 1.25}), encoding="utf-8")
        captions_path.write_text(text or "", encoding="utf-8")

        return {
            "video_path": str(video_path),
            "timeline_path": str(timeline_path),
            "captions_path": str(captions_path),
            "meta_path": str(meta_path),
            "duration_sec": 1.25,
            "contains_transparency": True,
            "alpha_verified": True,
            "preferred_export_format": "webm",
        }

    monkeypatch.setattr(main.vibetube, "render_overlay", _fake_render_overlay)

    main.app.dependency_overrides[main.get_db] = _override_db(fake_db)
    client = TestClient(main.app)
    try:
        response = client.post(
            "/vibetube/render-audio",
            data={
                "profile_id": profile.id,
                "caption_text": "hello broadcast",
                "subtitle_enabled": "true",
            },
            files={"audio": ("sample.wav", BytesIO(b"wav-bytes"), "audio/wav")},
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["source_kind"] == "broadcast_recording"
    assert payload["source_profile_id"] == profile.id
    assert payload["preferred_export_format"] == "webm"

    meta = json.loads(Path(payload["meta_path"]).read_text(encoding="utf-8"))
    assert meta["source_kind"] == "broadcast_recording"
    assert meta["source_profile_id"] == profile.id
    assert meta["source_profile_name"] == profile.name
    assert meta["source_text_preview"] == "hello broadcast"


def test_list_vibetube_jobs_backfills_source_kind(monkeypatch, tmp_path):
    jobs_root = tmp_path / "data" / "vibetube"
    story_job = jobs_root / "story-job"
    generation_job = jobs_root / "generation-job"
    broadcast_job = jobs_root / "broadcast-job"

    for job_dir, meta in (
        (story_job, {"source_story_id": "story-1"}),
        (generation_job, {"source_generation_id": "generation-1"}),
        (
            broadcast_job,
            {"source_kind": "broadcast_recording", "source_profile_id": "profile-1"},
        ),
    ):
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "avatar.webm").write_bytes(b"webm")
        (job_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    monkeypatch.setattr(main.config, "get_data_dir", lambda: tmp_path / "data")

    jobs = asyncio.run(main.list_vibetube_jobs(_FakeDB()))
    jobs_by_id = {job.job_id: job for job in jobs}

    assert jobs_by_id["story-job"].source_kind == "story"
    assert jobs_by_id["generation-job"].source_kind == "generation"
    assert jobs_by_id["broadcast-job"].source_kind == "broadcast_recording"
    assert jobs_by_id["broadcast-job"].source_profile_id == "profile-1"
