from datetime import timedelta
import json
from pathlib import Path
import tempfile
import unittest

from voice_worker.segmenter import utc_now
from voice_worker.spool import SpoolWriter


class SpoolWriterTests(unittest.TestCase):
    def test_write_segment_is_atomic_and_persists_record(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_dir = Path(temp_dir) / "audios"
            spool_dir = Path(temp_dir) / "spool"
            writer = SpoolWriter(str(audio_dir), str(spool_dir))
            started_at = utc_now()
            ended_at = started_at + timedelta(seconds=2)

            record = writer.write_segment(
                session_id="guild:channel",
                guild_id="guild",
                channel_id="channel",
                user_id="user",
                pcm_bytes=b"\x00\x00" * 128,
                started_at=started_at,
                ended_at=ended_at,
                sample_rate=48000,
                channels=2,
                sample_width=2,
            )

            self.assertTrue(Path(record.wavPath).exists())
            spool_path = spool_dir / f"{record.eventId}.json"
            self.assertTrue(spool_path.exists())

            payload = json.loads(spool_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["eventId"], record.eventId)
            self.assertEqual(payload["sessionId"], "guild:channel")


if __name__ == "__main__":
    unittest.main()
