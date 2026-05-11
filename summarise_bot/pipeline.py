from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import discord

from .logger import logger
from .manifest import add_audio_entry, find_audio_entry_by_capture_event_id
from .spool import delete_spool_record, list_spool_files, log_malformed_spool_record, read_spool_record
from .transcript import TranscriptStore
from .transcription import transcribe_with_retry


@dataclass(slots=True)
class PipelineSessionMetrics:
    ingests_started: int = 0
    segments_ingested: int = 0
    duplicate_segments: int = 0
    missing_wav_segments: int = 0
    transcriptions_completed: int = 0
    transcription_failures: int = 0


class VoiceCapturePipeline:
    def __init__(self, bot: discord.Bot, transcript_store: TranscriptStore) -> None:
        self.bot = bot
        self.transcript_store = transcript_store
        self.pending: dict[str, set[str]] = {}
        self.ingest_in_flight: set[str] = set()
        self.session_metrics: dict[str, PipelineSessionMetrics] = {}

    def _get_pending_set(self, session_id: str) -> set[str]:
        return self.pending.setdefault(session_id, set())

    def _get_metrics(self, session_id: str) -> PipelineSessionMetrics:
        return self.session_metrics.setdefault(session_id, PipelineSessionMetrics())

    def get_session_metrics(self, session_id: str) -> dict[str, int]:
        metrics = asdict(self._get_metrics(session_id))
        metrics["pending_ingests"] = len(self.pending.get(session_id, set()))
        return metrics

    async def resolve_username(self, guild_id: str, user_id: str) -> str:
        guild = self.bot.get_guild(int(guild_id))
        if guild is None:
            try:
                guild = await self.bot.fetch_guild(int(guild_id))
            except Exception:
                return f"User-{user_id[-4:]}"
        member = guild.get_member(int(user_id))
        if member is None:
            try:
                member = await guild.fetch_member(int(user_id))
            except Exception:
                return f"User-{user_id[-4:]}"
        return member.display_name if hasattr(member, "display_name") else member.name

    async def write_transcript_line(self, record: dict[str, Any], username: str, text: str) -> None:
        if not text.strip():
            return
        await self.transcript_store.write_line(
            guild_id=str(record["guildId"]),
            channel_id=str(record["channelId"]),
            session_id=str(record["sessionId"]),
            username=username,
            text=text.strip(),
        )

    async def ingest_record(self, record: dict[str, Any], spool_path: Path | None = None) -> dict[str, Any]:
        event_id = str(record.get("eventId") or "")
        session_id = str(record.get("sessionId") or "")
        wav_path = Path(str(record.get("wavPath") or ""))
        if not event_id or not session_id or not wav_path:
            raise RuntimeError("Invalid voice capture record payload")

        if event_id in self.ingest_in_flight:
            return {"skipped": True, "reason": "already_processing"}
        metrics = self._get_metrics(session_id)
        metrics.ingests_started += 1
        if find_audio_entry_by_capture_event_id(event_id):
            metrics.duplicate_segments += 1
            if spool_path:
                delete_spool_record(spool_path)
            return {"skipped": True, "reason": "already_ingested"}
        if not wav_path.exists():
            metrics.missing_wav_segments += 1
            if spool_path:
                delete_spool_record(spool_path)
            return {"skipped": True, "reason": "missing_wav"}

        self.ingest_in_flight.add(event_id)
        tracking_id = event_id
        self._get_pending_set(session_id).add(tracking_id)
        try:
            username = await self.resolve_username(str(record["guildId"]), str(record["userId"]))
            entry = add_audio_entry(
                session_id=session_id,
                audio_path=str(wav_path),
                user_id=str(record["userId"]),
                username=username,
                file_size=int(record.get("fileSize") or wav_path.stat().st_size),
                capture_source="dave_helper",
                capture_event_id=event_id,
                created_at=str(record.get("endedAt") or record.get("startedAt") or ""),
                started_at=str(record.get("startedAt") or ""),
                ended_at=str(record.get("endedAt") or ""),
                duration=_duration(record),
            )
            metrics.segments_ingested += 1
            transcription = await transcribe_with_retry(
                str(wav_path),
                session_id,
                str(record["userId"]),
                entry["id"],
                3,
            )
            if transcription.get("success") and transcription.get("text"):
                metrics.transcriptions_completed += 1
                await self.write_transcript_line(record, username, str(transcription["text"]))
            elif not transcription.get("success"):
                metrics.transcription_failures += 1
            if spool_path:
                delete_spool_record(spool_path)
            return {"success": True, "entryId": entry["id"], "transcription": transcription}
        finally:
            self.ingest_in_flight.discard(event_id)
            pending_set = self.pending.get(session_id)
            if pending_set is not None:
                pending_set.discard(tracking_id)
                if not pending_set:
                    self.pending.pop(session_id, None)

    async def replay_spool(self) -> dict[str, int]:
        replayed = 0
        failed = 0
        for spool_path in list_spool_files():
            try:
                record = read_spool_record(spool_path)
                await self.ingest_record(record, spool_path=spool_path)
                replayed += 1
            except Exception as error:
                failed += 1
                log_malformed_spool_record(spool_path, error)
        return {"replayed": replayed, "failed": failed}

    async def wait_for_pending(self, session_id: str, timeout: float = 30.0) -> bool:
        end_time = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < end_time:
            if not self.pending.get(session_id):
                return True
            await asyncio.sleep(0.5)
        return not self.pending.get(session_id)


def _duration(record: dict[str, Any]) -> float | None:
    started_at = record.get("startedAt")
    ended_at = record.get("endedAt")
    if not started_at or not ended_at:
        return None
    from datetime import datetime

    return max(0.0, (datetime.fromisoformat(str(ended_at)) - datetime.fromisoformat(str(started_at))).total_seconds())
