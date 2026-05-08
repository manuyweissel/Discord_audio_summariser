from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import discord

from .config import SETTINGS
from .logger import logger


WEEKLY_REMINDER_MESSAGE = (
    "📝 Weekly prep: Please add agenda bullets for the weekly meeting to the current thread "
    "and the shared doc:\n"
    "https://docs.google.com/document/d/1P_3opjrJlhraPfpcRjGKUqtw2QwsmdSTp74tocNcNxg/edit?usp=sharing"
)


class WeeklyReminderScheduler:
    def __init__(self, bot: discord.Bot) -> None:
        self.bot = bot
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._task is not None:
            return
        if not SETTINGS.weekly_meeting_channel_id:
            logger.warning("WEEKLY_MEETING_CHANNEL_ID not set – weekly reminders disabled")
            return
        logger.info(
            "Weekly meeting reminder scheduled",
            extra={"action": "weekly_reminder", "event": "scheduled", "timezone": SETTINGS.timezone},
        )
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)
        self._task = None

    async def _run_loop(self) -> None:
        timezone_info = _load_timezone(SETTINGS.timezone)
        while True:
            next_run = calculate_next_run(datetime.now(timezone.utc), timezone_info)
            delay_seconds = max(0.0, (next_run - datetime.now(timezone.utc)).total_seconds())
            try:
                await asyncio.sleep(delay_seconds)
            except asyncio.CancelledError:
                raise
            await self.send_reminder()

    async def send_reminder(self) -> None:
        if not SETTINGS.weekly_meeting_channel_id:
            return
        try:
            channel_id = int(SETTINGS.weekly_meeting_channel_id)
            channel = self.bot.get_channel(channel_id)
            if channel is None:
                channel = await self.bot.fetch_channel(channel_id)
            if channel is None or not hasattr(channel, "send"):
                raise RuntimeError("Weekly reminder channel not found or not text-based")
            await channel.send(WEEKLY_REMINDER_MESSAGE)
            logger.info("Weekly meeting reminder sent", extra={"action": "weekly_reminder", "event": "complete"})
        except Exception as error:
            logger.error(
                "Failed to send weekly meeting reminder",
                extra={"action": "weekly_reminder", "event": "error", "error_message": str(error)},
            )


def _load_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        logger.warning(
            "Configured timezone not found - falling back to Europe/Berlin",
            extra={"action": "weekly_reminder", "event": "timezone_fallback", "timezone": name},
        )
        return ZoneInfo("Europe/Berlin")


def calculate_next_run(now_utc: datetime, timezone_info: ZoneInfo) -> datetime:
    now_local = now_utc.astimezone(timezone_info)
    target_local = now_local.replace(hour=9, minute=0, second=0, microsecond=0)
    days_ahead = (3 - now_local.weekday()) % 7
    if days_ahead == 0 and now_local >= target_local:
        days_ahead = 7
    target_local = target_local + timedelta(days=days_ahead)
    return target_local.astimezone(timezone.utc)
