from datetime import timedelta
import unittest

from voice_worker.segmenter import SegmentAccumulator, utc_now


class SegmentAccumulatorTests(unittest.TestCase):
    def test_flushes_inactive_user_buffers(self):
        segmenter = SegmentAccumulator(silence_ms=500, max_segment_ms=30000)
        started_at = utc_now()
        segmenter.append_pcm(1, b"abc", now_monotonic=0.0, now_dt=started_at)

        flushed = segmenter.flush_inactive(
            now_monotonic=1.0,
            now_dt=started_at + timedelta(seconds=1),
        )

        self.assertEqual(len(flushed), 1)
        self.assertEqual(flushed[0].user_id, 1)
        self.assertEqual(flushed[0].pcm_bytes, b"abc")

    def test_splits_segments_when_max_duration_is_reached(self):
        segmenter = SegmentAccumulator(silence_ms=500, max_segment_ms=1000)
        started_at = utc_now()
        self.assertEqual(
            segmenter.append_pcm(7, b"one", now_monotonic=0.0, now_dt=started_at),
            [],
        )

        flushed = segmenter.append_pcm(
            7,
            b"two",
            now_monotonic=1.5,
            now_dt=started_at + timedelta(seconds=2),
        )

        self.assertEqual(len(flushed), 1)
        self.assertEqual(flushed[0].pcm_bytes, b"one")


if __name__ == "__main__":
    unittest.main()
