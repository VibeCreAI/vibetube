from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Optional

import requests


class VibetubeManagerError(RuntimeError):
    """Raised when managed Vibetube startup fails."""


def ensure_vibetube_ready(
    vibetube_url: str,
    logger,
    manage_vibetube: bool = False,
    start_command: str | None = None,
    workdir: Path | None = None,
    timeout_sec: float = 45.0,
) -> Optional[subprocess.Popen]:
    if not manage_vibetube:
        raise VibetubeManagerError(
            "Managed Vibetube mode is required for TTS renders. "
            "Enable --manage-vibetube."
        )

    if not start_command:
        raise VibetubeManagerError(
            "Managed Vibetube is enabled but no start command was provided. "
            "Set --vibetube-start-command."
        )

    if _is_vibetube_reachable(vibetube_url):
        raise VibetubeManagerError(
            f"Vibetube is already running at {vibetube_url}. "
            "Stop external Vibetube first so VibeTube can manage startup itself."
        )

    logger.info("Vibetube not reachable. Starting managed Vibetube process.")
    process = subprocess.Popen(
        start_command,
        shell=True,
        cwd=str(workdir) if workdir else None,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    deadline = time.time() + max(1.0, timeout_sec)
    while time.time() < deadline:
        if process.poll() is not None:
            raise VibetubeManagerError(
                "Managed Vibetube process exited before becoming healthy. "
                f"Command: {start_command}"
            )
        if _is_vibetube_reachable(vibetube_url):
            logger.info("Managed Vibetube is ready at %s", vibetube_url)
            return process
        time.sleep(1.0)

    raise VibetubeManagerError(
        "Timed out waiting for managed Vibetube startup "
        f"after {timeout_sec:.1f}s at {vibetube_url}."
    )


def _is_vibetube_reachable(vibetube_url: str) -> bool:
    base = vibetube_url.rstrip("/")
    probes = (
        f"{base}/health",
        f"{base}/profiles",
        f"{base}/docs",
    )

    for url in probes:
        try:
            response = requests.get(url, timeout=2.5)
            if response.status_code < 500:
                return True
        except requests.RequestException:
            continue
    return False
