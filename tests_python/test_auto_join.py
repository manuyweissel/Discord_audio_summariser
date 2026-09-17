from __future__ import annotations

import logging
import sys
import tempfile
import unittest
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from summarise_bot.config import SETTINGS
from summarise_bot.schedule import ScheduleError, active_window, next_window, parse_schedule

SPEC = (
    "mon-fri 09:00-10:00 -> 1364921683936284734; "
    "thu 11:00-12:00 -> 1473976066052984967; "
    "thu 15:00-16:00 -> 1438825022377562122"
)
STANDUP = 1364921683936284734


def at(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp)


class ScheduleParsingTests(unittest.TestCase):
    def test_configured_default_schedule_parses(self):
        windows = parse_schedule(SETTINGS.auto_join_schedule)
        self.assertEqual([w.label for w in windows], [
            "Mon,Tue,Wed,Thu,Fri 09:00-10:00",
            "Thu 11:00-12:00",
            "Thu 15:00-16:00",
        ])

    def test_post_channels_are_per_window(self):
        windows = parse_schedule(SPEC)
        self.assertEqual(windows[0].post_channel_id, 1364921683936284734)
        self.assertEqual(windows[1].post_channel_id, 1473976066052984967)
        self.assertEqual(windows[2].post_channel_id, 1438825022377562122)

    def test_day_lists_and_ranges(self):
        self.assertEqual(parse_schedule("mon,wed,fri 09:00-10:00")[0].days, frozenset({0, 2, 4}))
        self.assertEqual(parse_schedule("sat-sun 09:00-10:00")[0].days, frozenset({5, 6}))

    def test_rejects_malformed_entries(self):
        for bad in ("garbage", "mon 09:00", "mon 10:00-09:00", "funday 09:00-10:00", "mon 25:00-26:00"):
            with self.assertRaises(ScheduleError, msg=bad):
                parse_schedule(bad)


class WindowSelectionTests(unittest.TestCase):
    def setUp(self):
        self.windows = parse_schedule(SPEC)

    def _active(self, stamp: str):
        return active_window(self.windows, at(stamp))

    def test_weekday_morning_window_is_active(self):
        self.assertIsNotNone(self._active("2026-09-11 09:30"))  # Friday

    def test_thursday_extra_windows_are_active(self):
        self.assertEqual(self._active("2026-09-10 11:30").label, "Thu 11:00-12:00")
        self.assertEqual(self._active("2026-09-10 15:30").label, "Thu 15:00-16:00")

    def test_those_windows_do_not_run_on_other_weekdays(self):
        self.assertIsNone(self._active("2026-09-11 11:30"))  # Friday
        self.assertIsNone(self._active("2026-09-09 15:30"))  # Wednesday

    def test_weekend_is_idle(self):
        self.assertIsNone(self._active("2026-09-12 09:30"))
        self.assertIsNone(self._active("2026-09-13 09:30"))

    def test_window_end_is_exclusive(self):
        self.assertIsNotNone(self._active("2026-09-11 09:59"))
        self.assertIsNone(self._active("2026-09-11 10:00"))

    def test_next_window_is_the_soonest(self):
        window, when = next_window(self.windows, at("2026-09-10 10:30"))
        self.assertEqual(window.label, "Thu 11:00-12:00")
        self.assertEqual(when, at("2026-09-10 11:00"))


# ------------------------------------------------------------------------ fakes


class FakeMember:
    def __init__(self, bot: bool = False) -> None:
        self.bot = bot


class FakeGuild:
    id = 42


class FakeVoiceChannel:
    def __init__(self, members) -> None:
        self.id = 1361316314999816252
        self.guild = FakeGuild()
        self.members = list(members)


@dataclass(eq=False)
class FakeSession:
    session_id: str = "42:1361316314999816252"
    guild_id: int = 42
    channel_id: int = 1361316314999816252
    auto_window: str | None = None
    post_channel_id: int | None = None
    finishing: bool = False


class FakeTextChannel:
    def __init__(self, sent: list, channel_id: int) -> None:
        self.sent = sent
        self.channel_id = channel_id

    async def send(self, content=None, file=None):
        if file is not None:
            file.close()
        self.sent.append((self.channel_id, content))


class FakeRuntime:
    """Stands in for SummariseBotRuntime: the scheduler only uses this surface."""

    def __init__(self, summary_path: Path | None) -> None:
        self.active_sessions: dict = {}
        self.bot = self
        self.helper = self
        self.started: list = []
        self.finished: list = []
        self.finish_kwargs: list = []
        self.sent: list = []
        self.summary_path = summary_path
        self.ensure_ready = AsyncMock()

    async def _connect_and_start(self, channel, *, attempts):
        self.started.append(channel)
        return FakeSession(guild_id=channel.guild.id, channel_id=channel.id)

    def register_session(self, session) -> None:
        self.active_sessions[session.guild_id] = session

    def claim_session(self, session) -> bool:
        if session.finishing:
            return False
        session.finishing = True
        return True

    async def finish_session(self, session, *, require_substance: bool = False):
        session.finishing = True
        self.finished.append(session)
        self.finish_kwargs.append(require_substance)
        self.active_sessions.pop(session.guild_id, None)
        return self.summary_path

    def get_channel(self, channel_id):
        return FakeTextChannel(self.sent, channel_id)

    async def fetch_channel(self, channel_id):
        return self.get_channel(channel_id)


class SchedulerTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # The shared logger writes to the real discord-bot.log; test runs must not inject
        # realistic-looking auto_join events into it and confuse later diagnosis.
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        original = SETTINGS.auto_leave_empty_seconds
        SETTINGS.auto_leave_empty_seconds = 120
        self.addCleanup(setattr, SETTINGS, "auto_leave_empty_seconds", original)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.summary = Path(tmp.name) / "Meeting_Minutes_test.docx"
        self.summary.write_bytes(b"docx")

    def scheduler(self, members=(), *, minutes: bool = False):
        from summarise_bot.auto_join import AutoJoinScheduler

        runtime = FakeRuntime(self.summary if minutes else None)
        scheduler = AutoJoinScheduler(runtime)
        scheduler.windows = parse_schedule(SPEC)
        channel = FakeVoiceChannel(members)
        scheduler._voice_channel = lambda: channel
        scheduler._session_channel = lambda session: channel
        return scheduler, runtime, channel


# ------------------------------------------------------------------------ joining


class SchedulerJoinTests(SchedulerTestCase):
    async def test_joins_when_a_human_is_present_in_a_window(self):
        scheduler, runtime, _ = self.scheduler([FakeMember()])
        await scheduler.tick(at("2026-09-11 09:05"))
        self.assertEqual(len(runtime.started), 1)
        self.assertEqual(runtime.active_sessions[42].auto_window, "Mon,Tue,Wed,Thu,Fri 09:00-10:00")
        self.assertEqual(runtime.active_sessions[42].post_channel_id, STANDUP)

    async def test_waits_while_the_room_is_empty(self):
        scheduler, runtime, _ = self.scheduler([])
        await scheduler.tick(at("2026-09-11 09:05"))
        self.assertEqual(runtime.started, [])

    async def test_ignores_a_room_holding_only_bots(self):
        scheduler, runtime, _ = self.scheduler([FakeMember(bot=True)])
        await scheduler.tick(at("2026-09-11 09:05"))
        self.assertEqual(runtime.started, [])

    async def test_joins_late_arrivals_mid_window(self):
        # The 2026-09-10 failure mode: nobody at the start, people at 15:40.
        scheduler, runtime, channel = self.scheduler([])
        await scheduler.tick(at("2026-09-10 15:00"))
        self.assertEqual(runtime.started, [])
        channel.members.append(FakeMember())
        await scheduler.tick(at("2026-09-10 15:40"))
        self.assertEqual(len(runtime.started), 1)

    async def test_does_not_join_outside_a_window(self):
        scheduler, runtime, _ = self.scheduler([FakeMember()])
        await scheduler.tick(at("2026-09-11 14:00"))
        self.assertEqual(runtime.started, [])

    async def test_does_not_start_a_second_session_while_recording(self):
        scheduler, runtime, _ = self.scheduler([FakeMember()])
        await scheduler.tick(at("2026-09-11 09:05"))
        await scheduler.tick(at("2026-09-11 09:30"))
        self.assertEqual(len(runtime.started), 1)

    async def test_window_end_finishes_and_posts_to_the_window_channel(self):
        scheduler, runtime, _ = self.scheduler([FakeMember()], minutes=True)
        await scheduler.tick(at("2026-09-11 09:05"))
        await scheduler.tick(at("2026-09-11 10:00"))
        self.assertEqual(len(runtime.finished), 1)
        self.assertEqual(runtime.sent, [(STANDUP, "📝 **Meeting-Protokoll erstellt!** 📄")])

    async def test_never_stops_a_manual_join_session_at_the_window_end(self):
        scheduler, runtime, _ = self.scheduler([FakeMember()])
        runtime.active_sessions[42] = FakeSession()
        await scheduler.tick(at("2026-09-11 14:00"))
        self.assertEqual(runtime.finished, [])
        self.assertIn(42, runtime.active_sessions)


# ------------------------------------------------------------------------ leaving an empty room


class AutoLeaveTests(SchedulerTestCase):
    async def test_leaves_once_the_room_has_stayed_empty_for_the_grace_period(self):
        # Today's standup: goodbyes at 09:27, then the bot sat alone until someone intervened.
        scheduler, runtime, channel = self.scheduler([FakeMember()], minutes=True)
        await scheduler.tick(at("2026-09-11 09:05"))
        channel.members.clear()
        await scheduler.tick(at("2026-09-11 09:27:40"))
        await scheduler.tick(at("2026-09-11 09:29:00"))  # 80 s empty
        self.assertEqual(runtime.finished, [])
        await scheduler.tick(at("2026-09-11 09:29:45"))  # 125 s empty
        self.assertEqual(len(runtime.finished), 1)
        channel_id, content = runtime.sent[0]
        self.assertEqual(channel_id, STANDUP)
        self.assertIn("verlassen", content)
        self.assertEqual(runtime.active_sessions, {})

    async def test_automatic_finishes_ask_for_the_minimum_content_check(self):
        scheduler, runtime, channel = self.scheduler([FakeMember()])
        await scheduler.tick(at("2026-09-11 09:05"))
        await scheduler.tick(at("2026-09-11 10:00"))  # window end
        runtime.active_sessions[42] = FakeSession()
        channel.members.clear()
        await scheduler.tick(at("2026-09-11 14:00"))
        await scheduler.tick(at("2026-09-11 14:03"))  # empty channel
        self.assertEqual(runtime.finish_kwargs, [True, True])

    async def test_a_brief_dropout_does_not_end_the_meeting(self):
        scheduler, runtime, channel = self.scheduler([FakeMember()])
        await scheduler.tick(at("2026-09-11 09:05"))
        channel.members.clear()
        await scheduler.tick(at("2026-09-11 09:10:00"))
        channel.members.append(FakeMember())  # reconnected
        await scheduler.tick(at("2026-09-11 09:11:00"))
        channel.members.clear()
        await scheduler.tick(at("2026-09-11 09:11:30"))
        await scheduler.tick(at("2026-09-11 09:12:40"))  # 70 s since the timer restarted
        self.assertEqual(runtime.finished, [])

    async def test_rejoins_when_people_come_back_later_in_the_window(self):
        scheduler, runtime, channel = self.scheduler([FakeMember()])
        await scheduler.tick(at("2026-09-11 09:05"))
        channel.members.clear()
        await scheduler.tick(at("2026-09-11 09:06"))
        await scheduler.tick(at("2026-09-11 09:09"))
        self.assertEqual(len(runtime.finished), 1)
        channel.members.append(FakeMember())
        await scheduler.tick(at("2026-09-11 09:40"))
        self.assertEqual(len(runtime.started), 2)

    async def test_manual_session_is_left_when_empty_and_posted_where_join_was_run(self):
        scheduler, runtime, _ = self.scheduler([], minutes=True)
        runtime.active_sessions[42] = FakeSession(post_channel_id=999)
        await scheduler.tick(at("2026-09-11 14:00:00"))
        await scheduler.tick(at("2026-09-11 14:02:10"))
        self.assertEqual(len(runtime.finished), 1)
        self.assertEqual(runtime.sent[0][0], 999)

    async def test_can_be_disabled_while_the_window_end_still_applies(self):
        SETTINGS.auto_leave_empty_seconds = 0
        scheduler, runtime, channel = self.scheduler([FakeMember()])
        await scheduler.tick(at("2026-09-11 09:05"))
        channel.members.clear()
        await scheduler.tick(at("2026-09-11 09:10"))
        await scheduler.tick(at("2026-09-11 09:30"))
        self.assertEqual(runtime.finished, [])
        await scheduler.tick(at("2026-09-11 10:00"))
        self.assertEqual(len(runtime.finished), 1)

    async def test_leaves_a_session_that_is_already_finishing_alone(self):
        scheduler, runtime, _ = self.scheduler([])
        runtime.active_sessions[42] = FakeSession(finishing=True)
        await scheduler.tick(at("2026-09-11 14:00"))
        await scheduler.tick(at("2026-09-11 14:10"))
        self.assertEqual(runtime.finished, [])

    async def test_never_leaves_a_room_it_cannot_see(self):
        scheduler, runtime, _ = self.scheduler([])
        scheduler._session_channel = lambda session: None
        runtime.active_sessions[42] = FakeSession()
        await scheduler.tick(at("2026-09-11 14:00"))
        await scheduler.tick(at("2026-09-11 14:10"))
        self.assertEqual(runtime.finished, [])

    async def test_a_new_session_does_not_inherit_a_stale_empty_timer(self):
        # Session ids repeat per channel, so a timer left by a session ended via /leave must not
        # make the next session in the same channel leave immediately.
        scheduler, runtime, _ = self.scheduler([])
        first = FakeSession()
        runtime.active_sessions[42] = first
        await scheduler.tick(at("2026-09-11 14:00:00"))  # timer starts for `first`
        first.finishing = True
        runtime.active_sessions[42] = FakeSession()  # same session_id, new session
        await scheduler.tick(at("2026-09-11 14:02:30"))
        self.assertEqual(runtime.finished, [])
        await scheduler.tick(at("2026-09-11 14:04:40"))
        self.assertEqual(len(runtime.finished), 1)


# ------------------------------------------------------------------------ manual /leave


class ManualLeaveTests(SchedulerTestCase):
    async def test_manual_leave_pauses_rejoining_for_the_rest_of_that_window(self):
        scheduler, runtime, _ = self.scheduler([FakeMember()])
        await scheduler.tick(at("2026-09-11 09:05"))
        session = runtime.active_sessions[42]
        scheduler.suppress_active_window(at("2026-09-11 09:10"))  # what /leave does
        runtime.claim_session(session)
        await runtime.finish_session(session)
        await scheduler.tick(at("2026-09-11 09:11"))  # people still in the room
        self.assertEqual(len(runtime.started), 1)
        await scheduler.tick(at("2026-09-14 09:05"))  # next weekday: normal again
        self.assertEqual(len(runtime.started), 2)

    async def test_suppression_outside_a_window_does_nothing(self):
        scheduler, _, _ = self.scheduler([])
        scheduler.suppress_active_window(at("2026-09-11 14:00"))
        self.assertIsNone(scheduler._suppressed)


# ------------------------------------------------------------------------ runtime integration


class RuntimeSessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)

    @staticmethod
    def _active(**overrides):
        from summarise_bot.bot import ActiveSession

        fields = {"session_id": "42:555", "guild_id": 42, "channel_id": 555, "protocol": AsyncMock()}
        fields.update(overrides)
        return ActiveSession(**fields)

    @staticmethod
    def _ctx():
        ctx = MagicMock()
        ctx.guild_id = 42
        ctx.defer = AsyncMock()
        ctx.followup.send = AsyncMock()
        return ctx

    async def test_claim_is_exclusive(self):
        from summarise_bot.bot import SummariseBotRuntime

        runtime = SummariseBotRuntime()
        active = self._active()
        self.assertTrue(runtime.claim_session(active))
        self.assertFalse(runtime.claim_session(active))

    async def test_leave_during_an_auto_finish_does_not_finish_twice(self):
        from summarise_bot.bot import SummariseBotRuntime

        runtime = SummariseBotRuntime()
        runtime.active_sessions[42] = self._active(finishing=True)
        runtime.finish_session = AsyncMock()
        ctx = self._ctx()
        await runtime.handle_leave(ctx)
        runtime.finish_session.assert_not_awaited()
        self.assertIn("bereits", ctx.followup.send.await_args.args[0])

    async def test_leave_pauses_the_scheduler_for_the_window(self):
        from summarise_bot.bot import SummariseBotRuntime

        runtime = SummariseBotRuntime()
        runtime.active_sessions[42] = self._active()
        runtime.finish_session = AsyncMock(return_value=None)
        runtime.auto_join.suppress_active_window = MagicMock()
        await runtime.handle_leave(self._ctx())
        runtime.auto_join.suppress_active_window.assert_called_once()
        runtime.finish_session.assert_awaited_once()

    async def test_reconnect_keeps_the_scheduler_bookkeeping(self):
        from summarise_bot.bot import SummariseBotRuntime

        runtime = SummariseBotRuntime()
        active = self._active(auto_window="Mon,Tue,Wed,Thu,Fri 09:00-10:00", post_channel_id=STANDUP)
        runtime.active_sessions[42] = active
        runtime.bot.get_channel = MagicMock(return_value=object())
        runtime._connect_and_start = AsyncMock(return_value=self._active())
        self.assertTrue(await runtime._try_reconnect_session(42, active))
        resumed = runtime.active_sessions[42]
        self.assertIsNot(resumed, active)
        self.assertEqual(resumed.auto_window, "Mon,Tue,Wed,Thu,Fri 09:00-10:00")
        self.assertEqual(resumed.post_channel_id, STANDUP)

    # The exact 20 seconds that were posted to #daily-standup as "minutes" on 2026-09-11.
    DROP_IN = [
        "[2026-09-11T07:59:55.043919+00:00] Fabian Woebbeking: Good morning.",
        "[2026-09-11T07:59:55.205957+00:00] Manú: Hallo Fabian. Na, bist du im Urlaub oder wie? Ah, bist du auf Malotse?",
        "[2026-09-11T08:00:01.697456+00:00] Fabian Woebbeking: Ja, ja, die stehen jetzt hier. Ja, genau das. "
        "Alles mit der Family. Es ist so hell, ich wäre lieber im Büro. Urlaub im Planken ist kein Entspannung.",
        "[2026-09-11T08:00:13.865171+00:00] Manú: That's Glowish, Dirk.",
    ]

    def _transcript(self, lines):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "session.log"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def _meeting(self):
        return [
            f"[2026-09-11T07:{10 + i:02d}:00+00:00] {'Fabi' if i % 2 else 'Manú'}: Punkt {i}: wir haben den "
            f"Workflow Service erweitert und die Ambiguity-Checks im Gateway fuer Fall {i} getestet."
            for i in range(12)
        ]

    async def test_a_drop_in_hello_is_below_the_minimum(self):
        from summarise_bot.bot import SummariseBotRuntime

        runtime = SummariseBotRuntime()
        self.assertFalse(runtime._has_substance(self._active(), self._transcript(self.DROP_IN)))

    async def test_a_real_meeting_clears_the_minimum(self):
        from summarise_bot.bot import SummariseBotRuntime

        runtime = SummariseBotRuntime()
        self.assertTrue(runtime._has_substance(self._active(), self._transcript(self._meeting())))

    async def test_an_unreadable_transcript_is_never_silently_dropped(self):
        from summarise_bot.bot import SummariseBotRuntime

        runtime = SummariseBotRuntime()
        self.assertTrue(runtime._has_substance(self._active(), Path("/nonexistent/session.log")))

    async def test_only_automatic_finishes_skip_short_sessions(self):
        from summarise_bot.bot import SummariseBotRuntime

        runtime = SummariseBotRuntime()
        runtime.helper.stop_session = AsyncMock(return_value={})
        runtime.pipeline.wait_for_pending = AsyncMock()
        runtime._ensure_transcript_path = AsyncMock(return_value=self._transcript(self.DROP_IN))
        with patch("summarise_bot.bot.summarize_transcript", AsyncMock(return_value=None)) as summarise:
            await runtime.finish_session(self._active(), require_substance=True)
            summarise.assert_not_awaited()
            await runtime.finish_session(self._active())  # manual /leave
            summarise.assert_awaited_once()

    async def test_reconnect_does_not_resurrect_a_finishing_session(self):
        from summarise_bot.bot import SummariseBotRuntime

        runtime = SummariseBotRuntime()
        active = self._active(finishing=True)
        runtime.active_sessions[42] = active
        runtime._connect_and_start = AsyncMock()
        self.assertFalse(await runtime._try_reconnect_session(42, active))
        runtime._connect_and_start.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
