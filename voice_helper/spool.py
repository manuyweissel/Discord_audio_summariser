from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
import json
import os
from pathlib import Path
import tempfile
import uuid
import wave


@dataclass(slots=True)
class SpoolRecord:
    eventId: str
    sessionId: str
    guildId: str
    channelId: str
    userId: str
    wavPath: str
    fileSize: int
    startedAt: str
    endedAt: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _safe_timestamp(value: datetime) -> str:
    return value.isoformat().replace(":", "-")


class SpoolWriter:
    def __init__(self, audio_dir: str, spool_dir: str):
        self.audio_dir = Path(audio_dir)
        self.spool_dir = Path(spool_dir)
        self.audio_dir.mkdir(parents=True, exist_ok=True)
        self.spool_dir.mkdir(parents=True, exist_ok=True)

    def write_segment(
        self,
        *,
        session_id: str,
        guild_id: str,
        channel_id: str,
        user_id: str,
        pcm_bytes: bytes,
        started_at: datetime,
        ended_at: datetime,
        sample_rate: int,
        channels: int,
        sample_width: int,
    ) -> SpoolRecord:
        event_id = str(uuid.uuid4())
        stem = f"{guild_id}-{channel_id}-{_safe_timestamp(ended_at)}-{user_id}"
        wav_path = self.audio_dir / f"{stem}.wav"
        spool_path = self.spool_dir / f"{event_id}.json"

        with tempfile.NamedTemporaryFile(dir=self.audio_dir, suffix=".wav", delete=False) as temp_wav:
            temp_wav_path = Path(temp_wav.name)

        try:
            with wave.open(str(temp_wav_path), "wb") as wav_file:
                wav_file.setnchannels(channels)
                wav_file.setsampwidth(sample_width)
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(pcm_bytes)
            os.replace(temp_wav_path, wav_path)
        finally:
            temp_wav_path.unlink(missing_ok=True)

        record = SpoolRecord(
            eventId=event_id,
            sessionId=session_id,
            guildId=guild_id,
            channelId=channel_id,
            userId=user_id,
            wavPath=str(wav_path),
            fileSize=wav_path.stat().st_size,
            startedAt=started_at.isoformat(),
            endedAt=ended_at.isoformat(),
        )

        with tempfile.NamedTemporaryFile(dir=self.spool_dir, suffix=".json", mode="w", encoding="utf-8", delete=False) as temp_json:
            json.dump(record.to_dict(), temp_json, ensure_ascii=True)
            temp_json_path = Path(temp_json.name)

        try:
            os.replace(temp_json_path, spool_path)
        finally:
            temp_json_path.unlink(missing_ok=True)

        return record
