from __future__ import annotations

import struct
import tempfile
import unittest
from unittest.mock import patch

from voice_helper.main import VoiceReceiveSession
from voice_helper.spool import SpoolWriter


class FakeDaveState:
    def __init__(self, ready: bool = True) -> None:
        self.ready = ready
        self.deferred_users: list[int] = []

    def can_decrypt_user(self, user_id: int, *, now_monotonic: float | None = None) -> tuple[bool, str]:
        del user_id, now_monotonic
        return (True, "ready") if self.ready else (False, "missing_decryptor")

    def defer_user(self, user_id: int, pause_seconds: float | None = None) -> None:
        del pause_seconds
        self.deferred_users.append(user_id)

    def get_aggregate_stats(self):
        class Stats:
            decrypt_attempts = 0
            decrypt_success_count = 0
            decrypt_failure_count = 0
            decrypt_missing_key_count = 0
            decrypt_invalid_nonce_count = 0
            passthrough_count = 0

        return Stats()


class VoiceReceiveSessionTests(unittest.IsolatedAsyncioTestCase):
    def _build_session(self) -> VoiceReceiveSession:
        async def emit(payload: dict[str, object]) -> None:
            del payload

        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        spool_writer = SpoolWriter(f"{tmpdir.name}/audios", f"{tmpdir.name}/spool")
        return VoiceReceiveSession(
            emit=emit,
            session_id="guild:channel",
            guild_id=1,
            channel_id=2,
            bot_user_id=999,
            voice_endpoint="voice.example.invalid",
            voice_token="token",
            voice_session_id="voice-session",
            self_mute=True,
            self_deaf=False,
            spool_writer=spool_writer,
        )

    @staticmethod
    def _packet(ssrc: int, timestamp: int = 100) -> bytes:
        packet = bytearray(16)
        packet[1] = 0x78
        struct.pack_into(">I", packet, 4, timestamp)
        struct.pack_into(">I", packet, 8, ssrc)
        return bytes(packet)

    async def test_queues_packets_until_speaking_maps_ssrc(self) -> None:
        session = self._build_session()
        session.dave_state = FakeDaveState(ready=True)
        processed: list[tuple[int, int]] = []

        async def fake_process(pending, user_id: int) -> bool:
            processed.append((pending.ssrc, user_id))
            return True

        session._process_pending_packet = fake_process  # type: ignore[method-assign]
        session._split_rtp_packet = lambda packet: (b"header", packet[12:])  # type: ignore[method-assign]
        session._decrypt_transport = lambda header, payload: b"frame"  # type: ignore[method-assign]

        await session._handle_udp_packet(self._packet(42))
        self.assertEqual(len(session.pending_packets[42]), 1)

        session.ssrc_map[42] = {"user_id": 77, "speaking": 1}
        await session._drain_pending_packets(42)

        self.assertEqual(processed, [(42, 77)])
        self.assertNotIn(42, session.pending_packets)

    async def test_bounded_queue_drops_old_packets_when_decryptor_missing(self) -> None:
        session = self._build_session()
        session.dave_state = FakeDaveState(ready=False)
        session.ssrc_map[42] = {"user_id": 77, "speaking": 1}
        session._split_rtp_packet = lambda packet: (b"header", packet[12:])  # type: ignore[method-assign]
        session._decrypt_transport = lambda header, payload: b"frame"  # type: ignore[method-assign]

        with patch("voice_helper.main.VOICE_PACKET_QUEUE_LIMIT", 2):
            await session._handle_udp_packet(self._packet(42, 100))
            await session._handle_udp_packet(self._packet(42, 101))
            await session._handle_udp_packet(self._packet(42, 102))

        self.assertEqual(len(session.pending_packets[42]), 2)
        timestamps = [packet.timestamp for packet in session.pending_packets[42]]
        self.assertEqual(timestamps, [101, 102])
        self.assertEqual(session.counters.missing_decryptor_queued, 3)
        self.assertEqual(session.counters.pending_queue_drops, 1)


if __name__ == "__main__":
    unittest.main()
