"""Join the meeting voice channel on a schedule, leave once it empties, and post the minutes.

Meetings used to be recorded only when somebody ran /join by hand, so a late join lost the start
of the meeting — on 2026-09-10 the 15:00 meeting was joined at 15:54 and only 4 of its 60 minutes
were captured. The bot also stayed in the channel after everyone had gone, until someone ran
/leave or the window closed.

The scheduler polls rather than sleeping until a start time, so a restart in the middle of a
window recovers correctly. It waits for a person to be present before joining, so an empty room
is never recorded (which also covers a biweekly meeting's off weeks), and it leaves once the room
has stayed empty for AUTO_LEAVE_EMPTY_SECONDS — long enough that a dropped connection or someone
rejoining does not split one meeting into two sets of minutes.
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import discord

from .config import SETTINGS
from .logger import logger
from .reminders import _load_timezone
from .schedule import MeetingWindow, ScheduleError, active_window, next_window, parse_schedule

if TYPE_CHECKING:  # pragma: no cover
    from .bot import ActiveSession, SummariseBotRuntime

_POST_MESSAGE = "📝 **Meeting-Protokoll erstellt!** 📄"
_LEAVE_NOTES = {
    "channel_empty": "\n_Alle haben den Sprachkanal verlassen – Aufnahme automatisch beendet._",
}


class AutoJoinScheduler:
    def __init__(self, runtime: "SummariseBotRuntime") -> None:
        self.runtime = runtime
        self.timezone = _load_timezone(SETTINGS.timezone)
        self.windows: list[MeetingWindow] = []
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()
        # session_id -> (id of the session object, when the room was first seen empty). Session
        # ids are "guild:channel" and repeat, so the object id stops a later session in the same
        # channel from inheriting a stale timer.
        self._empty_since: dict[str, tuple[int, datetime]] = {}
        # (window label, date) paused by a manual /leave, so the bot does not walk straight back
        # into a room that still has people in it.
        self._suppressed: tuple[str, date] | None = None

    # ---------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        self._load_windows()
        grace = SETTINGS.auto_leave_empty_seconds
        if grace > 0:
            logger.info(
                "Auto-leave enabled",
                extra={"action": "auto_join", "event": "auto_leave_enabled", "grace_seconds": grace},
            )
        if not self.windows and grace <= 0:
            return
        self._task = asyncio.create_task(self._loop())

    def _load_windows(self) -> None:
        if not SETTINGS.auto_join_enabled:
            logger.info("Auto-join disabled", extra={"action": "auto_join", "event": "disabled"})
            return
        if not SETTINGS.auto_join_voice_channel_id:
            logger.warning(
                "Auto-join enabled but AUTO_JOIN_VOICE_CHANNEL_ID is unset",
                extra={"action": "auto_join", "event": "no_channel"},
            )
            return
        try:
            windows = parse_schedule(SETTINGS.auto_join_schedule)
        except ScheduleError as error:
            logger.error(
                "Auto-join schedule is invalid; scheduler not started",
                extra={"action": "auto_join", "event": "bad_schedule", "error_message": str(error)},
            )
            return
        if not windows:
            return
        self.windows = windows

        # Resolve the channel once at startup. Without this an unreachable or mistyped id would
        # just mean the bot silently never joins, with nothing in the log to explain it.
        channel = self._voice_channel()
        if channel is None:
            logger.error(
                "Auto-join voice channel could not be resolved; the bot will never join",
                extra={
                    "action": "auto_join",
                    "event": "channel_unresolved",
                    "voice_channel_id": SETTINGS.auto_join_voice_channel_id,
                },
            )
        else:
            logger.info(
                "Auto-join voice channel resolved",
                extra={
                    "action": "auto_join",
                    "event": "channel_resolved",
                    "voice_channel_id": str(channel.id),
                    "channel_name": getattr(channel, "name", "?"),
                    "humans_present": sum(1 for m in getattr(channel, "members", []) if not m.bot),
                },
            )

        upcoming = next_window(self.windows, self._local(None))
        logger.info(
            "Auto-join scheduler started",
            extra={
                "action": "auto_join",
                "event": "started",
                "windows": [window.label for window in self.windows],
                "voice_channel_id": SETTINGS.auto_join_voice_channel_id,
                "timezone": SETTINGS.timezone,
                "next_start": upcoming[1].isoformat() if upcoming else None,
            },
        )

    async def stop(self) -> None:
        self._stopping.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    def _local(self, now: datetime | None) -> datetime:
        """Naive local time in the schedule's timezone."""
        if now is None:
            now = datetime.now(self.timezone)
        if now.tzinfo is not None:
            now = now.astimezone(self.timezone)
        return now.replace(tzinfo=None)

    # ---------------------------------------------------------------- main loop

    async def _loop(self) -> None:
        while not self._stopping.is_set():
            try:
                await self.tick()
            except Exception as error:  # never let one bad tick kill the scheduler
                logger.error(
                    "Auto-join tick failed",
                    extra={"action": "auto_join", "event": "tick_error", "error_message": str(error)},
                )
            try:
                await asyncio.wait_for(
                    self._stopping.wait(), timeout=max(5, SETTINGS.auto_join_poll_seconds)
                )
            except asyncio.TimeoutError:
                continue

    async def tick(self, now: datetime | None = None) -> None:
        """One scheduling decision. Separated from the loop so it can be tested directly."""
        moment = self._local(now)
        await self._leave_empty_sessions(moment)
        if self.windows:
            await self._apply_windows(moment)

    async def _leave_empty_sessions(self, moment: datetime) -> None:
        """Finish any session whose voice channel has had no person in it for the grace period.

        Applies to manual /join sessions too: an empty room means the meeting is over however
        the bot got there.
        """
        sessions = list(self.runtime.active_sessions.values())
        live = {session.session_id for session in sessions}
        for session_id in list(self._empty_since):
            if session_id not in live:
                del self._empty_since[session_id]

        grace = SETTINGS.auto_leave_empty_seconds
        if grace <= 0:
            self._empty_since.clear()
            return

        for session in sessions:
            if session.finishing:
                continue
            channel = self._session_channel(session)
            if channel is None:
                continue  # cannot see the room, so never leave blind
            if self._humans_present(channel):
                if self._empty_since.pop(session.session_id, None) is not None:
                    logger.info(
                        "Voice channel occupied again; staying",
                        extra={"action": "auto_join", "event": "empty_cleared", "session_id": session.session_id},
                    )
                continue
            marker = self._empty_since.get(session.session_id)
            if marker is None or marker[0] != id(session):
                self._empty_since[session.session_id] = (id(session), moment)
                logger.info(
                    "Voice channel is empty; leaving if it stays empty",
                    extra={
                        "action": "auto_join",
                        "event": "empty_detected",
                        "session_id": session.session_id,
                        "grace_seconds": grace,
                    },
                )
                continue
            if (moment - marker[1]).total_seconds() < grace:
                continue
            await self._stop(session, reason="channel_empty")

    async def _apply_windows(self, moment: datetime) -> None:
        window = active_window(self.windows, moment)
        channel = self._voice_channel()
        if channel is None:
            return
        session = self.runtime.active_sessions.get(channel.guild.id)

        if window is None:
            # Outside every window: stop only what the scheduler started itself.
            if session is not None and session.auto_window is not None and not session.finishing:
                await self._stop(session, reason="window_ended")
            return

        if session is not None:
            return  # already recording (or finishing), whoever started it
        if self._suppressed == (window.label, moment.date()):
            return  # someone ran /leave during this window
        if not self._humans_present(channel):
            return  # wait for the meeting to actually begin
        await self._start(channel, window)

    def suppress_active_window(self, now: datetime | None = None) -> None:
        """On a manual /leave, do not rejoin for the rest of the current window."""
        moment = self._local(now)
        window = active_window(self.windows, moment)
        if window is None:
            return
        self._suppressed = (window.label, moment.date())
        logger.info(
            "Auto-join paused for the rest of this window after a manual /leave",
            extra={"action": "auto_join", "event": "window_suppressed", "window": window.label},
        )

    # ---------------------------------------------------------------- channels

    def _voice_channel(self) -> discord.VoiceChannel | None:
        try:
            channel = self.runtime.bot.get_channel(int(SETTINGS.auto_join_voice_channel_id or 0))
        except (TypeError, ValueError):
            return None
        return channel if isinstance(channel, discord.VoiceChannel) else None

    def _session_channel(self, session: "ActiveSession") -> Any | None:
        try:
            channel = self.runtime.bot.get_channel(int(session.channel_id))
        except (TypeError, ValueError):
            return None
        return channel if isinstance(channel, (discord.VoiceChannel, discord.StageChannel)) else None

    @staticmethod
    def _humans_present(channel: Any) -> bool:
        return any(not member.bot for member in getattr(channel, "members", []))

    # ---------------------------------------------------------------- actions

    async def _start(self, channel: discord.VoiceChannel, window: MeetingWindow) -> None:
        try:
            await self.runtime.helper.ensure_ready()
            active = await self.runtime._connect_and_start(channel, attempts=3)
        except Exception as error:
            logger.error(
                "Auto-join failed to start recording",
                extra={
                    "action": "auto_join",
                    "event": "start_failed",
                    "window": window.label,
                    "error_message": str(error),
                },
            )
            return
        active.auto_window = window.label
        active.post_channel_id = window.post_channel_id
        self.runtime.active_sessions[channel.guild.id] = active
        logger.info(
            "Auto-join started recording",
            extra={
                "action": "auto_join",
                "event": "recording_started",
                "window": window.label,
                "session_id": active.session_id,
                "channel_id": str(channel.id),
            },
        )

    async def _stop(self, session: "ActiveSession", *, reason: str) -> None:
        if not self.runtime.claim_session(session):
            return  # /leave or another path is already finishing it
        self._empty_since.pop(session.session_id, None)
        label = session.auto_window or "manual /join"
        logger.info(
            "Auto-leave: finishing session",
            extra={"action": "auto_join", "event": reason, "window": label, "session_id": session.session_id},
        )
        summary_path = await self.runtime.finish_session(session, require_substance=True)
        if summary_path is None or not summary_path.exists():
            # Expected for a drop-in too short to be a meeting; finish_session logs the reason.
            logger.info(
                "Auto-leave produced no minutes",
                extra={"action": "auto_join", "event": "no_summary", "window": label, "reason": reason},
            )
            return
        await self._post(session.post_channel_id, summary_path, label, reason)

    async def _post(self, channel_id: int | None, summary_path: Path, label: str, reason: str) -> None:
        if not channel_id:
            logger.info(
                "No channel to post the minutes to; saved to disk only",
                extra={"action": "auto_join", "event": "not_posted", "window": label, "file": summary_path.name},
            )
            return
        file = None
        try:
            channel = self.runtime.bot.get_channel(int(channel_id))
            if channel is None:
                channel = await self.runtime.bot.fetch_channel(int(channel_id))
            file = discord.File(str(summary_path), filename=summary_path.name)
            await channel.send(content=_POST_MESSAGE + _LEAVE_NOTES.get(reason, ""), file=file)
            logger.info(
                "Auto-join posted minutes",
                extra={
                    "action": "auto_join",
                    "event": "posted",
                    "window": label,
                    "reason": reason,
                    "channel_id": str(channel_id),
                    "file": summary_path.name,
                },
            )
        except Exception as error:
            logger.error(
                "Auto-join could not post the minutes",
                extra={
                    "action": "auto_join",
                    "event": "post_failed",
                    "window": label,
                    "channel_id": str(channel_id),
                    "file": summary_path.name,
                    "error_message": str(error),
                },
            )
        finally:
            if file is not None:
                file.close()
