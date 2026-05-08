from __future__ import annotations

from datetime import datetime, timezone
import unittest
from zoneinfo import ZoneInfo

from summarise_bot.config import SETTINGS
from summarise_bot.reminders import WEEKLY_REMINDER_MESSAGE, WeeklyReminderScheduler, calculate_next_run


class FakeTextChannel:
    def __init__(self) -> None:
        self.messages: list[str] = []

    async def send(self, message: str) -> None:
        self.messages.append(message)


class FakeBot:
    def __init__(self, channel_id: int, channel: FakeTextChannel) -> None:
        self.channel_id = channel_id
        self.channel = channel

    def get_channel(self, channel_id: int):
        if channel_id == self.channel_id:
            return self.channel
        return None

    async def fetch_channel(self, channel_id: int):
        return self.get_channel(channel_id)


class WeeklyReminderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._original_channel_id = SETTINGS.weekly_meeting_channel_id
        SETTINGS.weekly_meeting_channel_id = "4242"

    def tearDown(self) -> None:
        SETTINGS.weekly_meeting_channel_id = self._original_channel_id

    def test_calculate_next_run_before_target_time(self) -> None:
        timezone_info = ZoneInfo("Europe/Berlin")
        now_utc = datetime(2026, 5, 6, 7, 0, tzinfo=timezone.utc)
        next_run = calculate_next_run(now_utc, timezone_info)
        next_local = next_run.astimezone(timezone_info)
        self.assertEqual(next_local.weekday(), 3)
        self.assertEqual(next_local.hour, 9)
        self.assertEqual(next_local.minute, 0)

    def test_calculate_next_run_after_target_time_moves_to_next_week(self) -> None:
        timezone_info = ZoneInfo("Europe/Berlin")
        now_utc = datetime(2026, 5, 7, 8, 0, tzinfo=timezone.utc)
        next_run = calculate_next_run(now_utc, timezone_info)
        next_local = next_run.astimezone(timezone_info)
        self.assertEqual(next_local.weekday(), 3)
        self.assertGreaterEqual((next_run - now_utc).days, 6)

    async def test_send_reminder_posts_expected_message(self) -> None:
        channel_id = int(SETTINGS.weekly_meeting_channel_id)
        channel = FakeTextChannel()
        bot = FakeBot(channel_id, channel)
        scheduler = WeeklyReminderScheduler(bot)
        await scheduler.send_reminder()
        self.assertEqual(channel.messages, [WEEKLY_REMINDER_MESSAGE])


if __name__ == "__main__":
    unittest.main()
