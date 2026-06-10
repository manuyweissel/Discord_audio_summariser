from __future__ import annotations

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from summarise_bot.config import SETTINGS
from summarise_bot.voice_helper_client import VoiceHelperClient


class VoiceHelperClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_helper_startup_and_ready_check(self) -> None:
        segments: list[dict[str, object]] = []
        session_errors: list[dict[str, object]] = []

        async def on_segment_ready(payload: dict[str, object]) -> None:
            segments.append(payload)

        async def on_session_error(payload: dict[str, object]) -> None:
            session_errors.append(payload)

        client = VoiceHelperClient(on_segment_ready, on_session_error)
        try:
            await client.start()
            response = await client.request("ready_check", {})
            self.assertTrue(response["ready"])
            self.assertTrue(client.is_ready)
            self.assertTrue(client.get_state()["ready"])
            self.assertEqual(segments, [])
            self.assertEqual(session_errors, [])
        finally:
            await client.shutdown()

    async def test_start_failure_cleans_up_process_and_tasks(self) -> None:
        async def on_segment_ready(payload: dict[str, object]) -> None:
            del payload

        client = VoiceHelperClient(on_segment_ready)
        original_helper_path = SETTINGS.helper_path
        with tempfile.TemporaryDirectory() as tmpdir:
            helper_path = Path(tmpdir) / "fake-helper.py"
            helper_path.write_text("#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n", encoding="utf-8")
            os.chmod(helper_path, 0o755)
            SETTINGS.helper_path = str(helper_path)
            try:
                with self.assertRaisesRegex(RuntimeError, "exited during startup"):
                    await client.start()
                self.assertIsNone(client.process)
                self.assertIsNone(client._reader_task)
                self.assertIsNone(client._stderr_task)
                self.assertFalse(client.is_ready)
            finally:
                SETTINGS.helper_path = original_helper_path

    def test_repeated_stderr_errors_collapse_to_one_log_line(self) -> None:
        async def on_segment_ready(payload: dict[str, object]) -> None:
            del payload

        client = VoiceHelperClient(on_segment_ready)
        # Same message, different millisecond timestamps — should dedup to one bucket and
        # emit a single rate-limited warning rather than one per line.
        lines = [f"2026-06-10 13:15:14,{ms} [ERROR] decryption failed: 1" for ms in range(300, 312)]
        with patch("summarise_bot.voice_helper_client.logger") as log:
            for line in lines:
                client._record_rate_limited_stderr(line)
            # collapses to a single emission, kept at debug (benign DAVE noise)
            self.assertEqual(log.debug.call_count, 1)
            self.assertEqual(log.warning.call_count, 0)
        self.assertEqual(list(client._stderr_suppression.keys()), ["decryption failed: 1"])


if __name__ == "__main__":
    unittest.main()
