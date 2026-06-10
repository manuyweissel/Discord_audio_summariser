from __future__ import annotations

from pathlib import Path
import wave

from openai import AsyncOpenAI

from .config import SETTINGS
from .logger import logger
from .manifest import mark_failed, mark_in_progress, mark_skipped, mark_transcribed


client = AsyncOpenAI(api_key=SETTINGS.openai_api_key)

# OpenAI rejects clips under 0.1s ("audio_too_short"). Skip anything below this locally so
# empty/blip segments never hit the API (and never get retried forever by the recovery loop).
MIN_AUDIO_SECONDS = 0.15


def _wav_duration_seconds(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as wav:
            frames = wav.getnframes()
            rate = wav.getframerate()
    except (wave.Error, OSError, EOFError):
        return 0.0
    return frames / rate if rate else 0.0


def _is_quota_error(error: Exception) -> bool:
    message = str(error).lower()
    status = getattr(error, "status_code", None) or getattr(error, "status", None)
    code = getattr(error, "code", None)
    return status == 429 or code == "insufficient_quota" or "insufficient_quota" in message


def _is_permanent_error(error: Exception) -> bool:
    status = getattr(error, "status_code", None) or getattr(error, "status", None)
    message = str(error).lower()
    return (
        status == 401
        or "audio_format" in message
        or "audio_too_short" in message
        or "audio file is too short" in message
    )


async def validate_openai_key() -> bool:
    try:
        await client.models.list()
        logger.info("OpenAI API key validation successful", extra={"action": "openai_validation", "event": "complete"})
        return True
    except Exception as error:  # pragma: no cover - network exercised manually
        logger.error(
            "OpenAI API key validation failed",
            extra={"action": "openai_validation", "event": "error", "error_message": str(error)},
        )
        return False


async def close_client() -> None:
    await client.close()


async def transcribe_audio(
    wav_path: str,
    session_id: str,
    user_id: str,
    entry_id: str | None = None,
) -> dict[str, object]:
    path = Path(wav_path)
    if entry_id:
        mark_in_progress(entry_id)

    if not path.exists():
        message = "Audio file not found"
        if entry_id:
            mark_skipped(entry_id, message)  # missing file can never transcribe — don't retry forever
        return {"text": "", "success": False, "error": message, "skipped": True}

    duration_seconds = _wav_duration_seconds(path)
    if duration_seconds < MIN_AUDIO_SECONDS:
        message = f"Audio too short: {duration_seconds:.3f}s"
        if entry_id:
            mark_skipped(entry_id, message)
        return {"text": "", "success": False, "error": message, "skipped": True}

    try:
        with path.open("rb") as audio_file:
            response = await client.audio.transcriptions.create(
                file=audio_file,
                model="whisper-1",
            )
        text = (response.text or "").strip()
        if text:
            if entry_id:
                mark_transcribed(entry_id, text)
            logger.info(
                "Transcription successful",
                extra={"action": "audio_transcription", "event": "complete", "session_id": session_id, "user_id": user_id},
            )
            return {"text": text, "success": True, "error": None}
        message = "No speech detected or audio unclear"
        if entry_id:
            mark_skipped(entry_id, message)
        return {"text": "", "success": False, "error": message, "skipped": True}
    except Exception as error:  # pragma: no cover - network exercised manually
        quota = _is_quota_error(error)
        permanent = _is_permanent_error(error)
        message = str(error)
        if entry_id:
            if permanent:
                mark_skipped(entry_id, f"Permanent error: {message}")
            else:
                mark_failed(entry_id, message)
        if permanent:
            # Not a real failure — the clip can never transcribe (e.g. too short). Skip
            # quietly so it is not logged as an error or retried by the recovery loop.
            logger.info(
                "Audio transcription skipped (permanent)",
                extra={
                    "action": "audio_transcription",
                    "event": "skipped_permanent",
                    "session_id": session_id,
                    "user_id": user_id,
                    "error_message": message,
                },
            )
        else:
            logger.error(
                "Audio transcription failed",
                extra={
                    "action": "audio_transcription",
                    "event": "error",
                    "session_id": session_id,
                    "user_id": user_id,
                    "error_message": message,
                    "is_quota_error": quota,
                },
            )
        return {"text": "", "success": False, "error": message, "isQuotaError": quota, "skipped": permanent}


async def transcribe_with_retry(
    wav_path: str,
    session_id: str,
    user_id: str,
    entry_id: str,
    max_retries: int = 3,
) -> dict[str, object]:
    last_result: dict[str, object] = {"text": "", "success": False, "error": "unknown"}
    for attempt in range(max_retries):
        if attempt:
            await __import__("asyncio").sleep(min(15, 2**attempt))
        last_result = await transcribe_audio(wav_path, session_id, user_id, entry_id)
        if last_result.get("success"):
            return last_result
        if last_result.get("isQuotaError"):
            return last_result
        if last_result.get("skipped"):
            # Permanent / too-short: retrying cannot help, so stop immediately.
            return last_result
    return last_result
