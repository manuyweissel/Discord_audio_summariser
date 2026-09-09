from __future__ import annotations

import json
from pathlib import Path

from .config import SETTINGS
from .logger import logger


def list_spool_files() -> list[Path]:
    return sorted(SETTINGS.spool_dir.glob("*.json"))


def spool_path_for_event(event_id: str) -> Path | None:
    """Path of the spool record the helper wrote for this segment.

    The live path receives the record over stdout rather than by reading the file, so it has
    no path to hand back. Without this the record is never deleted and every meeting leaves
    ~200 orphans behind, which a later replay re-transcribes at full cost.
    """
    if not event_id:
        return None
    candidate = SETTINGS.spool_dir / f"{event_id}.json"
    return candidate if candidate.exists() else None


def quarantine_spool_record(path: Path) -> Path | None:
    """Move a stale record out of the replay set, keeping it (and its WAV) on disk."""
    try:
        SETTINGS.spool_stale_dir.mkdir(parents=True, exist_ok=True)
        target = SETTINGS.spool_stale_dir / path.name
        path.replace(target)
        return target
    except OSError as error:
        logger.warning(
            "Could not quarantine stale voice spool record",
            extra={
                "action": "voice_capture_spool",
                "event": "quarantine_failed",
                "path": str(path),
                "error_message": str(error),
            },
        )
        return None


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
