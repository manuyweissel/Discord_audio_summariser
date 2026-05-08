from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
import unittest

from summarise_bot.config import SETTINGS
from summarise_bot.health import OpsServer, format_grafana_alert_message


class FakeThread:
    def __init__(self, thread_id: int) -> None:
        self.id = thread_id
        self.messages: list[str] = []

    async def send(self, message: str) -> None:
        self.messages.append(message)


class FakeIncidentsChannel:
    def __init__(self) -> None:
        self.created_threads = 0
        self.threads: dict[int, FakeThread] = {}

    async def create_thread(self, *, name: str, auto_archive_duration: int, type) -> FakeThread:
        del type
        self.created_threads += 1
        thread = FakeThread(8000 + self.created_threads)
        thread.name = name
        thread.auto_archive_duration = auto_archive_duration
        self.threads[thread.id] = thread
        return thread


class FakeBot:
    def __init__(self, incidents_channel_id: int, incidents_channel: FakeIncidentsChannel) -> None:
        self.incidents_channel_id = incidents_channel_id
        self.incidents_channel = incidents_channel

    def get_channel(self, channel_id: int):
        if channel_id == self.incidents_channel_id:
            return self.incidents_channel
        return self.incidents_channel.threads.get(channel_id)

    async def fetch_channel(self, channel_id: int):
        return self.get_channel(channel_id)


class OpsServerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._original_incidents_channel_id = SETTINGS.incidents_channel_id
        self._original_secret = SETTINGS.grafana_webhook_secret
        SETTINGS.incidents_channel_id = "12345"
        SETTINGS.grafana_webhook_secret = "secret-token"
        incidents_channel_id = int(SETTINGS.incidents_channel_id)
        self.fake_channel = FakeIncidentsChannel()
        self.bot = FakeBot(incidents_channel_id, self.fake_channel)
        self.server = OpsServer(
            self.bot,
            lambda: {"status": "ok", "activeSessions": 2, "helperReady": True, "recovery": {"isRecovering": False}},
        )

    def tearDown(self) -> None:
        SETTINGS.incidents_channel_id = self._original_incidents_channel_id
        SETTINGS.grafana_webhook_secret = self._original_secret

    def test_format_grafana_alert_message_sanitizes_markdown(self) -> None:
        message = format_grafana_alert_message(
            {
                "ruleName": "@here **critical**",
                "state": "firing",
                "message": "line1\n\n\nline2",
                "ruleUrl": "https://example.invalid/_`test`_",
            }
        )
        self.assertIn("\\@here", message)
        self.assertIn("\\*\\*critical\\*\\*", message)
        self.assertIn("line1\n\nline2", message)
        self.assertIn("https://example.invalid/\\_\\`test\\`\\_", message)

    def test_validate_webhook_request_rejects_invalid_secret(self) -> None:
        response = self.server.validate_webhook_request({"x-webhook-secret": "wrong"}, "127.0.0.1")
        self.assertIsNotNone(response)
        assert response is not None
        self.assertEqual(response.status, 401)

    async def test_daily_thread_is_reused_from_cache(self) -> None:
        first = await self.server.get_or_create_daily_grafana_thread("2026-05-08")
        second = await self.server.get_or_create_daily_grafana_thread("2026-05-08")
        self.assertIs(first, second)
        self.assertEqual(self.fake_channel.created_threads, 1)

    def test_build_health_state_contains_ops_details(self) -> None:
        self.server.started_at = datetime(2026, 5, 8, 9, 0, tzinfo=timezone.utc)
        self.server.started_monotonic = 1.0
        self.server.daily_threads["2026-05-08"] = 999
        state = self.server.build_health_state()
        self.assertEqual(state["activeSessions"], 2)
        self.assertTrue(state["helperReady"])
        self.assertEqual(state["grafana"]["enabled"], True)
        self.assertEqual(state["grafana"]["dailyThreadsTracked"], 1)
        self.assertIn("memory", state)


if __name__ == "__main__":
    unittest.main()
