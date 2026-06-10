from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
import json
import logging
import os
import socket
import struct
import sys
import time
from pathlib import Path
from typing import Any

import aiohttp
import dave
import discord
import nacl.secret

from voice_helper.segmenter import PCMChunk, SegmentAccumulator, utc_now
from voice_helper.spool import SpoolWriter


logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
LOGGER = logging.getLogger("voice_helper")


ROOT_DIR = Path(__file__).resolve().parent.parent
VOICE_CAPTURE_AUDIO_DIR = os.environ.get("VOICE_CAPTURE_AUDIO_DIR", str(ROOT_DIR / "audios"))
VOICE_CAPTURE_SPOOL_DIR = os.environ.get("VOICE_CAPTURE_SPOOL_DIR", str(ROOT_DIR / "data" / "voice_capture_spool"))
VOICE_SEGMENT_SILENCE_MS = int(os.environ.get("VOICE_SEGMENT_SILENCE_MS", os.environ.get("VOICE_WORKER_SEGMENT_SILENCE_MS", "2000")))
VOICE_MAX_SEGMENT_MS = int(os.environ.get("VOICE_MAX_SEGMENT_MS", os.environ.get("VOICE_WORKER_MAX_SEGMENT_MS", "30000")))
VOICE_PACKET_QUEUE_LIMIT = int(os.environ.get("VOICE_PACKET_QUEUE_LIMIT", "256"))
VOICE_MEDIA_PAUSE_MS = int(os.environ.get("VOICE_MEDIA_PAUSE_MS", "750"))
VOICE_STATS_EMIT_INTERVAL_MS = int(os.environ.get("VOICE_STATS_EMIT_INTERVAL_MS", "5000"))
VOICE_HELPER_DEBUG_TRACE_SESSION_ID = os.environ.get("VOICE_HELPER_DEBUG_TRACE_SESSION_ID", "").strip()


class VoiceOpcode:
    IDENTIFY = 0
    SELECT_PROTOCOL = 1
    READY = 2
    HEARTBEAT = 3
    SESSION_DESCRIPTION = 4
    SPEAKING = 5
    HEARTBEAT_ACK = 6
    RESUME = 7
    HELLO = 8
    RESUMED = 9
    CLIENTS_CONNECT = 11
    CLIENT_DISCONNECT = 13
    DAVE_PREPARE_TRANSITION = 21
    DAVE_EXECUTE_TRANSITION = 22
    DAVE_TRANSITION_READY = 23
    DAVE_MLS_PREPARE_EPOCH = 24
    DAVE_MLS_EXTERNAL_SENDER = 25
    DAVE_MLS_KEY_PACKAGE = 26
    DAVE_MLS_PROPOSALS = 27
    DAVE_MLS_COMMIT_WELCOME = 28
    DAVE_MLS_ANNOUNCE_COMMIT_TRANSITION = 29
    DAVE_MLS_WELCOME = 30
    DAVE_MLS_INVALID_COMMIT_WELCOME = 31


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.lower() not in {"0", "false", "no", "off"}


@dataclass(slots=True)
class PendingPacket:
    ssrc: int
    timestamp: int
    received_at: float
    frame: bytes
    attempts: int = 0


@dataclass(slots=True)
class SessionCounters:
    packets_received: int = 0
    unknown_ssrc_queued: int = 0
    missing_decryptor_queued: int = 0
    pending_queue_drops: int = 0
    transport_decrypt_drops: int = 0
    media_decrypt_drops: int = 0
    decode_failures: int = 0
    pcm_frames_accepted: int = 0
    segments_flushed: int = 0
    spool_writes: int = 0


@dataclass(slots=True)
class DecryptorAggregateStats:
    decrypt_attempts: int = 0
    decrypt_success_count: int = 0
    decrypt_failure_count: int = 0
    decrypt_missing_key_count: int = 0
    decrypt_invalid_nonce_count: int = 0
    passthrough_count: int = 0
    decrypt_duration: float = 0.0

    def merge(self, stats: dave.DecryptorStats) -> None:
        self.decrypt_attempts += int(stats.decrypt_attempts)
        self.decrypt_success_count += int(stats.decrypt_success_count)
        self.decrypt_failure_count += int(stats.decrypt_failure_count)
        self.decrypt_missing_key_count += int(stats.decrypt_missing_key_count)
        self.decrypt_invalid_nonce_count += int(stats.decrypt_invalid_nonce_count)
        self.passthrough_count += int(stats.passthrough_count)
        self.decrypt_duration += float(stats.decrypt_duration)


class DaveReceiveState:
    MAX_SUPPORTED_VERSION = 1
    DISABLED_VERSION = 0
    INIT_TRANSITION_ID = 0
    NEW_MLS_GROUP_EPOCH = 1

    def __init__(self, session: "VoiceReceiveSession") -> None:
        self.session = session
        self.mls_session = dave.Session(self._on_mls_failure)
        self.recognized_users: set[int] = {session.bot_user_id}
        self.prepared_transitions: dict[int, int] = {}
        self.transient_keys: dict[int, dave.SignatureKeyPair] = {}
        self.decryptors: dict[int, dave.Decryptor] = {}
        self.protocol_version = 0
        self.user_pause_until: dict[int, float] = {}

    def _on_mls_failure(self, source: str, reason: str) -> None:
        LOGGER.error("MLS failure in %s: %s", source, reason)

    def _get_transient_key(self, version: int) -> dave.SignatureKeyPair:
        key = self.transient_keys.get(version)
        if key is None:
            key = dave.SignatureKeyPair.generate(version)
            self.transient_keys[version] = key
        return key

    def add_recognized_user(self, user_id: int) -> None:
        self.recognized_users.add(user_id)
        if self.protocol_version > 0:
            self._refresh_decryptor(user_id)

    def remove_recognized_user(self, user_id: int) -> None:
        if user_id == self.session.bot_user_id:
            return
        self.recognized_users.discard(user_id)
        self.decryptors.pop(user_id, None)
        self.user_pause_until.pop(user_id, None)

    async def reinit_state(self, version: int) -> None:
        if version > self.MAX_SUPPORTED_VERSION:
            raise RuntimeError(f"DAVE version {version} is not supported")
        if version > self.DISABLED_VERSION:
            await self.prepare_epoch(self.NEW_MLS_GROUP_EPOCH, version)
        else:
            await self.prepare_transition(self.INIT_TRANSITION_ID, self.DISABLED_VERSION)

    async def prepare_epoch(self, epoch: int, version: int) -> None:
        if epoch != self.NEW_MLS_GROUP_EPOCH:
            return
        self.protocol_version = version
        self.defer_all_users()
        self.mls_session.init(
            version,
            self.session.channel_id,
            str(self.session.bot_user_id),
            self._get_transient_key(version),
        )
        key_package = self.mls_session.get_marshalled_key_package()
        await self.session.send_binary(struct.pack(">B", VoiceOpcode.DAVE_MLS_KEY_PACKAGE) + key_package)

    async def prepare_transition(self, transition_id: int, version: int) -> None:
        self.prepared_transitions[transition_id] = version
        self.defer_all_users()
        if transition_id == self.INIT_TRANSITION_ID:
            self.execute_transition(transition_id)
        else:
            await self.session.send_json({"op": VoiceOpcode.DAVE_TRANSITION_READY, "d": {"transition_id": transition_id}})

    def execute_transition(self, transition_id: int) -> None:
        version = self.prepared_transitions.pop(transition_id, None)
        if version is None:
            return
        self.protocol_version = version
        self.defer_all_users()
        if version == self.DISABLED_VERSION:
            self.mls_session.reset()
            for decryptor in self.decryptors.values():
                decryptor.transition_to_passthrough_mode(True)
            return
        for user_id in list(self.recognized_users):
            if user_id != self.session.bot_user_id:
                self._refresh_decryptor(user_id)

    def _refresh_decryptor(self, user_id: int) -> None:
        if not self.mls_session.has_established_group():
            return
        ratchet = self.mls_session.get_key_ratchet(str(user_id))
        if ratchet is None:
            return
        decryptor = self.decryptors.get(user_id)
        if decryptor is None:
            decryptor = dave.Decryptor()
            self.decryptors[user_id] = decryptor
        decryptor.transition_to_key_ratchet(ratchet, 5.0)

    def defer_user(self, user_id: int, pause_seconds: float | None = None) -> None:
        if user_id == self.session.bot_user_id:
            return
        pause_seconds = pause_seconds if pause_seconds is not None else (VOICE_MEDIA_PAUSE_MS / 1000)
        until = time.monotonic() + max(0.05, pause_seconds)
        self.user_pause_until[user_id] = max(self.user_pause_until.get(user_id, 0.0), until)

    def defer_all_users(self, pause_seconds: float | None = None) -> None:
        for user_id in list(self.recognized_users):
            self.defer_user(user_id, pause_seconds)

    def can_decrypt_user(self, user_id: int, *, now_monotonic: float | None = None) -> tuple[bool, str]:
        if self.protocol_version == self.DISABLED_VERSION:
            return True, "passthrough"
        now_monotonic = now_monotonic if now_monotonic is not None else time.monotonic()
        if now_monotonic < self.user_pause_until.get(user_id, 0.0):
            return False, "transition_pause"
        decryptor = self.decryptors.get(user_id)
        if decryptor is None:
            self._refresh_decryptor(user_id)
            decryptor = self.decryptors.get(user_id)
        if decryptor is None:
            return False, "missing_decryptor"
        return True, "ready"

    def decrypt_frame(self, user_id: int, frame: bytes) -> bytes | None:
        if self.protocol_version == self.DISABLED_VERSION:
            return frame
        decryptor = self.decryptors.get(user_id)
        if decryptor is None:
            self._refresh_decryptor(user_id)
            decryptor = self.decryptors.get(user_id)
        if decryptor is None:
            return None
        return decryptor.decrypt(dave.MediaType.audio, frame)

    def get_aggregate_stats(self) -> DecryptorAggregateStats:
        aggregate = DecryptorAggregateStats()
        for decryptor in self.decryptors.values():
            aggregate.merge(decryptor.get_stats(dave.MediaType.audio))
        return aggregate

    def handle_mls_external_sender(self, data: bytes) -> None:
        self.mls_session.set_external_sender(data)

    async def handle_mls_proposals(self, data: bytes) -> None:
        recognized = {str(user_id) for user_id in self.recognized_users}
        commit_welcome = self.mls_session.process_proposals(data, recognized)
        if commit_welcome is not None:
            self.defer_all_users()
            await self.session.send_binary(struct.pack(">B", VoiceOpcode.DAVE_MLS_COMMIT_WELCOME) + commit_welcome)

    async def handle_mls_announce_commit_transition(self, transition_id: int, data: bytes) -> None:
        result = self.mls_session.process_commit(data)
        if result is dave.RejectType.ignored:
            return
        if result is dave.RejectType.failed:
            await self.session.send_json(
                {"op": VoiceOpcode.DAVE_MLS_INVALID_COMMIT_WELCOME, "d": {"transition_id": transition_id}}
            )
            await self.reinit_state(self.mls_session.get_protocol_version())
            return
        self.defer_all_users()
        await self.prepare_transition(transition_id, self.mls_session.get_protocol_version())

    async def handle_mls_welcome(self, transition_id: int, data: bytes) -> None:
        recognized = {str(user_id) for user_id in self.recognized_users}
        roster = self.mls_session.process_welcome(data, recognized)
        if roster is None:
            await self.session.send_json(
                {"op": VoiceOpcode.DAVE_MLS_INVALID_COMMIT_WELCOME, "d": {"transition_id": transition_id}}
            )
            await self.reinit_state(self.mls_session.get_protocol_version())
            return
        self.defer_all_users()
        await self.prepare_transition(transition_id, self.mls_session.get_protocol_version())


class VoiceReceiveSession:
    def __init__(
        self,
        *,
        emit: callable,
        session_id: str,
        guild_id: int,
        channel_id: int,
        bot_user_id: int,
        voice_endpoint: str,
        voice_token: str,
        voice_session_id: str,
        self_mute: bool,
        self_deaf: bool,
        spool_writer: SpoolWriter,
    ) -> None:
        self.emit = emit
        self.session_id = session_id
        self.guild_id = guild_id
        self.channel_id = channel_id
        self.bot_user_id = bot_user_id
        self.voice_endpoint = voice_endpoint
        self.voice_token = voice_token
        self.voice_session_id = voice_session_id
        self.self_mute = self_mute
        self.self_deaf = self_deaf
        self.spool_writer = spool_writer
        self.segmenter = SegmentAccumulator(VOICE_SEGMENT_SILENCE_MS, VOICE_MAX_SEGMENT_MS)
        self.voice_ws: aiohttp.ClientWebSocketResponse | None = None
        self.http_session: aiohttp.ClientSession | None = None
        self.udp_socket: socket.socket | None = None
        self.transport_secret_key: list[int] | None = None
        self.transport_mode = "aead_xchacha20_poly1305_rtpsize"
        self.sequence = -1
        self.ssrc = 0
        self.voice_port = 0
        self.endpoint_ip = ""
        self.ip = ""
        self.port = 0
        self.ws_ready = asyncio.Event()
        self.stop_event = asyncio.Event()
        self.heartbeat_interval = 41.25
        self.heartbeat_task: asyncio.Task | None = None
        self.ws_task: asyncio.Task | None = None
        self.udp_task: asyncio.Task | None = None
        self.flush_task: asyncio.Task | None = None
        self.watch_task: asyncio.Task | None = None
        self.ssrc_map: dict[int, dict[str, int]] = {}
        self.pending_packets: dict[int, deque[PendingPacket]] = {}
        self.decoders: dict[int, discord.opus.Decoder] = {}
        self.dave_state = DaveReceiveState(self)
        self.counters = SessionCounters()
        self.phase = "initialized"
        self.phase_history: list[str] = [self.phase]
        self.last_voice_opcode: int | None = None
        self.last_close_code: int | None = None
        self._stats_dirty = True
        self._last_stats_emit_at = 0.0
        self._debug_trace_enabled = (
            VOICE_HELPER_DEBUG_TRACE_SESSION_ID == "*"
            or VOICE_HELPER_DEBUG_TRACE_SESSION_ID == self.session_id
        )

    def _set_phase(self, phase: str) -> None:
        if self.phase == phase:
            return
        self.phase = phase
        self.phase_history.append(phase)
        self._stats_dirty = True
        LOGGER.info("Session %s phase -> %s", self.session_id, phase)

    def _diagnostics(self) -> str:
        history = " > ".join(self.phase_history[-8:])
        return (
            f"session_id={self.session_id} phase={self.phase} "
            f"last_opcode={self.last_voice_opcode} close_code={self.last_close_code} "
            f"history={history}"
        )

    @property
    def dave_max_version(self) -> int:
        return min(self.dave_state.MAX_SUPPORTED_VERSION, dave.get_max_supported_protocol_version())

    def build_stats_snapshot(self) -> dict[str, object]:
        decrypt_stats = self.dave_state.get_aggregate_stats()
        pending_packets = sum(len(queue) for queue in self.pending_packets.values())
        return {
            "sessionId": self.session_id,
            "guildId": str(self.guild_id),
            "channelId": str(self.channel_id),
            "running": not self.stop_event.is_set(),
            "phase": self.phase,
            "phaseHistory": self.phase_history[-8:],
            "lastVoiceOpcode": self.last_voice_opcode,
            "lastCloseCode": self.last_close_code,
            "packetsReceived": self.counters.packets_received,
            "unknownSsrcQueued": self.counters.unknown_ssrc_queued,
            "missingDecryptorQueued": self.counters.missing_decryptor_queued,
            "pendingQueueDrops": self.counters.pending_queue_drops,
            "transportDecryptDrops": self.counters.transport_decrypt_drops,
            "mediaDecryptDrops": self.counters.media_decrypt_drops,
            "decodeFailures": self.counters.decode_failures,
            "pcmFramesAccepted": self.counters.pcm_frames_accepted,
            "segmentsFlushed": self.counters.segments_flushed,
            "spoolWrites": self.counters.spool_writes,
            "pendingSsrcs": len(self.pending_packets),
            "pendingPackets": pending_packets,
            "daveDecryptAttempts": decrypt_stats.decrypt_attempts,
            "daveDecryptSuccesses": decrypt_stats.decrypt_success_count,
            "daveDecryptFailures": decrypt_stats.decrypt_failure_count,
            "daveMissingKeyFailures": decrypt_stats.decrypt_missing_key_count,
            "daveInvalidNonceFailures": decrypt_stats.decrypt_invalid_nonce_count,
            "davePassthroughFrames": decrypt_stats.passthrough_count,
        }

    async def _emit_stats(self, *, reason: str, force: bool = False) -> None:
        now = time.monotonic()
        if not force and (not self._stats_dirty or (now - self._last_stats_emit_at) < (VOICE_STATS_EMIT_INTERVAL_MS / 1000)):
            return
        payload = self.build_stats_snapshot()
        payload["reason"] = reason
        await self.emit({"type": "session_stats", "payload": payload})
        self._stats_dirty = False
        self._last_stats_emit_at = now
        if self._debug_trace_enabled:
            LOGGER.info("Session %s stats -> %s", self.session_id, json.dumps(payload, ensure_ascii=True, sort_keys=True))

    async def start(self) -> None:
        self._set_phase("creating_http_session")
        try:
            self.http_session = aiohttp.ClientSession()
            self.udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.udp_socket.setblocking(False)
            self._set_phase("connecting_voice_websocket")
            self.voice_ws = await self.http_session.ws_connect(f"wss://{self.voice_endpoint}/?v=8", compress=15)
            self._set_phase("voice_websocket_connected")
            self.ws_task = asyncio.create_task(self._ws_loop())
            await self.send_json(
                {
                    "op": VoiceOpcode.IDENTIFY,
                    "d": {
                        "server_id": str(self.guild_id),
                        "user_id": str(self.bot_user_id),
                        "session_id": self.voice_session_id,
                        "token": self.voice_token,
                        "max_dave_protocol_version": self.dave_max_version,
                    },
                }
            )
            self._set_phase("identify_sent")
            # Wait for readiness, but wake immediately if the websocket loop exits first
            # (e.g. Discord closes with 4017). Otherwise an early close would block here
            # for the full timeout and surface as a misleading "timed out".
            ready_task = asyncio.create_task(self.ws_ready.wait())
            try:
                done, _pending = await asyncio.wait(
                    {ready_task, self.ws_task},
                    timeout=30,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                ready_task.cancel()
            if not self.ws_ready.is_set():
                if self.ws_task in done:
                    raise RuntimeError(
                        f"Voice websocket closed before session was ready; {self._diagnostics()}"
                    ) from self.ws_task.exception()
                raise RuntimeError(f"Timed out waiting for voice session readiness; {self._diagnostics()}")
            self.udp_task = asyncio.create_task(self._udp_loop())
            self.flush_task = asyncio.create_task(self._flush_loop())
            self.watch_task = asyncio.create_task(self._watch_tasks())
            self._set_phase("session_running")
            await self._emit_stats(reason="session_started", force=True)
        except Exception:
            await self.stop()
            raise

    async def stop(self) -> None:
        self.stop_event.set()
        for task in (self.heartbeat_task, self.udp_task, self.flush_task, self.ws_task, self.watch_task):
            if task is not None:
                task.cancel()
        await asyncio.gather(
            *(task for task in (self.heartbeat_task, self.udp_task, self.flush_task, self.ws_task, self.watch_task) if task is not None),
            return_exceptions=True,
        )
        await self._flush_all()
        if self.voice_ws is not None and not self.voice_ws.closed:
            await self.voice_ws.close()
        if self.http_session is not None and not self.http_session.closed:
            await self.http_session.close()
        if self.udp_socket is not None:
            self.udp_socket.close()
        await self._emit_stats(reason="session_stopped", force=True)

    async def send_json(self, payload: dict[str, object]) -> None:
        assert self.voice_ws is not None
        await self.voice_ws.send_str(json.dumps(payload))

    async def send_binary(self, payload: bytes) -> None:
        assert self.voice_ws is not None
        await self.voice_ws.send_bytes(payload)

    async def _ws_loop(self) -> None:
        assert self.voice_ws is not None
        while not self.stop_event.is_set():
            message = await self.voice_ws.receive()
            if message.type == aiohttp.WSMsgType.TEXT:
                await self._handle_ws_json(json.loads(message.data))
            elif message.type == aiohttp.WSMsgType.BINARY:
                await self._handle_ws_binary(message.data)
            elif message.type in {aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING}:
                self.last_close_code = self.voice_ws.close_code
                self._set_phase("voice_websocket_closed")
                raise RuntimeError(f"Voice websocket closed before session was ready; {self._diagnostics()}")
            elif message.type == aiohttp.WSMsgType.ERROR:
                self._set_phase("voice_websocket_error")
                raise RuntimeError(f"Voice websocket error; {self._diagnostics()}")

    async def _handle_ws_json(self, payload: dict[str, Any]) -> None:
        op = payload["op"]
        self.last_voice_opcode = int(op)
        data = payload.get("d") or {}
        if "seq" in payload:
            self.sequence = int(payload["seq"])
        if op == VoiceOpcode.HELLO:
            self._set_phase("hello_received")
            self.heartbeat_interval = float(data["heartbeat_interval"]) / 1000.0
            self.heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            return
        if op == VoiceOpcode.READY:
            self._set_phase("ready_received")
            await self._perform_ip_discovery(data)
            return
        if op == VoiceOpcode.SESSION_DESCRIPTION:
            self._set_phase("session_description_received")
            self.transport_mode = data["mode"]
            self.transport_secret_key = data["secret_key"]
            await self.send_json(
                {
                    "op": VoiceOpcode.SPEAKING,
                    "d": {"speaking": 0, "delay": 0, "ssrc": self.ssrc},
                }
            )
            dave_version = data.get("dave_protocol_version")
            if dave_version is not None:
                self._set_phase("dave_negotiation")
                await self.dave_state.reinit_state(int(dave_version))
            self._set_phase("voice_session_ready")
            self.ws_ready.set()
            return
        if op == VoiceOpcode.SPEAKING:
            self._set_phase("speaker_mapping")
            ssrc = int(data["ssrc"])
            user_id = int(data["user_id"])
            self.ssrc_map[ssrc] = {"user_id": user_id, "speaking": int(data.get("speaking", 0))}
            self.dave_state.add_recognized_user(user_id)
            await self._drain_pending_packets(ssrc)
            await self._emit_stats(reason="speaker_mapping")
            return
        if op == VoiceOpcode.CLIENTS_CONNECT:
            for user_id in map(int, data.get("user_ids", [])):
                self.dave_state.add_recognized_user(user_id)
            await self._drain_all_pending_packets()
            await self._emit_stats(reason="clients_connect")
            return
        if op == VoiceOpcode.CLIENT_DISCONNECT:
            self.dave_state.remove_recognized_user(int(data["user_id"]))
            self._stats_dirty = True
            return
        if op == VoiceOpcode.DAVE_PREPARE_TRANSITION:
            await self.dave_state.prepare_transition(int(data["transition_id"]), int(data["protocol_version"]))
            await self._emit_stats(reason="dave_prepare_transition")
            return
        if op == VoiceOpcode.DAVE_EXECUTE_TRANSITION:
            self.dave_state.execute_transition(int(data["transition_id"]))
            await self._drain_all_pending_packets()
            await self._emit_stats(reason="dave_execute_transition")
            return
        if op == VoiceOpcode.DAVE_MLS_PREPARE_EPOCH:
            await self.dave_state.prepare_epoch(int(data["epoch"]), int(data["protocol_version"]))
            await self._emit_stats(reason="dave_prepare_epoch")

    async def _handle_ws_binary(self, message: bytes) -> None:
        if len(message) < 3:
            return
        self.sequence = int.from_bytes(message[0:2], "big", signed=False)
        op = message[2]
        self.last_voice_opcode = int(op)
        if op == VoiceOpcode.DAVE_MLS_EXTERNAL_SENDER:
            self._set_phase("dave_external_sender")
            self.dave_state.handle_mls_external_sender(message[3:])
            await self._emit_stats(reason="dave_external_sender")
        elif op == VoiceOpcode.DAVE_MLS_PROPOSALS:
            self._set_phase("dave_proposals")
            await self.dave_state.handle_mls_proposals(message[3:])
            await self._emit_stats(reason="dave_proposals")
        elif op == VoiceOpcode.DAVE_MLS_ANNOUNCE_COMMIT_TRANSITION:
            self._set_phase("dave_commit_transition")
            transition_id = int.from_bytes(message[3:5], "big", signed=False)
            await self.dave_state.handle_mls_announce_commit_transition(transition_id, message[5:])
            await self._emit_stats(reason="dave_commit_transition")
        elif op == VoiceOpcode.DAVE_MLS_WELCOME:
            self._set_phase("dave_welcome")
            transition_id = int.from_bytes(message[3:5], "big", signed=False)
            await self.dave_state.handle_mls_welcome(transition_id, message[5:])
            await self._drain_all_pending_packets()
            await self._emit_stats(reason="dave_welcome")

    async def _perform_ip_discovery(self, data: dict[str, Any]) -> None:
        assert self.udp_socket is not None
        self._set_phase("udp_ip_discovery")
        self.ssrc = int(data["ssrc"])
        self.voice_port = int(data["port"])
        self.endpoint_ip = str(data["ip"])

        packet = bytearray(74)
        struct.pack_into(">H", packet, 0, 1)
        struct.pack_into(">H", packet, 2, 70)
        struct.pack_into(">I", packet, 4, self.ssrc)
        self.udp_socket.sendto(packet, (self.endpoint_ip, self.voice_port))
        recv = await asyncio.get_running_loop().sock_recv(self.udp_socket, 74)
        ip_start = 8
        ip_end = recv.index(0, ip_start)
        self.ip = recv[ip_start:ip_end].decode("ascii")
        self.port = struct.unpack_from(">H", recv, len(recv) - 2)[0]
        self._set_phase("udp_protocol_select")
        await self.send_json(
            {
                "op": VoiceOpcode.SELECT_PROTOCOL,
                "d": {
                    "protocol": "udp",
                    "data": {
                        "address": self.ip,
                        "port": self.port,
                        "mode": "aead_xchacha20_poly1305_rtpsize",
                    },
                },
            }
        )

    async def _heartbeat_loop(self) -> None:
        while not self.stop_event.is_set():
            await self.send_json(
                {
                    "op": VoiceOpcode.HEARTBEAT,
                    "d": {
                        "t": int(time.time() * 1000),
                        "seq_ack": self.sequence,
                    },
                }
            )
            await asyncio.sleep(min(self.heartbeat_interval, 5.0))

    async def _udp_loop(self) -> None:
        assert self.udp_socket is not None
        loop = asyncio.get_running_loop()
        while not self.stop_event.is_set():
            data = await loop.sock_recv(self.udp_socket, 4096)
            await self._handle_udp_packet(data)

    async def _handle_udp_packet(self, packet: bytes) -> None:
        if len(packet) < 16:
            return
        if packet[1] & 0x78 != 0x78:
            return
        self.counters.packets_received += 1
        self._stats_dirty = True
        header, payload = self._split_rtp_packet(packet)
        ssrc = struct.unpack_from(">I", packet, 8)[0]
        timestamp = struct.unpack_from(">I", packet, 4)[0]
        decrypted_transport = self._decrypt_transport(header, payload)
        if decrypted_transport is None:
            self.counters.transport_decrypt_drops += 1
            self._stats_dirty = True
            return
        user_info = self.ssrc_map.get(ssrc)
        pending = PendingPacket(ssrc=ssrc, timestamp=timestamp, received_at=time.monotonic(), frame=decrypted_transport)
        if user_info is None:
            self._queue_pending_packet(pending, reason="unknown_ssrc")
            return
        await self._route_pending_packet(pending, int(user_info["user_id"]))

    async def _drain_pending_packets(self, ssrc: int) -> None:
        user_info = self.ssrc_map.get(ssrc)
        if user_info is None:
            return
        queued = self.pending_packets.get(ssrc)
        if queued is None:
            return
        user_id = int(user_info["user_id"])
        while queued:
            ready, reason = self.dave_state.can_decrypt_user(user_id, now_monotonic=queued[0].received_at)
            if not ready:
                if reason != "transition_pause":
                    self._stats_dirty = True
                break
            pending = queued.popleft()
            processed = await self._process_pending_packet(pending, user_id)
            if not processed:
                break
        if not queued:
            self.pending_packets.pop(ssrc, None)

    async def _drain_all_pending_packets(self) -> None:
        for ssrc in list(self.pending_packets.keys()):
            await self._drain_pending_packets(ssrc)

    async def _route_pending_packet(self, pending: PendingPacket, user_id: int) -> None:
        ready, _reason = self.dave_state.can_decrypt_user(user_id, now_monotonic=pending.received_at)
        if not ready:
            self._queue_pending_packet(pending, reason="missing_decryptor")
            return
        await self._process_pending_packet(pending, user_id)

    def _queue_pending_packet(self, pending: PendingPacket, *, reason: str) -> None:
        queue = self.pending_packets.setdefault(pending.ssrc, deque())
        if len(queue) >= VOICE_PACKET_QUEUE_LIMIT:
            queue.popleft()
            self.counters.pending_queue_drops += 1
        queue.append(pending)
        if reason == "unknown_ssrc":
            self.counters.unknown_ssrc_queued += 1
        else:
            self.counters.missing_decryptor_queued += 1
        self._stats_dirty = True

    async def _process_pending_packet(self, pending: PendingPacket, user_id: int) -> bool:
        frame = self.dave_state.decrypt_frame(user_id, pending.frame)
        if frame == b"\xf8\xff\xfe":
            # Opus silence/DTX frame: DAVE decryption succeeded, there is just no
            # audio to decode. Skip it and keep draining — do NOT defer the user.
            return True
        if frame is None:
            # Transient media-decrypt miss (e.g. a frame straddling a key rotation).
            # Drop just this frame and keep going; deferring the whole user here was
            # pausing capture for VOICE_MEDIA_PAUSE_MS on every miss and overflowing
            # the pending queue (~33% of packets were lost this way).
            self.counters.media_decrypt_drops += 1
            self._stats_dirty = True
            return True
        decoder = self.decoders.get(pending.ssrc)
        if decoder is None:
            decoder = discord.opus.Decoder()
            self.decoders[pending.ssrc] = decoder
        try:
            pcm_bytes = decoder.decode(frame)
        except Exception:
            self.counters.decode_failures += 1
            self._stats_dirty = True
            LOGGER.exception("Failed to decode opus frame for user %s", user_id)
            await self._emit_stats(reason="decode_failure")
            return True
        self.counters.pcm_frames_accepted += 1
        self._stats_dirty = True
        flushed = self.segmenter.append_pcm(user_id, pcm_bytes, now_monotonic=pending.received_at, now_dt=utc_now())
        for chunk in flushed:
            await self._persist_chunk(chunk)
        return True

    async def _flush_loop(self) -> None:
        while not self.stop_event.is_set():
            await asyncio.sleep(max(0.5, VOICE_SEGMENT_SILENCE_MS / 2000))
            await self._drain_all_pending_packets()
            flushed = self.segmenter.flush_inactive(now_monotonic=time.monotonic(), now_dt=utc_now())
            for chunk in flushed:
                await self._persist_chunk(chunk)
            await self._emit_stats(reason="periodic")

    async def _watch_tasks(self) -> None:
        tasks = [task for task in (self.ws_task, self.udp_task) if task is not None]
        if not tasks:
            return
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        for task in done:
            exc = task.exception()
            if exc is not None and not self.stop_event.is_set():
                raise RuntimeError(f"Voice session background task failed; {self._diagnostics()}") from exc

    async def _flush_all(self) -> None:
        flushed = self.segmenter.flush_all(now_dt=utc_now())
        for chunk in flushed:
            await self._persist_chunk(chunk)

    async def _persist_chunk(self, chunk: PCMChunk) -> None:
        if not chunk.pcm_bytes:
            return
        self.counters.segments_flushed += 1
        self._stats_dirty = True
        record = self.spool_writer.write_segment(
            session_id=self.session_id,
            guild_id=str(self.guild_id),
            channel_id=str(self.channel_id),
            user_id=str(chunk.user_id),
            pcm_bytes=chunk.pcm_bytes,
            started_at=chunk.started_at,
            ended_at=chunk.ended_at,
            sample_rate=discord.opus.Decoder.SAMPLING_RATE,
            channels=discord.opus.Decoder.CHANNELS,
            sample_width=2,
        ).to_dict()
        self.counters.spool_writes += 1
        self._stats_dirty = True
        await self.emit({"type": "segment_ready", "payload": record})
        await self._emit_stats(reason="segment_ready")

    def _split_rtp_packet(self, data: bytes) -> tuple[bytes, bytes]:
        if self.transport_mode.endswith("_rtpsize"):
            cutoff = 12 + (data[0] & 0b00001111) * 4
            if data[0] & 0b00010000:
                cutoff += 4
        else:
            cutoff = 12
        return data[:cutoff], data[cutoff:]

    def _decrypt_transport(self, header: bytes, payload: bytes) -> bytes | None:
        if self.transport_secret_key is None:
            return None
        if self.transport_mode != "aead_xchacha20_poly1305_rtpsize":
            raise RuntimeError(f"Unsupported transport mode: {self.transport_mode}")
        box = nacl.secret.Aead(bytes(self.transport_secret_key))
        nonce = bytearray(24)
        nonce[:4] = payload[-4:]
        ciphertext = payload[:-4]
        try:
            frame = box.decrypt(bytes(ciphertext), bytes(header), bytes(nonce))
        except Exception:
            LOGGER.debug("Failed to decrypt transport frame")
            return None
        return frame[8:]


class HelperRuntime:
    def __init__(self) -> None:
        self.sessions: dict[str, VoiceReceiveSession] = {}
        self.spool_writer = SpoolWriter(VOICE_CAPTURE_AUDIO_DIR, VOICE_CAPTURE_SPOOL_DIR)
        self.stdout_lock = asyncio.Lock()
        self.shutdown_requested = False

    async def emit(self, payload: dict[str, object]) -> None:
        async with self.stdout_lock:
            sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
            sys.stdout.flush()

    async def respond(self, request_id: str, *, success: bool, payload: dict[str, object] | None = None, error: dict[str, object] | None = None) -> None:
        await self.emit(
            {
                "type": "response",
                "requestId": request_id,
                "success": success,
                "payload": payload or {},
                "error": error,
            }
        )

    async def handle_request(self, request: dict[str, object]) -> None:
        request_id = str(request.get("requestId") or "")
        request_type = str(request.get("type") or "")
        payload = dict(request.get("payload") or {})
        try:
            if request_type == "ready_check":
                await self.respond(request_id, success=True, payload={"ready": True})
                return
            if request_type == "start_session":
                result = await self.start_session(payload)
                await self.respond(request_id, success=True, payload=result)
                return
            if request_type == "stop_session":
                result = await self.stop_session(str(payload["sessionId"]))
                await self.respond(request_id, success=True, payload=result)
                return
            if request_type == "shutdown":
                await self.respond(request_id, success=True, payload={"shuttingDown": True})
                await self.shutdown()
                return
            await self.respond(request_id, success=False, error={"code": "UNKNOWN_REQUEST", "message": f"Unknown request: {request_type}"})
        except Exception as error:
            LOGGER.exception("Helper request failed: %s", request_type)
            await self.respond(
                request_id,
                success=False,
                error={"code": "HELPER_REQUEST_FAILED", "message": str(error)},
            )

    async def start_session(self, payload: dict[str, object]) -> dict[str, object]:
        session_id = str(payload["sessionId"])
        if session_id in self.sessions:
            session = self.sessions[session_id]
            return {
                "sessionId": session_id,
                "guildId": str(session.guild_id),
                "channelId": str(session.channel_id),
                "alreadyRunning": True,
                "stats": session.build_stats_snapshot(),
            }
        session = VoiceReceiveSession(
            emit=self.emit,
            session_id=session_id,
            guild_id=int(payload["guildId"]),
            channel_id=int(payload["channelId"]),
            bot_user_id=int(payload["botUserId"]),
            voice_endpoint=str(payload["voiceEndpoint"]),
            voice_token=str(payload["voiceToken"]),
            voice_session_id=str(payload["voiceSessionId"]),
            self_mute=bool(payload.get("selfMute", True)),
            self_deaf=bool(payload.get("selfDeaf", False)),
            spool_writer=self.spool_writer,
        )
        self.sessions[session_id] = session
        try:
            await session.start()
        except Exception:
            try:
                await session.stop()
            except Exception:
                LOGGER.exception("Failed to clean up voice session after start failure: %s", session_id)
            self.sessions.pop(session_id, None)
            raise
        if session.watch_task is not None:
            session.watch_task.add_done_callback(
                lambda task, session_id=session_id: asyncio.create_task(self._handle_session_task(session_id, task))
            )
        stats = session.build_stats_snapshot()
        await self.emit(
            {
                "type": "session_started",
                "payload": {
                    "sessionId": session_id,
                    "guildId": str(session.guild_id),
                    "channelId": str(session.channel_id),
                    "stats": stats,
                },
            }
        )
        return {"sessionId": session_id, "guildId": str(session.guild_id), "channelId": str(session.channel_id), "stats": stats}

    async def stop_session(self, session_id: str) -> dict[str, object]:
        session = self.sessions.pop(session_id, None)
        if session is None:
            return {"sessionId": session_id, "stopped": False}
        await session.stop()
        stats = session.build_stats_snapshot()
        await self.emit({"type": "session_stopped", "payload": {"sessionId": session_id, "stopped": True, "stats": stats}})
        return {"sessionId": session_id, "stopped": True, "stats": stats}

    async def shutdown(self) -> None:
        if self.shutdown_requested:
            return
        self.shutdown_requested = True
        for session_id in list(self.sessions):
            try:
                await self.stop_session(session_id)
            except Exception:
                LOGGER.exception("Failed stopping session %s", session_id)

    async def _handle_session_task(self, session_id: str, task: asyncio.Task) -> None:
        if task.cancelled():
            return
        try:
            task.result()
        except Exception as error:
            LOGGER.exception("Voice receive session crashed: %s", session_id)
            session = self.sessions.pop(session_id, None)
            phase = session.phase if session is not None else "unknown"
            close_code = session.last_close_code if session is not None else None
            stats = session.build_stats_snapshot() if session is not None else {}
            await self.emit(
                {
                    "type": "session_error",
                    "payload": {
                        "sessionId": session_id,
                        "code": "VOICE_SESSION_CRASHED",
                        "message": str(error),
                        "phase": phase,
                        "closeCode": close_code,
                        "stats": stats,
                    },
                }
            )


async def _main() -> None:
    runtime = HelperRuntime()
    await runtime.emit({"type": "ready", "payload": {"helperVersion": "1"}})
    while not runtime.shutdown_requested:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            await runtime.shutdown()
            break
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            LOGGER.warning("Ignoring malformed helper request: %s", line)
            continue
        await runtime.handle_request(request)


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
