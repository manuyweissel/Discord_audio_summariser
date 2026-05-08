from __future__ import annotations

import asyncio
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
        if transition_id == self.INIT_TRANSITION_ID:
            self.execute_transition(transition_id)
        else:
            await self.session.send_json({"op": VoiceOpcode.DAVE_TRANSITION_READY, "d": {"transition_id": transition_id}})

    def execute_transition(self, transition_id: int) -> None:
        version = self.prepared_transitions.pop(transition_id, None)
        if version is None:
            return
        self.protocol_version = version
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

    def handle_mls_external_sender(self, data: bytes) -> None:
        self.mls_session.set_external_sender(data)

    async def handle_mls_proposals(self, data: bytes) -> None:
        recognized = {str(user_id) for user_id in self.recognized_users}
        commit_welcome = self.mls_session.process_proposals(data, recognized)
        if commit_welcome is not None:
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
        self.pending_packets: dict[int, list[PendingPacket]] = {}
        self.decoders: dict[int, discord.opus.Decoder] = {}
        self.dave_state = DaveReceiveState(self)
        self.phase = "initialized"
        self.phase_history: list[str] = [self.phase]
        self.last_voice_opcode: int | None = None
        self.last_close_code: int | None = None

    def _set_phase(self, phase: str) -> None:
        if self.phase == phase:
            return
        self.phase = phase
        self.phase_history.append(phase)
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
            try:
                await asyncio.wait_for(self.ws_ready.wait(), timeout=30)
            except asyncio.TimeoutError as error:
                raise RuntimeError(f"Timed out waiting for voice session readiness; {self._diagnostics()}") from error
            self.udp_task = asyncio.create_task(self._udp_loop())
            self.flush_task = asyncio.create_task(self._flush_loop())
            self.watch_task = asyncio.create_task(self._watch_tasks())
            self._set_phase("session_running")
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
            return
        if op == VoiceOpcode.CLIENTS_CONNECT:
            for user_id in map(int, data.get("user_ids", [])):
                self.dave_state.add_recognized_user(user_id)
            return
        if op == VoiceOpcode.CLIENT_DISCONNECT:
            self.dave_state.remove_recognized_user(int(data["user_id"]))
            return
        if op == VoiceOpcode.DAVE_PREPARE_TRANSITION:
            await self.dave_state.prepare_transition(int(data["transition_id"]), int(data["protocol_version"]))
            return
        if op == VoiceOpcode.DAVE_EXECUTE_TRANSITION:
            self.dave_state.execute_transition(int(data["transition_id"]))
            return
        if op == VoiceOpcode.DAVE_MLS_PREPARE_EPOCH:
            await self.dave_state.prepare_epoch(int(data["epoch"]), int(data["protocol_version"]))

    async def _handle_ws_binary(self, message: bytes) -> None:
        if len(message) < 3:
            return
        self.sequence = int.from_bytes(message[0:2], "big", signed=False)
        op = message[2]
        self.last_voice_opcode = int(op)
        if op == VoiceOpcode.DAVE_MLS_EXTERNAL_SENDER:
            self._set_phase("dave_external_sender")
            self.dave_state.handle_mls_external_sender(message[3:])
        elif op == VoiceOpcode.DAVE_MLS_PROPOSALS:
            self._set_phase("dave_proposals")
            await self.dave_state.handle_mls_proposals(message[3:])
        elif op == VoiceOpcode.DAVE_MLS_ANNOUNCE_COMMIT_TRANSITION:
            self._set_phase("dave_commit_transition")
            transition_id = int.from_bytes(message[3:5], "big", signed=False)
            await self.dave_state.handle_mls_announce_commit_transition(transition_id, message[5:])
        elif op == VoiceOpcode.DAVE_MLS_WELCOME:
            self._set_phase("dave_welcome")
            transition_id = int.from_bytes(message[3:5], "big", signed=False)
            await self.dave_state.handle_mls_welcome(transition_id, message[5:])

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
        header, payload = self._split_rtp_packet(packet)
        ssrc = struct.unpack_from(">I", packet, 8)[0]
        timestamp = struct.unpack_from(">I", packet, 4)[0]
        decrypted_transport = self._decrypt_transport(header, payload)
        if decrypted_transport is None:
            return
        user_info = self.ssrc_map.get(ssrc)
        pending = PendingPacket(ssrc=ssrc, timestamp=timestamp, received_at=time.monotonic(), frame=decrypted_transport)
        if user_info is None:
            self.pending_packets.setdefault(ssrc, []).append(pending)
            return
        await self._process_pending_packet(pending, int(user_info["user_id"]))

    async def _drain_pending_packets(self, ssrc: int) -> None:
        user_info = self.ssrc_map.get(ssrc)
        if user_info is None:
            return
        queued = self.pending_packets.pop(ssrc, [])
        for pending in queued:
            await self._process_pending_packet(pending, int(user_info["user_id"]))

    async def _process_pending_packet(self, pending: PendingPacket, user_id: int) -> None:
        frame = self.dave_state.decrypt_frame(user_id, pending.frame)
        if frame in (None, b"\xf8\xff\xfe"):
            return
        decoder = self.decoders.get(pending.ssrc)
        if decoder is None:
            decoder = discord.opus.Decoder()
            self.decoders[pending.ssrc] = decoder
        try:
            pcm_bytes = decoder.decode(frame)
        except Exception:
            LOGGER.exception("Failed to decode opus frame for user %s", user_id)
            return
        flushed = self.segmenter.append_pcm(user_id, pcm_bytes, now_monotonic=pending.received_at, now_dt=utc_now())
        for chunk in flushed:
            await self._persist_chunk(chunk)

    async def _flush_loop(self) -> None:
        while not self.stop_event.is_set():
            await asyncio.sleep(max(0.5, VOICE_SEGMENT_SILENCE_MS / 2000))
            flushed = self.segmenter.flush_inactive(now_monotonic=time.monotonic(), now_dt=utc_now())
            for chunk in flushed:
                await self._persist_chunk(chunk)

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
        await self.emit({"type": "segment_ready", "payload": record})

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
            return {"sessionId": session_id, "guildId": str(session.guild_id), "channelId": str(session.channel_id), "alreadyRunning": True}
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
        await self.emit({"type": "session_started", "payload": {"sessionId": session_id, "guildId": str(session.guild_id), "channelId": str(session.channel_id)}})
        return {"sessionId": session_id, "guildId": str(session.guild_id), "channelId": str(session.channel_id)}

    async def stop_session(self, session_id: str) -> dict[str, object]:
        session = self.sessions.pop(session_id, None)
        if session is None:
            return {"sessionId": session_id, "stopped": False}
        await session.stop()
        await self.emit({"type": "session_stopped", "payload": {"sessionId": session_id, "stopped": True}})
        return {"sessionId": session_id, "stopped": True}

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
            await self.emit(
                {
                    "type": "session_error",
                    "payload": {
                        "sessionId": session_id,
                        "code": "VOICE_SESSION_CRASHED",
                        "message": str(error),
                        "phase": phase,
                        "closeCode": close_code,
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
