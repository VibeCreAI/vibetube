from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional

OutputFormat = Literal["webm", "png"]


@dataclass(slots=True)
class RenderConfig:
    avatar_dir: Path
    out_dir: Path
    fps: int = 30
    width: int = 512
    height: int = 512
    format: OutputFormat = "webm"
    vibetube_url: str = "http://localhost:17493"
    voice_profile_id: Optional[str] = None
    voice_language: Optional[str] = None
    manage_vibetube: bool = False
    vibetube_start_command: Optional[str] = None
    vibetube_workdir: Optional[Path] = None
    vibetube_start_timeout_sec: float = 45.0
    text: Optional[str] = None
    text_path: Optional[Path] = None
    input_wav: Optional[Path] = None
    use_pytoon: bool = True
    window_ms: int = 20
    smoothing_windows: int = 5
    on_threshold: float = 0.05
    off_threshold: float = 0.03
    min_hold_frames: int = 2

    def resolved_text(self) -> Optional[str]:
        if self.text is not None:
            return self.text.strip()
        if self.text_path is None:
            return None
        return self.text_path.read_text(encoding="utf-8").strip()

