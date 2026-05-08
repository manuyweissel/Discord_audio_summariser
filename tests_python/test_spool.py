from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import wave

from voice_helper.spool import SpoolWriter


class SpoolWriterTests(unittest.TestCase):
    def test_writes_wav_and_spool_record_atomically(self) -> None:
        with TemporaryDirectory() as temp_dir:
            audio_dir = Path(temp_dir) / "audios"
            spool_dir = Path(temp_dir) / "spool"
            writer = SpoolWriter(str(audio_dir), str(spool_dir))

            started_at = datetime(2026, 5, 7, 12, 0, 0, tzinfo=UTC)
            ended_at = datetime(2026, 5, 7, 12, 0, 2, tzinfo=UTC)
            record = writer.write_segment(
                session_id="123:456",
                guild_id="123",
                channel_id="456",
                user_id="789",
                pcm_bytes=b"\x00\x00\x01\x00" * 64,
                started_at=started_at,
                ended_at=ended_at,
                sample_rate=48000,
                channels=2,
                sample_width=2,
            )

            wav_path = Path(record.wavPath)
            spool_path = spool_dir / f"{record.eventId}.json"

            self.assertTrue(wav_path.exists())
            self.assertTrue(spool_path.exists())

            with wave.open(str(wav_path), "rb") as wav_file:
                self.assertEqual(wav_file.getframerate(), 48000)
                self.assertEqual(wav_file.getnchannels(), 2)

            payload = json.loads(spool_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["eventId"], record.eventId)
            self.assertEqual(payload["sessionId"], "123:456")
            self.assertEqual(payload["userId"], "789")
            self.assertEqual(payload["wavPath"], str(wav_path))
            self.assertEqual(payload["fileSize"], wav_path.stat().st_size)


if __name__ == "__main__":
    unittest.main()
