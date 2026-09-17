from __future__ import annotations

import logging
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from summarise_bot.config import SETTINGS
from summarise_bot.transcript import TranscriptStore

SESSION = "1361291235549118507:1361316314999816252"


class TranscriptStoreTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        original = SETTINGS.transcript_dir
        SETTINGS.transcript_dir = Path(tmp.name)
        self.addCleanup(setattr, SETTINGS, "transcript_dir", original)
        self.store = TranscriptStore()

    async def _write(self, text: str, stamp: str) -> Path:
        return await self.store.write_line(
            guild_id="1361291235549118507", channel_id="1361316314999816252",
            session_id=SESSION, username="Fabi", text=text, timestamp=stamp,
        )

    async def test_lines_of_one_meeting_share_a_file(self):
        first = await self._write("erster Punkt", "2026-09-15T07:10:00+00:00")
        second = await self._write("zweiter Punkt", "2026-09-15T07:11:00+00:00")
        self.assertEqual(first, second)

    async def test_a_new_meeting_does_not_inherit_a_late_writers_file(self):
        # Reproduces 2026-09-16: Tuesday's stop_session timed out, so a segment was written
        # after release() and memoised a fresh path, and Wednesday's standup appended to it.
        clock = [datetime(2026, 9, 15, 7, 0, tzinfo=timezone.utc),
                 datetime(2026, 9, 15, 7, 42, tzinfo=timezone.utc),
                 datetime(2026, 9, 16, 7, 0, tzinfo=timezone.utc)]
        with patch("summarise_bot.transcript.datetime") as fake:
            fake.now.side_effect = clock
            tuesday = await self._write("Dienstag Meeting", "2026-09-15T07:10:00+00:00")
            self.store.release(SESSION)
            late = await self._write("Nachzuegler nach dem Leave", "2026-09-15T07:40:00+00:00")
            self.assertNotEqual(late, tuesday)

            self.store.start_session(SESSION)
            wednesday = await self._write("Mittwoch Standup", "2026-09-16T07:01:00+00:00")

        self.assertNotEqual(wednesday, late)
        self.assertNotIn("Nachzuegler", wednesday.read_text(encoding="utf-8"))
        self.assertIn("Mittwoch Standup", wednesday.read_text(encoding="utf-8"))

    async def test_start_session_is_safe_when_nothing_is_memoised(self):
        self.store.start_session(SESSION)  # must not raise
        self.assertNotIn(SESSION, self.store.session_logs)


class RegisterSessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)

    async def test_registering_a_session_starts_a_fresh_transcript(self):
        from summarise_bot.bot import ActiveSession, SummariseBotRuntime

        runtime = SummariseBotRuntime()
        runtime.transcript_store.session_logs[SESSION] = Path("/tmp/stale-from-last-meeting.log")
        active = ActiveSession(session_id=SESSION, guild_id=42, channel_id=555, protocol=None)
        runtime.register_session(active)
        self.assertNotIn(SESSION, runtime.transcript_store.session_logs)
        self.assertIs(runtime.active_sessions[42], active)


if __name__ == "__main__":
    unittest.main()
