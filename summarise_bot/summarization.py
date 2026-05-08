from __future__ import annotations

from pathlib import Path

from openai import AsyncOpenAI

from .config import MEETING_BLUEPRINT_PATH, SETTINGS
from .logger import logger


client = AsyncOpenAI(api_key=SETTINGS.openai_api_key)

_fallback_blueprint = """# Meeting Minutes — {{DATE}}

## Meeting Topic
{{TOPIC}}

## Meeting Objective
{{OBJECTIVE}}

## Details
- **Date:** {{DATE}}
- **Participants:** {{PARTICIPANTS}}

---

## Key Points / Resolutions
{{KEY_POINTS}}

## Decisions
{{DECISIONS}}

## Risks & Dependencies
{{RISKS}}

## Action Items
| # | Task | Owner | Due | Status |
|---|------|-------|-----|--------|
{{ACTION_ITEMS}}

## Minutes Prepared By
Automated Meeting Bot — {{TIMESTAMP}}
"""

_breaker_failures = 0
_breaker_opened_at: float | None = None


def approximate_tokens(text: str) -> int:
    return max(1, int(len(text) / 3.5))


def chunk_text(text: str, max_tokens: int = 6000) -> list[str]:
    if not text.strip():
        return []
    max_chars = int(max_tokens * 3.5)
    chunks: list[str] = []
    remaining = text.strip()
    while remaining:
        if len(remaining) <= max_chars:
            chunks.append(remaining)
            break
        target = remaining[:max_chars]
        break_index = max(target.rfind("\n\n"), target.rfind(". "), target.rfind("\n"), target.rfind(" "))
        if break_index < 0:
            break_index = max_chars
        chunks.append(remaining[:break_index].strip())
        remaining = remaining[break_index:].strip()
    return [chunk for chunk in chunks if chunk]


def load_blueprint() -> str:
    if not MEETING_BLUEPRINT_PATH.exists():
        return _fallback_blueprint
    return MEETING_BLUEPRINT_PATH.read_text(encoding="utf-8")


def _circuit_open() -> bool:
    global _breaker_opened_at, _breaker_failures
    if _breaker_opened_at is None:
        return False
    import time

    if (time.time() - _breaker_opened_at) * 1000 > SETTINGS.circuit_breaker_timeout_ms:
        _breaker_opened_at = None
        _breaker_failures = max(0, _breaker_failures // 2)
        return False
    return True


def _record_success() -> None:
    global _breaker_failures, _breaker_opened_at
    _breaker_failures = max(0, _breaker_failures - 1)
    if _breaker_failures < SETTINGS.circuit_breaker_threshold // 2:
        _breaker_opened_at = None


def _record_failure() -> None:
    global _breaker_failures, _breaker_opened_at
    import time

    _breaker_failures += 1
    if _breaker_failures >= SETTINGS.circuit_breaker_threshold:
        _breaker_opened_at = time.time()


async def _summarize_short(transcript: str, session_id: str) -> str:
    blueprint = load_blueprint()
    completion = await client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "system",
                "content": "You are a professional executive assistant specializing in clear German meeting protocols.",
            },
            {
                "role": "user",
                "content": (
                    "Create a professional German meeting minutes document from the transcript below. "
                    "Follow the provided template exactly, fill unknown information with n/a, and keep the output concise.\n\n"
                    f"TRANSCRIPT:\n{transcript}\n\nTEMPLATE:\n{blueprint}"
                ),
            },
        ],
    )
    return (completion.choices[0].message.content or "").strip()


async def _summarize_chunk(chunk: str) -> str:
    completion = await client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "system",
                "content": "Summarize transcript chunks into concise German bullet points covering decisions, risks, and action items.",
            },
            {"role": "user", "content": chunk},
        ],
    )
    return (completion.choices[0].message.content or "").strip()


async def summarize_transcript(transcript_path: Path) -> str | None:
    if _circuit_open():
        raise RuntimeError("Circuit breaker open - API unavailable")
    if not transcript_path.exists():
        logger.warning("No transcript file found for summarization", extra={"action": "transcript_summarization", "event": "error"})
        return None

    transcript = transcript_path.read_text(encoding="utf-8").strip()
    if not transcript:
        return None

    try:
        if approximate_tokens(transcript) <= 6000:
            summary = await _summarize_short(transcript, transcript_path.stem)
        else:
            summaries = [await _summarize_chunk(chunk) for chunk in chunk_text(transcript)]
            summary = await _summarize_short("\n\n".join(summaries), transcript_path.stem)
        _record_success()
        return summary
    except Exception:  # pragma: no cover - network exercised manually
        _record_failure()
        raise


async def close_client() -> None:
    await client.close()
