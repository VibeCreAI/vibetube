from backend.utils.tasks import TaskManager


def test_error_download_removes_active_task():
    manager = TaskManager()
    manager.start_download("qwen-tts-0.6B")

    assert manager.is_download_active("qwen-tts-0.6B")

    manager.error_download("qwen-tts-0.6B", "401 unauthorized")

    assert not manager.is_download_active("qwen-tts-0.6B")
    assert manager.get_active_downloads() == []
