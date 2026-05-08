from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from .config import SETTINGS
from .document import convert_to_word_doc
from .logger import logger
from .manifest import (
    build_transcript_from_manifest,
    cleanup_old_sessions,
    end_session,
    get_session_stats,
    get_sessions_needing_recovery,
    get_untranscribed_entries,
    is_session_fully_transcribed,
    mark_session_summarized,
    mark_stale_sessions,
)
from .summarization import summarize_transcript
from .transcription import transcribe_with_retry
from .transcript import TranscriptStore


class RecoveryService:
    def __init__(self, transcript_store: TranscriptStore) -> None:
        self.transcript_store = transcript_store
        self.is_recovering = False

    async def run(self, auto_summarize: bool = True) -> dict[str, int]:
        if self.is_recovering:
            return {"recovered": 0, "failed": 0, "summarized": 0}
        self.is_recovering = True
        recovered = failed = summarized = 0
        try:
            cleanup_old_sessions(7)
            sessions = get_sessions_needing_recovery()
            for session in sessions:
                for entry in get_untranscribed_entries(session["sessionId"]):
                    result = await transcribe_with_retry(
                        entry["audioPath"],
                        entry["sessionId"],
                        entry["userId"],
                        entry["id"],
                        3,
                    )
                    if result.get("success"):
                        recovered += 1
                    else:
                        failed += 1
                        if result.get("isQuotaError"):
                            break
                if auto_summarize and is_session_fully_transcribed(session["sessionId"]):
                    summary = await self._summarize_session(session["sessionId"])
                    if summary:
                        summarized += 1
            return {"recovered": recovered, "failed": failed, "summarized": summarized}
        finally:
            self.is_recovering = False

    async def _summarize_session(self, session_id: str) -> str | None:
        transcript = build_transcript_from_manifest(session_id)
        if not transcript.strip():
            return None
        guild_id, channel_id = session_id.split(":", 1)
        ts = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(":", "-")
        transcript_path = SETTINGS.transcript_dir / f"{guild_id}-{channel_id}-{ts}-recovered.log"
        transcript_path.write_text(transcript, encoding="utf-8")
        end_session(session_id, str(transcript_path))
        summary = await summarize_transcript(transcript_path)
        if not summary:
            return None
        file_name = f"Meeting_Minutes_{datetime.now().strftime('%Y_%m_%d__%H_%M')}_recovered.docx"
        output_path = SETTINGS.summary_dir / file_name
        title = _extract_title(summary)
        word_buffer = convert_to_word_doc(summary, title)
        if word_buffer is None:
            return None
        output_path.write_bytes(word_buffer)
        mark_session_summarized(session_id, str(output_path))
        return str(output_path)

    def get_status(self) -> dict[str, int | bool]:
        sessions = get_sessions_needing_recovery()
        total_untranscribed = sum(len(get_untranscribed_entries(session["sessionId"])) for session in sessions)
        return {
            "isRecovering": self.is_recovering,
            "sessionsNeedingRecovery": len(sessions),
            "totalUntranscribed": total_untranscribed,
        }


def _extract_title(summary: str) -> str:
    for line in summary.splitlines():
        if line.startswith("# Meeting Minutes —"):
            return line.replace("# Meeting Minutes —", "").strip() or "Meeting"
    return "Meeting"
