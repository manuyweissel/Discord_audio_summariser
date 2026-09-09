from __future__ import annotations

from datetime import datetime
from pathlib import Path
import re

from openai import AsyncOpenAI

from .config import MEETING_BLUEPRINT_PATH, SETTINGS
from .transcript_cleaning import clean_transcript
from .logger import logger


client = AsyncOpenAI(api_key=SETTINGS.openai_api_key)

_fallback_blueprint = """# Meeting Minutes — {{DATE}}

## Meeting Topic
{{TOPIC}}

## Meeting Objective
{{OBJECTIVE}}

## Details
{{DETAILS}}

---

## Key Points / Resolutions
{{KEY_POINTS}}

## Decisions
{{DECISIONS}}

## Risks & Dependencies
{{RISKS}}

## Next Steps / Dates
{{NEXT_STEPS}}

## Action Items
| # | Task | Owner | Due |
|---:|---|---|---|
{{ACTION_ITEMS}}
"""

# Transcript lines look like "[2026-06-11T13:05:36.5+00:00] Display Name: spoken text".
_TRANSCRIPT_LINE_RE = re.compile(r"^\[([^\]]+)\]\s+(.+?):\s")


def _extract_meeting_facts(transcript: str, min_speech_chars: int = 0) -> dict[str, str]:
    """Derive the header facts (date, time range, participants) the system already has from
    the transcript line prefixes, so they don't end up as 'n/a'."""
    timestamps: list[datetime] = []
    participants: list[str] = []
    seen: set[str] = set()
    spoken_chars: dict[str, int] = {}
    for line in transcript.splitlines():
        match = _TRANSCRIPT_LINE_RE.match(line)
        if match is None:
            continue
        raw_ts, name = match.group(1), match.group(2).strip()
        try:
            timestamps.append(datetime.fromisoformat(raw_ts))
        except ValueError:
            pass
        if name:
            spoken_chars[name] = spoken_chars.get(name, 0) + len(line[match.end():])
            if name not in seen:
                seen.add(name)
                participants.append(name)
    if min_speech_chars > 0:
        # Drop speakers whose every line was hallucinated filler. Deliberately a character
        # threshold only — a line-count rule would erase someone who spoke one long monologue.
        participants = [name for name in participants if spoken_chars.get(name, 0) >= min_speech_chars]
    facts: dict[str, str] = {}
    if timestamps:
        start = min(timestamps).astimezone()
        end = max(timestamps).astimezone()
        facts["date"] = start.strftime("%d.%m.%Y")
        facts["time"] = f"{start.strftime('%H:%M')}–{end.strftime('%H:%M')}"
    if participants:
        facts["participants"] = ", ".join(participants)
    return facts


def _apply_known_facts(blueprint: str, facts: dict[str, str]) -> str:
    """Pre-fill the template header with known facts (only the lines we actually have)."""
    date = facts.get("date") or datetime.now().strftime("%d.%m.%Y")
    details = [f"- **Date:** {date}"]
    if facts.get("time"):
        details.append(f"- **Time:** {facts['time']}")
    if facts.get("participants"):
        details.append(f"- **Participants:** {facts['participants']}")
    return blueprint.replace("{{DATE}}", date).replace("{{DETAILS}}", "\n".join(details))


def _details_block(facts: dict[str, str]) -> tuple[str, str]:
    """(rendered Details bullets, date) — the same values _apply_known_facts injects."""
    date = facts.get("date") or datetime.now().strftime("%d.%m.%Y")
    details = [f"- **Date:** {date}"]
    if facts.get("time"):
        details.append(f"- **Time:** {facts['time']}")
    if facts.get("participants"):
        details.append(f"- **Participants:** {facts['participants']}")
    return "\n".join(details), date

_DETAILS_HEADING = "## Details"
_NEXT_HEADING_RE = re.compile(r"^(#{1,3} |---\s*$)", re.M)


def _enforce_header(summary: str, blueprint_details: str, date: str) -> str:
    """Overwrite the model's Details block and H1 with the facts we already hold.

    _apply_known_facts pre-fills them, but gpt-4o rewrites the block anyway and has been
    observed replacing every field with "n/a". These values are derived from the transcript,
    so they are simply substituted back rather than asked for.
    """
    lines = summary.splitlines()
    out: list[str] = []
    replaced = False
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.strip().startswith("# ") and not line.strip().startswith("##"):
            out.append(f"# Meeting Minutes — {date}")
            index += 1
            continue
        if line.strip() == _DETAILS_HEADING:
            out.append(_DETAILS_HEADING)
            out.append(blueprint_details)
            out.append("")
            index += 1
            # Skip whatever the model wrote until the next heading or rule.
            while index < len(lines) and not _NEXT_HEADING_RE.match(lines[index]):
                index += 1
            replaced = True
            continue
        out.append(line)
        index += 1
    if not replaced:
        out.extend(["", _DETAILS_HEADING, blueprint_details])
    return "\n".join(out).strip()


_breaker_failures = 0
_breaker_opened_at: float | None = None


def approximate_tokens(text: str) -> int:
    return max(1, int(len(text) / 3.5))


def chunk_text(text: str, max_tokens: int = 6000) -> list[str]:
    """Pack whole transcript lines into chunks.

    Splitting on raw character offsets cut lines in half, so a chunk could open mid-sentence
    with no speaker attached. Lines are never split; a single over-long line becomes its own chunk.
    """
    if not text.strip():
        return []
    max_chars = int(max_tokens * 3.5)
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for line in text.strip().splitlines():
        line_len = len(line) + 1
        if current and size + line_len > max_chars:
            chunks.append("\n".join(current).strip())
            current, size = [], 0
        current.append(line)
        size += line_len
    if current:
        chunks.append("\n".join(current).strip())
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


async def _summarize_short(content: str, facts: dict[str, str]) -> str:
    blueprint = _apply_known_facts(load_blueprint(), facts)
    completion = await client.chat.completions.create(
        model=SETTINGS.summary_model,
        temperature=SETTINGS.summary_temperature,
        messages=[
            {
                "role": "system",
                "content": "You are a professional executive assistant who writes clear, accurate English meeting minutes.",
            },
            {
                "role": "user",
                "content": (
                    "Complete the meeting-minutes template below using only the transcript.\n"
                    "Rules:\n"
                    "- Keep the '## Details' block (Date, Time, Participants) exactly as given.\n"
                    "- Always fill '## Meeting Topic' with a short subject line inferred from the discussion.\n"
                    '- Use ONLY information clearly supported by the transcript. Never write "n/a" and '
                    "never invent names, dates, numbers, decisions or tasks.\n"
                    "- Except for Meeting Topic, if a section has no supporting content, delete that "
                    "section's heading and body entirely.\n"
                    "- For 'Key Points / Resolutions', use 2-5 topical sub-headings (### ...) that fit this meeting.\n"
                    "- For 'Action Items', one row per task actually assigned; leave Owner/Due blank if unstated; "
                    "omit the table if there are no tasks.\n"
                    "- Write in English and be concise.\n\n"
                    f"TRANSCRIPT:\n{content}\n\nTEMPLATE:\n{blueprint}"
                ),
            },
        ],
    )
    return (completion.choices[0].message.content or "").strip()


async def _summarize_chunk(chunk: str) -> str:
    """Condense one slice of a very long transcript, KEEPING who said what.

    The previous version reduced each chunk to anonymous bullets, so the final pass had no
    speaker names or times left to work with and filled the header with "n/a".
    """
    completion = await client.chat.completions.create(
        model=SETTINGS.summary_model,
        temperature=SETTINGS.summary_temperature,
        messages=[
            {
                "role": "system",
                "content": (
                    "Condense this meeting-transcript excerpt into concise English bullets. "
                    "Attribute every bullet to the speaker who said it, in the form "
                    "'- [HH:MM] Speaker: point'. Preserve names, figures, dates, decisions, "
                    "risks and assigned tasks exactly. Do not invent anything."
                ),
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

    raw_transcript = transcript_path.read_text(encoding="utf-8").strip()
    if not raw_transcript:
        return None

    # Filter hallucinations and echo duplicates before the model sees anything. The file on
    # disk is left untouched so it stays an audit trail.
    transcript, report = clean_transcript(raw_transcript)
    logger.info(
        "Transcript cleaned for summarization",
        extra={
            "action": "transcript_summarization",
            "event": "cleaned",
            "lines_in": report.total,
            "lines_kept": report.kept,
            "dropped_hallucination": len(report.dropped_hallucination),
            "dropped_repetition": len(report.dropped_repetition),
            "dropped_duplicate": len(report.dropped_duplicate),
            "trimmed_tails": report.trimmed_tails,
        },
    )
    if not transcript.strip():
        return None

    try:
        # Header facts come from the cleaned transcript so speakers whose every line was
        # filler do not appear as participants.
        facts = _extract_meeting_facts(transcript, min_speech_chars=SETTINGS.participant_min_chars)
        details_block, date = _details_block(facts)
        if approximate_tokens(transcript) <= SETTINGS.summary_single_pass_max_tokens:
            # Single pass with the full transcript, speaker names intact.
            summary = await _summarize_short(transcript, facts)
        else:
            summaries = [await _summarize_chunk(chunk) for chunk in chunk_text(transcript)]
            summary = await _summarize_short("\n\n".join(summaries), facts)
        _record_success()
        return _enforce_header(summary, details_block, date)
    except Exception:  # pragma: no cover - network exercised manually
        _record_failure()
        raise


async def close_client() -> None:
    await client.close()
