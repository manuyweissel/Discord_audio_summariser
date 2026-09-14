"""Recurring meeting windows for the auto-join scheduler.

Pure date/time logic, deliberately free of Discord types so it can be unit tested.

A schedule is written as a semicolon-separated list of windows::

    mon-fri 09:00-10:00 -> 1364921683936284734; thu 11:00-12:00 -> 1473976066052984967

Each window is ``<days> <start>-<end> -> <channel id for the minutes>``. Days accept
individual names (``mon``), ranges (``mon-fri``) and comma lists (``mon,wed,fri``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

_DAY_NAMES = {
    "mon": 0, "monday": 0,
    "tue": 1, "tues": 1, "tuesday": 1,
    "wed": 2, "weds": 2, "wednesday": 2,
    "thu": 3, "thur": 3, "thurs": 3, "thursday": 3,
    "fri": 4, "friday": 4,
    "sat": 5, "saturday": 5,
    "sun": 6, "sunday": 6,
}
_DAY_LABELS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

_WINDOW_RE = re.compile(
    r"^\s*(?P<days>[a-z,\-]+)\s+"
    r"(?P<start>\d{1,2}:\d{2})\s*-\s*(?P<end>\d{1,2}:\d{2})"
    r"(?:\s*->\s*(?P<channel>\d+))?\s*$",
    re.I,
)


class ScheduleError(ValueError):
    """Raised when a schedule string cannot be parsed."""


@dataclass(frozen=True, slots=True)
class MeetingWindow:
    days: frozenset[int]
    start: time
    end: time
    post_channel_id: int | None = None

    @property
    def label(self) -> str:
        days = ",".join(_DAY_LABELS[d] for d in sorted(self.days))
        return f"{days} {self.start:%H:%M}-{self.end:%H:%M}"

    def covers(self, moment: datetime) -> bool:
        """True when ``moment`` (already in the schedule's local timezone) is inside the window.

        End-exclusive, so a 09:00-10:00 window releases the bot exactly at 10:00.
        """
        return moment.weekday() in self.days and self.start <= moment.time() < self.end

    def start_on(self, day: date) -> datetime:
        return datetime.combine(day, self.start)

    def next_start(self, after: datetime) -> datetime:
        """First start strictly after ``after``, searching the coming week."""
        for offset in range(0, 8):
            candidate = self.start_on((after + timedelta(days=offset)).date())
            if candidate > after and candidate.weekday() in self.days:
                return candidate
        raise ScheduleError(f"Window {self.label} never occurs")


def _parse_days(raw: str) -> frozenset[int]:
    days: set[int] = set()
    for part in raw.split(","):
        part = part.strip().lower()
        if not part:
            continue
        if "-" in part:
            first, _, last = part.partition("-")
            try:
                start, end = _DAY_NAMES[first.strip()], _DAY_NAMES[last.strip()]
            except KeyError as error:
                raise ScheduleError(f"Unknown day in range {part!r}") from error
            # Ranges wrap, so "fri-mon" means Fri, Sat, Sun, Mon.
            index = start
            while True:
                days.add(index)
                if index == end:
                    break
                index = (index + 1) % 7
        else:
            try:
                days.add(_DAY_NAMES[part])
            except KeyError as error:
                raise ScheduleError(f"Unknown day {part!r}") from error
    if not days:
        raise ScheduleError(f"No days given in {raw!r}")
    return frozenset(days)


def _parse_time(raw: str) -> time:
    hour, _, minute = raw.partition(":")
    hour_value, minute_value = int(hour), int(minute)
    if not (0 <= hour_value <= 23 and 0 <= minute_value <= 59):
        raise ScheduleError(f"Invalid time {raw!r}")
    return time(hour=hour_value, minute=minute_value)


def parse_schedule(spec: str) -> list[MeetingWindow]:
    windows: list[MeetingWindow] = []
    for chunk in spec.split(";"):
        if not chunk.strip():
            continue
        match = _WINDOW_RE.match(chunk)
        if match is None:
            raise ScheduleError(f"Cannot parse schedule entry {chunk.strip()!r}")
        start = _parse_time(match.group("start"))
        end = _parse_time(match.group("end"))
        if end <= start:
            raise ScheduleError(f"Window end must be after start in {chunk.strip()!r}")
        channel = match.group("channel")
        windows.append(
            MeetingWindow(
                days=_parse_days(match.group("days")),
                start=start,
                end=end,
                post_channel_id=int(channel) if channel else None,
            )
        )
    return windows


def active_window(windows: list[MeetingWindow], moment: datetime) -> MeetingWindow | None:
    for window in windows:
        if window.covers(moment):
            return window
    return None


def next_window(windows: list[MeetingWindow], after: datetime) -> tuple[MeetingWindow, datetime] | None:
    upcoming = [(window, window.next_start(after)) for window in windows]
    return min(upcoming, key=lambda item: item[1]) if upcoming else None
