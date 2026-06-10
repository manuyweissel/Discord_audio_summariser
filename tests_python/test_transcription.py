from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
import wave

from summarise_bot.transcription import (
    MIN_AUDIO_SECONDS,
    _is_permanent_error,
    _wav_duration_seconds,
    transcribe_audio,
)


def _write_wav(path: Path, seconds: float, rate: int = 48000, channels: int = 2, width: int = 2) -> None:
    frames = int(seconds * rate)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        wav.writeframes(b"\x00" * frames * channels * width)


class TranscriptionSkipTests(unittest.IsolatedAsyncioTestCase):
    async def test_too_short_audio_is_skipped_before_any_api_call(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tiny.wav"
            _write_wav(path, 0.05)  # below MIN_AUDIO_SECONDS, so no API call happens
            self.assertLess(_wav_duration_seconds(path), MIN_AUDIO_SECONDS)
            result = await transcribe_audio(str(path), "guild:channel", "user")  # entry_id=None
            self.assertFalse(result["success"])
            self.assertTrue(result["skipped"])

    def test_long_enough_audio_passes_duration_gate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ok.wav"
            _write_wav(path, 0.5)
            self.assertGreaterEqual(_wav_duration_seconds(path), MIN_AUDIO_SECONDS)

    def test_audio_too_short_classified_permanent(self) -> None:
        err = RuntimeError(
            "Error code: 400 - {'error': {'message': 'Audio file is too short. "
            "Minimum audio length is 0.1 seconds.', 'code': 'audio_too_short'}}"
        )
        self.assertTrue(_is_permanent_error(err))

    def test_transient_error_not_permanent(self) -> None:
        self.assertFalse(_is_permanent_error(RuntimeError("Connection reset by peer")))


if __name__ == "__main__":
    unittest.main()
