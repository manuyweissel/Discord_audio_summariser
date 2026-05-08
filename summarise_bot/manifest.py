from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4

from .config import SETTINGS
from .logger import logger


class TranscriptionStatus:
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


_lock = RLock()
_cache: dict[str, Any] | None = None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _load() -> dict[str, Any]:
    global _cache
    if _cache is not None:
        return _cache

    path = SETTINGS.manifest_path
    if path.exists():
        _cache = json.loads(path.read_text(encoding="utf-8"))
    else:
        _cache = {
            "version": "1.0",
            "sessions": {},
            "audioEntries": {},
            "lastUpdated": _utc_now().isoformat(),
        }
        save_manifest_sync()
    return _cache


def _save() -> None:
    manifest = _load()
    manifest["lastUpdated"] = _utc_now().isoformat()
    temp_path = SETTINGS.manifest_path.with_suffix(".json.tmp")
    temp_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    os.replace(temp_path, SETTINGS.manifest_path)


def save_manifest_sync() -> None:
    with _lock:
        _save()


def get_manifest() -> dict[str, Any]:
    with _lock:
        return _load()


def get_or_create_session(session_id: str, guild_id: str, channel_id: str) -> dict[str, Any]:
    with _lock:
        manifest = _load()
        session = manifest["sessions"].get(session_id)
        if session is None:
            session = {
                "sessionId": session_id,
                "guildId": guild_id,
                "channelId": channel_id,
                "startedAt": _utc_now().isoformat(),
                "endedAt": None,
                "status": "active",
                "audioEntries": [],
                "transcriptPath": None,
                "summaryPath": None,
                "summarized": False,
            }
            manifest["sessions"][session_id] = session
            _save()
        return session


def add_audio_entry(
    session_id: str,
    audio_path: str,
    user_id: str,
    username: str,
    file_size: int,
    *,
    capture_source: str | None = None,
    capture_event_id: str | None = None,
    created_at: str | None = None,
    started_at: str | None = None,
    ended_at: str | None = None,
    duration: float | None = None,
) -> dict[str, Any]:
    guild_id, channel_id = session_id.split(":", 1)
    with _lock:
        manifest = _load()
        get_or_create_session(session_id, guild_id, channel_id)
        entry_id = str(uuid4())
        created_at = created_at or _utc_now().isoformat()
        entry = {
            "id": entry_id,
            "sessionId": session_id,
            "guildId": guild_id,
            "channelId": channel_id,
            "userId": user_id,
            "username": username,
            "audioPath": audio_path,
            "status": TranscriptionStatus.PENDING,
            "transcribedText": None,
            "errorMessage": None,
            "retryCount": 0,
            "createdAt": created_at,
            "updatedAt": created_at,
            "fileSize": file_size,
            "duration": duration if duration is not None else file_size / 48000,
            "captureSource": capture_source,
            "captureEventId": capture_event_id,
            "startedAt": started_at,
            "endedAt": ended_at,
        }
        manifest["audioEntries"][entry_id] = entry
        manifest["sessions"][session_id]["audioEntries"].append(entry_id)
        _save()
        return entry


def find_audio_entry_by_capture_event_id(capture_event_id: str | None) -> dict[str, Any] | None:
    if not capture_event_id:
        return None
    manifest = get_manifest()
    for entry in manifest["audioEntries"].values():
        if entry.get("captureEventId") == capture_event_id:
            return entry
    return None


def update_audio_entry(entry_id: str, **updates: Any) -> dict[str, Any] | None:
    with _lock:
        manifest = _load()
        entry = manifest["audioEntries"].get(entry_id)
        if entry is None:
            return None
        entry.update(updates)
        entry["updatedAt"] = _utc_now().isoformat()
        _save()
        return entry


def mark_in_progress(entry_id: str) -> dict[str, Any] | None:
    entry = get_manifest()["audioEntries"].get(entry_id)
    retry_count = 0 if entry is None else int(entry.get("retryCount", 0)) + 1
    return update_audio_entry(entry_id, status=TranscriptionStatus.IN_PROGRESS, retryCount=retry_count)


def mark_transcribed(entry_id: str, text: str) -> dict[str, Any] | None:
    return update_audio_entry(
        entry_id,
        status=TranscriptionStatus.COMPLETED,
        transcribedText=text,
        errorMessage=None,
    )


def mark_failed(entry_id: str, error_message: str) -> dict[str, Any] | None:
    return update_audio_entry(
        entry_id,
        status=TranscriptionStatus.FAILED,
        errorMessage=error_message,
    )


def mark_skipped(entry_id: str, reason: str) -> dict[str, Any] | None:
    return update_audio_entry(
        entry_id,
        status=TranscriptionStatus.SKIPPED,
        errorMessage=reason,
    )


def get_session(session_id: str) -> dict[str, Any] | None:
    return get_manifest()["sessions"].get(session_id)


def end_session(session_id: str, transcript_path: str | None = None) -> dict[str, Any] | None:
    with _lock:
        manifest = _load()
        session = manifest["sessions"].get(session_id)
        if session is None:
            return None
        session["endedAt"] = _utc_now().isoformat()
        session["status"] = "completed"
        if transcript_path:
            session["transcriptPath"] = transcript_path
        _save()
        return session


def mark_session_pending_recovery(session_id: str) -> dict[str, Any] | None:
    return _update_session(session_id, status="pending_recovery")


def mark_session_summarized(session_id: str, summary_path: str) -> dict[str, Any] | None:
    return _update_session(session_id, summaryPath=summary_path, summarized=True, status="completed")


def _update_session(session_id: str, **updates: Any) -> dict[str, Any] | None:
    with _lock:
        manifest = _load()
        session = manifest["sessions"].get(session_id)
        if session is None:
            return None
        session.update(updates)
        _save()
        return session


def get_untranscribed_entries(session_id: str) -> list[dict[str, Any]]:
    manifest = get_manifest()
    session = manifest["sessions"].get(session_id)
    if session is None:
        return []
    pending = []
    for entry_id in session["audioEntries"]:
        entry = manifest["audioEntries"].get(entry_id)
        if entry and entry["status"] in {
            TranscriptionStatus.PENDING,
            TranscriptionStatus.FAILED,
            TranscriptionStatus.IN_PROGRESS,
        }:
            pending.append(entry)
    return pending


def is_session_fully_transcribed(session_id: str) -> bool:
    return len(get_untranscribed_entries(session_id)) == 0


def build_transcript_from_manifest(session_id: str) -> str:
    manifest = get_manifest()
    session = manifest["sessions"].get(session_id)
    if session is None:
        return ""

    lines: list[str] = []
    entries = [
        manifest["audioEntries"][entry_id]
        for entry_id in session["audioEntries"]
        if entry_id in manifest["audioEntries"]
    ]
    entries.sort(key=lambda item: item.get("createdAt") or "")
    for entry in entries:
        text = (entry.get("transcribedText") or "").strip()
        if not text:
            continue
        timestamp = entry.get("endedAt") or entry.get("createdAt") or _utc_now().isoformat()
        username = entry.get("username") or f"User-{str(entry.get('userId', '0000'))[-4:]}"
        lines.append(f"[{timestamp}] {username}: {text}")
    return "\n".join(lines) + ("\n" if lines else "")


def get_sessions_needing_recovery() -> list[dict[str, Any]]:
    manifest = get_manifest()
    result = []
    for session in manifest["sessions"].values():
        if session["status"] == "pending_recovery":
            result.append(session)
            continue
        if get_untranscribed_entries(session["sessionId"]):
            result.append(session)
    return result


def get_session_stats(session_id: str) -> dict[str, int] | None:
    manifest = get_manifest()
    session = manifest["sessions"].get(session_id)
    if session is None:
        return None
    total = len(session["audioEntries"])
    statuses = [manifest["audioEntries"][entry_id]["status"] for entry_id in session["audioEntries"] if entry_id in manifest["audioEntries"]]
    return {
        "total": total,
        "pending": sum(status in {TranscriptionStatus.PENDING, TranscriptionStatus.IN_PROGRESS} for status in statuses),
        "failed": sum(status == TranscriptionStatus.FAILED for status in statuses),
        "completed": sum(status == TranscriptionStatus.COMPLETED for status in statuses),
    }


def mark_stale_sessions(max_age_hours: int) -> int:
    cutoff = _utc_now() - timedelta(hours=max_age_hours)
    changed = 0
    with _lock:
        manifest = _load()
        for session in manifest["sessions"].values():
            if session["status"] != "active":
                continue
            started_at = datetime.fromisoformat(session["startedAt"])
            if started_at < cutoff:
                session["status"] = "pending_recovery"
                changed += 1
        if changed:
            _save()
    return changed


def cleanup_old_sessions(days: int) -> tuple[int, int]:
    cutoff = _utc_now() - timedelta(days=days)
    removed_sessions = 0
    removed_entries = 0
    with _lock:
        manifest = _load()
        to_delete: list[str] = []
        for session_id, session in manifest["sessions"].items():
            ended_at = session.get("endedAt")
            if session["status"] == "active" or not ended_at:
                continue
            if datetime.fromisoformat(ended_at) >= cutoff:
                continue
            to_delete.append(session_id)

        for session_id in to_delete:
            session = manifest["sessions"].pop(session_id)
            removed_sessions += 1
            for entry_id in session.get("audioEntries", []):
                if manifest["audioEntries"].pop(entry_id, None) is not None:
                    removed_entries += 1

        if to_delete:
            _save()
    return removed_sessions, removed_entries


def persist_transcript_path(session_id: str, transcript_path: str) -> None:
    _update_session(session_id, transcriptPath=transcript_path)
