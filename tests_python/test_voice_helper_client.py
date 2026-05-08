from __future__ import annotations

import unittest

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
            self.assertEqual(segments, [])
            self.assertEqual(session_errors, [])
        finally:
            await client.shutdown()


if __name__ == "__main__":
    unittest.main()
