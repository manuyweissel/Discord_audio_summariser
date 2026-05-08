from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import time


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(slots=True)
class PCMChunk:
    user_id: int
    pcm_bytes: bytes
    started_at: datetime
    ended_at: datetime


@dataclass(slots=True)
class UserBuffer:
    user_id: int
    started_at: datetime
    last_packet_at: float
    chunks: list[bytes]
    byte_count: int = 0


class SegmentAccumulator:
    def __init__(self, silence_ms: int, max_segment_ms: int):
        self.silence_seconds = max(0.1, silence_ms / 1000)
        self.max_segment_seconds = max(1.0, max_segment_ms / 1000)
        self._buffers: dict[int, UserBuffer] = {}

    def append_pcm(
        self,
        user_id: int,
        pcm_bytes: bytes,
        *,
        now_monotonic: float | None = None,
        now_dt: datetime | None = None,
    ) -> list[PCMChunk]:
        now_monotonic = now_monotonic if now_monotonic is not None else time.monotonic()
        now_dt = now_dt or utc_now()
        flushed: list[PCMChunk] = []
        buffer = self._buffers.get(user_id)

        if buffer is None:
            buffer = UserBuffer(
                user_id=user_id,
                started_at=now_dt,
                last_packet_at=now_monotonic,
                chunks=[],
            )
            self._buffers[user_id] = buffer
        elif (now_dt - buffer.started_at).total_seconds() >= self.max_segment_seconds and buffer.byte_count > 0:
            flushed.append(self._flush_user(user_id, ended_at=now_dt))
            buffer = UserBuffer(
                user_id=user_id,
                started_at=now_dt,
                last_packet_at=now_monotonic,
                chunks=[],
            )
            self._buffers[user_id] = buffer

        buffer.chunks.append(pcm_bytes)
        buffer.byte_count += len(pcm_bytes)
        buffer.last_packet_at = now_monotonic
        return flushed

    def flush_inactive(
        self,
        *,
        now_monotonic: float | None = None,
        now_dt: datetime | None = None,
    ) -> list[PCMChunk]:
        now_monotonic = now_monotonic if now_monotonic is not None else time.monotonic()
        now_dt = now_dt or utc_now()
        flushed: list[PCMChunk] = []
        stale_users = [
            user_id
            for user_id, buffer in self._buffers.items()
            if buffer.byte_count > 0 and (now_monotonic - buffer.last_packet_at) >= self.silence_seconds
        ]
        for user_id in stale_users:
            flushed.append(self._flush_user(user_id, ended_at=now_dt))
        return flushed

    def flush_all(self, *, now_dt: datetime | None = None) -> list[PCMChunk]:
        now_dt = now_dt or utc_now()
        flushed: list[PCMChunk] = []
        for user_id in list(self._buffers.keys()):
            buffer = self._buffers.get(user_id)
            if buffer and buffer.byte_count > 0:
                flushed.append(self._flush_user(user_id, ended_at=now_dt))
            else:
                self._buffers.pop(user_id, None)
        return flushed

    def _flush_user(self, user_id: int, *, ended_at: datetime) -> PCMChunk:
        buffer = self._buffers.pop(user_id)
        return PCMChunk(
            user_id=user_id,
            pcm_bytes=b"".join(buffer.chunks),
            started_at=buffer.started_at,
            ended_at=ended_at,
        )
