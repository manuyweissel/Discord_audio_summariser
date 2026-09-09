"""Clean a raw transcript before it reaches the summarizer.

The raw ``.log`` on disk stays an untouched audit trail; only the summarizer sees the
cleaned text. Two defects dominate real transcripts here:

* **Whisper hallucinations** — near-silent segments become caption boilerplate
  ("Thank you.", "Bye.", "For more information, visit the Ontario website."). Measured at
  roughly 60% of lines before the audio gate landed.
* **Cross-speaker duplicates** — an open mic picking up the room means the same exchange is
  transcribed twice under two names seconds apart, the second copy degraded
  ("Bloomberg MCP" -> "Bloomberg answer").

Both are handled here so the live ``.log`` and the ``-recovered.log`` get identical treatment.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .config import SETTINGS
from .transcription import _is_hallucination, strip_hallucinated_tail

# "[2026-06-11T13:05:36.5+00:00] Display Name: spoken text"
TRANSCRIPT_LINE_RE = re.compile(r"^\[([^\]]+)\]\s+(.+?):\s(.*)$")

_WORD_RE = re.compile(r"\w+", re.UNICODE)


@dataclass(slots=True)
class TranscriptLine:
    timestamp: datetime | None
    speaker: str
    text: str
    raw: str

    @property
    def tokens(self) -> set[str]:
        return set(_WORD_RE.findall(self.text.lower()))


@dataclass(slots=True)
class CleaningReport:
    total: int = 0
    kept: int = 0
    dropped_hallucination: list[str] = field(default_factory=list)
    dropped_repetition: list[str] = field(default_factory=list)
    dropped_duplicate: list[str] = field(default_factory=list)
    trimmed_tails: int = 0

    @property
    def dropped(self) -> int:
        return len(self.dropped_hallucination) + len(self.dropped_repetition) + len(self.dropped_duplicate)


def _parse_timestamp(raw: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def parse_transcript(text: str) -> tuple[list[TranscriptLine], list[str]]:
    """Split into structured lines plus any unparseable lines, which are preserved verbatim."""
    lines: list[TranscriptLine] = []
    unparsed: list[str] = []
    for raw in text.splitlines():
        if not raw.strip():
            continue
        match = TRANSCRIPT_LINE_RE.match(raw)
        if match is None:
            unparsed.append(raw)
            continue
        lines.append(
            TranscriptLine(
                timestamp=_parse_timestamp(match.group(1)),
                speaker=match.group(2).strip(),
                text=match.group(3).strip(),
                raw=raw,
            )
        )
    return lines, unparsed


def _is_degenerate_repetition(text: str) -> bool:
    """Whisper repetition loops, e.g. "ja, ja, ja, ja, ja, ja" or a phrase echoed verbatim.

    Requires enough words that a real emphatic repeat ("no, no, no") is not caught.
    """
    words = _WORD_RE.findall(text.lower())
    if len(words) < 8:
        return False
    unique_ratio = len(set(words)) / len(words)
    if unique_ratio <= 0.25:
        return True
    # A short phrase repeated back-to-back three or more times.
    for size in (2, 3, 4):
        if len(words) < size * 3:
            continue
        window = words[:size]
        repeats = 1
        for start in range(size, len(words) - size + 1, size):
            if words[start : start + size] == window:
                repeats += 1
            else:
                break
        if repeats >= 3 and repeats * size >= len(words) * 0.8:
            return True
    return False


def _similarity(a: TranscriptLine, b: TranscriptLine) -> float:
    """Token-set overlap (Jaccard). Robust to the word-level variation between two ASR passes
    over the same audio, and linear rather than the quadratic cost of SequenceMatcher."""
    ta, tb = a.tokens, b.tokens
    if not ta or not tb:
        return 0.0
    intersection = len(ta & tb)
    return intersection / len(ta | tb)


def clean_transcript(text: str) -> tuple[str, CleaningReport]:
    """Return (cleaned transcript, report). Ordering is by speech time.

    Lines are dropped only when the ENTIRE line is filler, so a filler phrase inside a real
    utterance always survives.
    """
    lines, unparsed = parse_transcript(text)
    report = CleaningReport(total=len(lines))

    survivors: list[TranscriptLine] = []
    for line in lines:
        if not line.text:
            continue
        if _is_hallucination(line.text):
            report.dropped_hallucination.append(line.raw)
            continue
        salvaged = strip_hallucinated_tail(line.text)
        if salvaged != line.text:
            if not salvaged:
                report.dropped_hallucination.append(line.raw)
                continue
            # Keep the real content, drop only the appended boilerplate.
            report.trimmed_tails += 1
            line.text = salvaged
            line.raw = line.raw[: line.raw.rindex(line.raw.split(": ", 1)[-1])] + salvaged
        if _is_degenerate_repetition(line.text):
            report.dropped_repetition.append(line.raw)
            continue
        survivors.append(line)

    # Sort by speech time. Write order inverts speech order often enough (~5% of adjacent
    # pairs) that this is load-bearing, not a hedge.
    survivors.sort(key=lambda item: (item.timestamp is None, item.timestamp or datetime.min.replace(tzinfo=timezone.utc)))

    threshold = SETTINGS.dedup_similarity
    window = SETTINGS.dedup_window_seconds
    dropped: set[int] = set()
    for i, line in enumerate(survivors):
        if i in dropped:
            continue
        for j in range(i + 1, len(survivors)):
            if j in dropped:
                continue
            other = survivors[j]
            if line.timestamp and other.timestamp:
                delta = (other.timestamp - line.timestamp).total_seconds()
                if delta > window:
                    break
            if other.speaker == line.speaker:
                continue
            if _similarity(line, other) < threshold:
                continue
            # Keep the richer copy: the echo is the degraded one and is usually shorter.
            loser = j if len(other.text) <= len(line.text) else i
            dropped.add(loser)
            report.dropped_duplicate.append(survivors[loser].raw)
            if loser == i:
                break

    kept = [line for i, line in enumerate(survivors) if i not in dropped]
    report.kept = len(kept)
    rendered = unparsed + [line.raw for line in kept]
    return "\n".join(rendered), report
