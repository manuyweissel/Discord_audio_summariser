from __future__ import annotations

from datetime import UTC, datetime, timedelta
import unittest

from voice_helper.segmenter import SegmentAccumulator


class SegmentAccumulatorTests(unittest.TestCase):
    def test_flushes_after_silence(self) -> None:
        accumulator = SegmentAccumulator(silence_ms=2000, max_segment_ms=30000)
        started_at = datetime(2026, 5, 7, 12, 0, 0, tzinfo=UTC)

        flushed = accumulator.append_pcm(
            42,
            b"first-frame",
            now_monotonic=10.0,
            now_dt=started_at,
        )
        self.assertEqual(flushed, [])

        flushed = accumulator.flush_inactive(
            now_monotonic=11.5,
            now_dt=started_at + timedelta(seconds=1, milliseconds=500),
        )
        self.assertEqual(flushed, [])

        flushed = accumulator.flush_inactive(
            now_monotonic=12.1,
            now_dt=started_at + timedelta(seconds=2, milliseconds=100),
        )
        self.assertEqual(len(flushed), 1)
        self.assertEqual(flushed[0].user_id, 42)
        self.assertEqual(flushed[0].pcm_bytes, b"first-frame")

    def test_flushes_when_segment_exceeds_max_duration(self) -> None:
        accumulator = SegmentAccumulator(silence_ms=2000, max_segment_ms=30000)
        started_at = datetime(2026, 5, 7, 12, 0, 0, tzinfo=UTC)

        self.assertEqual(
            accumulator.append_pcm(7, b"a", now_monotonic=1.0, now_dt=started_at),
            [],
        )

        flushed = accumulator.append_pcm(
            7,
            b"b",
            now_monotonic=32.0,
            now_dt=started_at + timedelta(seconds=31),
        )
        self.assertEqual(len(flushed), 1)
        self.assertEqual(flushed[0].pcm_bytes, b"a")

        remaining = accumulator.flush_all(now_dt=started_at + timedelta(seconds=31, milliseconds=1))
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0].pcm_bytes, b"b")


if __name__ == "__main__":
    unittest.main()
