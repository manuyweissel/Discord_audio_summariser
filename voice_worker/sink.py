from __future__ import annotations

import asyncio
from datetime import timezone
import threading
import time
from typing import Awaitable, Callable

from discord.sinks import Sink

from .segmenter import SegmentAccumulator, utc_now
from .spool import SpoolWriter


class SegmentingSink(Sink):
    def __init__(
        self,
        *,
        session_id: str,
        guild_id: str,
        channel_id: str,
        spool_writer: SpoolWriter,
        emit_segment: Callable[[dict[str, object]], Awaitable[None]],
        silence_ms: int,
        max_segment_ms: int,
    ):
        super().__init__()
        self.session_id = session_id
        self.guild_id = guild_id
        self.channel_id = channel_id
        self.spool_writer = spool_writer
        self.emit_segment = emit_segment
        self.segmenter = SegmentAccumulator(silence_ms=silence_ms, max_segment_ms=max_segment_ms)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.lock = threading.Lock()
        self.finished = False
        self.sample_rate = 48000
        self.channels = 2
        self.sample_width = 2

    def init(self, vc):
        super().init(vc)
        self.loop = vc.loop
        decoder = getattr(vc, "decoder", None)
        if decoder is not None:
            self.sample_rate = getattr(decoder, "SAMPLING_RATE", self.sample_rate)
            self.channels = getattr(decoder, "CHANNELS", self.channels)
            self.sample_width = getattr(decoder, "SAMPLE_SIZE", self.channels * self.sample_width) // self.channels

    def write(self, data, user):
        if self.finished:
            return

        with self.lock:
            flushed = self.segmenter.append_pcm(
                int(user),
                data,
                now_monotonic=time.monotonic(),
                now_dt=utc_now(),
            )

        for segment in flushed:
            self._persist_and_emit(segment)

    def cleanup(self):
        if self.finished:
            return
        self.finished = True
        self.flush_all()

    def format_audio(self, audio):  # pragma: no cover - unused on custom sink
        return None

    def flush_inactive(self):
        with self.lock:
            flushed = self.segmenter.flush_inactive(
                now_monotonic=time.monotonic(),
                now_dt=utc_now(),
            )

        for segment in flushed:
            self._persist_and_emit(segment)

    def flush_all(self):
        with self.lock:
            flushed = self.segmenter.flush_all(now_dt=utc_now())

        for segment in flushed:
            self._persist_and_emit(segment)

    def _persist_and_emit(self, segment):
        if not segment.pcm_bytes:
            return

        record = self.spool_writer.write_segment(
            session_id=self.session_id,
            guild_id=self.guild_id,
            channel_id=self.channel_id,
            user_id=str(segment.user_id),
            pcm_bytes=segment.pcm_bytes,
            started_at=segment.started_at.astimezone(timezone.utc),
            ended_at=segment.ended_at.astimezone(timezone.utc),
            sample_rate=self.sample_rate,
            channels=self.channels,
            sample_width=self.sample_width,
        ).to_dict()

        if self.loop is not None:
            asyncio.run_coroutine_threadsafe(self.emit_segment(record), self.loop)
