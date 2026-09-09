from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .config import SETTINGS
from .manifest import persist_transcript_path


class TranscriptStore:
    def __init__(self) -> None:
        self.session_logs: dict[str, Path] = {}

    def get_path(self, session_id: str, guild_id: str, channel_id: str) -> Path:
        path = self.session_logs.get(session_id)
        if path is not None:
            return path
        ts = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(":", "-")
        path = SETTINGS.transcript_dir / f"{guild_id}-{channel_id}-{ts}.log"
        self.session_logs[session_id] = path
        persist_transcript_path(session_id, str(path))
        return path

    async def write_line(
        self,
        *,
        guild_id: str,
        channel_id: str,
        session_id: str,
        username: str,
        text: str,
        timestamp: str | None = None,
    ) -> Path:
        path = self.get_path(session_id, guild_id, channel_id)
        # Stamp when the audio was SPOKEN, not when transcription finished. Whisper latency
        # pushed write time seconds past the speech, which made the minutes' time range wrong
        # and left near-duplicate echo lines looking further apart than they were.
        spoken_at = (timestamp or "").strip() or datetime.now(timezone.utc).isoformat()
        line = f"[{spoken_at}] {username}: {text.strip()}\n"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
        return path

    def release(self, session_id: str) -> Path | None:
        return self.session_logs.pop(session_id, None)
