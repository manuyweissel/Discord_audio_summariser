from __future__ import annotations

import array
import math
import re
import warnings
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

# audioop is a C accelerator only; it is deprecated in 3.12 and REMOVED in 3.13, so it is
# optional and the pure-stdlib fallback below is used when it is gone.
try:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        import audioop as _audioop  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - Python 3.13+
    _audioop = None

_AUDIO_GATE_FRAME_MS = 20

# Whisper rewrites silence and short non-speech bursts into caption boilerplate. Measured over
# 944 real captures these four strings alone account for a third of all transcribed segments.
# Only whole-line matches are dropped, so the same words survive inside a real utterance.
# Deliberately NOT listed: "yeah.", "okay.", "so.", "thanks.", "see you." — indistinguishable
# from genuine backchannels, and they carry no report content either way.
_HALLUCINATION_EXACT = {
    "you", "thank you", "thanks", "bye", "bye bye", "goodbye", "peace",
    "mm hmm", "mmhmm", "mhm", "mm", "uh huh", "hmm", "",
    "thank you very much", "thank you so much", "thanks for watching",
    "thanks for listening", "thank you for watching", "thank you for joining us",
    "please subscribe", "subscribe to my channel",
}
_HALLUCINATION_SUBSTRINGS = (
    "ontario website",
    "thanks for watching",
    "thanks for listening",
    "see you in the next",
    "new revised standard version",
    "amara.org",
    "subtitles by",
)
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


def _normalize_for_blocklist(text: str) -> str:
    """Punctuation becomes whitespace so "Bye-bye." and "Bye bye" collapse to the same key."""
    return " ".join(_PUNCT_RE.sub(" ", text).split()).lower()


# Below this, whatever precedes a hallucinated tail is not worth keeping on its own.
_MIN_SALVAGE_CHARS = 40


def _is_hallucination(text: str) -> bool:
    """True only when the ENTIRE line is filler, so filler inside a real utterance survives."""
    return _normalize_for_blocklist(text) in _HALLUCINATION_EXACT


def strip_hallucinated_tail(text: str) -> str:
    """Trim caption boilerplate appended to the end of a real utterance.

    Whisper often finishes a genuine segment with "Thanks for watching." or a subtitle credit.
    Dropping the whole line for that would lose real content, so cut at the marker and keep the
    prefix when enough of it remains; otherwise the line was filler all along.
    """
    lowered = text.lower()
    cut = min(
        (lowered.find(marker) for marker in _HALLUCINATION_SUBSTRINGS if marker in lowered),
        default=-1,
    )
    if cut < 0:
        return text
    prefix = text[:cut].strip(" \t-—–,;:")
    return prefix if len(prefix) >= _MIN_SALVAGE_CHARS else ""


def _read_wav_pcm(path: Path) -> tuple[bytes, int, int, int]:
    """(raw_frames, sample_rate, channels, sample_width); zeroed on any read failure."""
    try:
        with wave.open(str(path), "rb") as wav:
            return (
                wav.readframes(wav.getnframes()),
                wav.getframerate(),
                wav.getnchannels(),
                wav.getsampwidth(),
            )
    except (wave.Error, OSError, EOFError, MemoryError):
        return b"", 0, 0, 0


def _measure_audio(path: Path) -> tuple[float, float]:
    """Return (total_rms, voiced_fraction), or (-1.0, -1.0) when it cannot be measured.

    Roughly 98% of these captures are dual-mono, and the pooled/mono RMS ratio is 1.0000 at
    p5/p50/p95, so RMS is taken over the interleaved stream with no downmix step.
    Unmeasurable audio fails OPEN — it still goes to the API rather than being dropped blind.
    """
    raw, rate, channels, width = _read_wav_pcm(path)
    if width != 2 or not raw or not rate or not channels:
        return -1.0, -1.0

    frame_samples = max(1, int(rate * _AUDIO_GATE_FRAME_MS / 1000)) * channels
    frame_bytes = frame_samples * 2
    floor = SETTINGS.whisper_frame_rms

    if _audioop is not None:
        total = float(_audioop.rms(raw, 2))
        frames = voiced = 0
        for offset in range(0, len(raw) - frame_bytes + 1, frame_bytes):
            frames += 1
            if _audioop.rms(raw[offset : offset + frame_bytes], 2) > floor:
                voiced += 1
    else:  # pragma: no cover - exercised on Python 3.13+
        samples = array.array("h")
        samples.frombytes(raw[: len(raw) - (len(raw) % 2)])
        if sys_byteorder_is_big := (array.array("h", b"\x01\x00")[0] != 1):
            samples.byteswap()
        total = math.sqrt(sum(v * v for v in samples) / len(samples)) if samples else 0.0
        frames = voiced = 0
        for offset in range(0, len(samples) - frame_samples + 1, frame_samples):
            window = samples[offset : offset + frame_samples]
            if math.sqrt(sum(v * v for v in window) / len(window)) > floor:
                voiced += 1
            frames += 1

    return total, (voiced / frames if frames else 0.0)


def _passes_audio_gate(path: Path) -> tuple[bool, str]:
    """Block near-silent clips before they reach the API.

    Calibrated on 944 real captures joined to their transcripts: at RMS>=250 with a 10% voiced
    fraction this blocks 76% of known hallucinations and 0 of 383 substantive segments
    (real p5 RMS is 708, a 2.8x margin). It cannot catch the ~24% of hallucinations that are
    loud short bursts — a cough or a chair — which is what the logprob and blocklist layers are for.
    """
    if SETTINGS.whisper_min_rms <= 0:
        return True, ""
    rms, voiced = _measure_audio(path)
    if rms < 0:
        return True, ""  # unmeasurable: fail open
    if rms < SETTINGS.whisper_min_rms or voiced < SETTINGS.whisper_min_voiced_fraction:
        return False, f"Below speech threshold: rms={rms:.0f} voiced={voiced:.2f}"
    return True, ""


def _verbose_text(response: object) -> str:
    """Text of a verbose_json response with hallucinated segments removed."""
    segments = getattr(response, "segments", None)
    full_text = (getattr(response, "text", "") or "").strip()
    if not segments:
        return full_text
    kept: list[str] = []
    for segment in segments:
        no_speech = getattr(segment, "no_speech_prob", 0.0) or 0.0
        avg_logprob = getattr(segment, "avg_logprob", 0.0) or 0.0
        if no_speech > SETTINGS.whisper_max_no_speech_prob and avg_logprob < SETTINGS.whisper_min_avg_logprob:
            continue
        piece = (getattr(segment, "text", "") or "").strip()
        if piece:
            kept.append(piece)
    return " ".join(kept).strip()


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

    allowed, gate_reason = _passes_audio_gate(path)
    if not allowed:
        if entry_id:
            mark_skipped(entry_id, gate_reason)
        return {"text": "", "success": False, "error": gate_reason, "skipped": True, "gated": True}

    try:
        with path.open("rb") as audio_file:
            response = await client.audio.transcriptions.create(
                file=audio_file,
                model=SETTINGS.whisper_model,
                prompt=SETTINGS.whisper_prompt,
                temperature=SETTINGS.whisper_temperature,
                response_format="verbose_json",
            )
        text = _verbose_text(response)
        if text and _is_hallucination(text):
            message = "Filtered Whisper hallucination"
            if entry_id:
                mark_skipped(entry_id, message)
            return {"text": "", "success": False, "error": message, "skipped": True, "gated": True}
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
