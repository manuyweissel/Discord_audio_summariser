from __future__ import annotations

import sys
import unittest
import wave
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from docx import Document as DocxDocument

from summarise_bot.config import SETTINGS
from summarise_bot.document import convert_to_word_doc, extract_meeting_date
from summarise_bot.summarization import _extract_meeting_facts, chunk_text
from summarise_bot.transcript_cleaning import clean_transcript
from summarise_bot.transcription import _is_hallucination, _passes_audio_gate, strip_hallucinated_tail


def _line(ts: str, who: str, text: str) -> str:
    return f"[2026-07-23T13:{ts}+00:00] {who}: {text}"


class HallucinationFilterTests(unittest.TestCase):
    def test_whole_line_filler_is_dropped(self):
        for text in ("Thank you.", "Bye.", "you", "You", "Mm-hmm.", "Peace."):
            self.assertTrue(_is_hallucination(text), text)

    def test_filler_inside_a_real_utterance_survives(self):
        # The exact phrases above must never be stripped out of real speech.
        text = "Thank you for the update, we will ship the LSEG connector next week."
        self.assertFalse(_is_hallucination(text))
        cleaned, report = clean_transcript(_line("20:19.0", "chris", text))
        self.assertIn("LSEG connector", cleaned)
        self.assertEqual(report.kept, 1)

    def test_caption_tail_is_trimmed_not_dropped(self):
        real = "We verify the vectors land in the Milvus database for every document."
        kept = strip_hallucinated_tail(f"{real} Thanks for watching.")
        self.assertEqual(kept, real)

    def test_tail_trim_drops_line_with_no_real_content(self):
        self.assertEqual(strip_hallucinated_tail("Okay. Thanks for watching."), "")


class DedupTests(unittest.TestCase):
    def test_cross_speaker_echo_is_deduped_keeping_richer_copy(self):
        rich = "We cannot replicate the complete stock report yet, so we are still working on it."
        echo = "We cannot replicate the complete stock report yet so we are working on it."
        transcript = "\n".join([_line("22:19.0", "Manú", rich), _line("22:22.0", "chris", echo)])
        cleaned, report = clean_transcript(transcript)
        self.assertEqual(report.kept, 1)
        self.assertEqual(len(report.dropped_duplicate), 1)
        self.assertIn(rich, cleaned)

    def test_same_speaker_repeats_are_kept(self):
        text = "We cannot replicate the complete stock report yet, so we keep working on it."
        transcript = "\n".join([_line("22:19.0", "Manú", text), _line("22:22.0", "Manú", text)])
        _, report = clean_transcript(transcript)
        self.assertEqual(report.kept, 2)

    def test_unrelated_lines_are_not_deduped(self):
        transcript = "\n".join([
            _line("22:19.0", "Manú", "The retrieval pipeline needs fewer tokens per call."),
            _line("22:22.0", "chris", "Marcus Klein is the managing director we met yesterday."),
        ])
        _, report = clean_transcript(transcript)
        self.assertEqual(report.kept, 2)

    def test_output_is_ordered_by_speech_time(self):
        transcript = "\n".join([
            _line("30:00.0", "chris", "This sentence was written to the log second in order."),
            _line("20:00.0", "Manú", "This sentence happened first but landed later in the file."),
        ])
        cleaned, _ = clean_transcript(transcript)
        self.assertTrue(cleaned.splitlines()[0].startswith("[2026-07-23T13:20:00.0"))


class AudioGateTests(unittest.TestCase):
    @staticmethod
    def _wav(path: Path, amplitude: int, seconds: float = 0.5) -> None:
        frames = int(48000 * seconds)
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(48000)
            sample = int(amplitude).to_bytes(2, "little", signed=True) * 2
            wav.writeframes(sample * frames)

    def test_silence_is_blocked_before_the_api(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "silent.wav"
            self._wav(path, 0)
            allowed, reason = _passes_audio_gate(path)
            self.assertFalse(allowed)
            self.assertIn("Below speech threshold", reason)

    def test_loud_audio_passes(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "loud.wav"
            self._wav(path, 6000)
            self.assertTrue(_passes_audio_gate(path)[0])

    def test_unreadable_audio_fails_open(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.wav"
            path.write_bytes(b"not a wav")
            self.assertTrue(_passes_audio_gate(path)[0])

    def test_gate_is_disabled_when_threshold_is_zero(self):
        original = SETTINGS.whisper_min_rms
        SETTINGS.whisper_min_rms = 0
        try:
            with TemporaryDirectory() as tmp:
                path = Path(tmp) / "silent.wav"
                self._wav(path, 0)
                self.assertTrue(_passes_audio_gate(path)[0])
        finally:
            SETTINGS.whisper_min_rms = original


class ParticipantTests(unittest.TestCase):
    def test_filler_only_speakers_are_excluded(self):
        transcript = "\n".join([
            _line("20:00.0", "Manú", "We agreed to send the draft template to Aareal this week."),
            _line("20:05.0", "sasi2400", "you"),
        ])
        facts = _extract_meeting_facts(transcript, min_speech_chars=40)
        self.assertEqual(facts["participants"], "Manú")

    def test_default_keeps_every_speaker(self):
        transcript = "\n".join([_line("20:00.0", "Manú", "ok"), _line("20:05.0", "Mark", "yes")])
        self.assertEqual(_extract_meeting_facts(transcript)["participants"], "Manú, Mark")


class ChunkingTests(unittest.TestCase):
    def test_chunks_never_split_a_line(self):
        lines = [_line(f"{20 + i:02d}:00.0", "Manú", "x" * 200) for i in range(20)]
        chunks = chunk_text("\n".join(lines), max_tokens=200)
        self.assertGreater(len(chunks), 1)
        rejoined = [l for c in chunks for l in c.splitlines()]
        self.assertEqual(rejoined, lines)


class DocxRenderingTests(unittest.TestCase):
    MARKDOWN = (
        "# Meeting Minutes — 23.07.2026\n\n"
        "## Meeting Topic\nStrategy sync\n\n"
        "## Details\n- **Date:** 23.07.2026\n\n---\n\n"
        "## Notes\n- Ship the **LSEG** connector.\n"
    )

    def _paragraphs(self):
        data = convert_to_word_doc(self.MARKDOWN, "Strategy sync")
        self.assertIsNotNone(data)
        return DocxDocument(BytesIO(data)).paragraphs

    def test_h1_does_not_leak_as_body_text(self):
        self.assertFalse(any(p.text.strip().startswith("#") for p in self._paragraphs()))

    def test_horizontal_rule_is_not_rendered(self):
        self.assertFalse(any(p.text.strip() == "---" for p in self._paragraphs()))

    def test_bold_markers_become_runs_not_asterisks(self):
        paragraphs = self._paragraphs()
        self.assertFalse(any("**" in p.text for p in paragraphs))
        bolded = {r.text for p in paragraphs for r in p.runs if r.bold}
        self.assertIn("LSEG", bolded)

    def test_subtitle_uses_the_meeting_date(self):
        self.assertEqual(extract_meeting_date(self.MARKDOWN), "23.07.2026")
        self.assertIn("23.07.2026", self._paragraphs()[1].text)

    def test_unrelated_bullet_is_not_mistaken_for_a_date(self):
        self.assertIsNone(extract_meeting_date("- **Owner:** chris - and due later\n"))


if __name__ == "__main__":
    unittest.main()
