from __future__ import annotations

import json
from pathlib import Path

from .config import SETTINGS
from .logger import logger


def list_spool_files() -> list[Path]:
    return sorted(SETTINGS.spool_dir.glob("*.json"))


def read_spool_record(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def delete_spool_record(path: Path) -> None:
    path.unlink(missing_ok=True)


def log_malformed_spool_record(path: Path, error: Exception) -> None:
    logger.warning(
        "Malformed voice spool record skipped",
        extra={
            "action": "voice_capture_spool",
            "event": "malformed",
            "path": str(path),
            "error_message": str(error),
        },
    )
