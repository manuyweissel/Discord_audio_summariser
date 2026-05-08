from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import logging
import os
import sys
from typing import Any

import discord

from voice_worker.sink import SegmentingSink
from voice_worker.spool import SpoolWriter


logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
LOGGER = logging.getLogger("voice_worker")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


VOICE_CAPTURE_AUDIO_DIR = os.environ.get("VOICE_CAPTURE_AUDIO_DIR", "audios")
VOICE_CAPTURE_SPOOL_DIR = os.environ.get("VOICE_CAPTURE_SPOOL_DIR", os.path.join("data", "voice_capture_spool"))
VOICE_WORKER_SEGMENT_SILENCE_MS = _env_int("VOICE_WORKER_SEGMENT_SILENCE_MS", 2000)
VOICE_WORKER_MAX_SEGMENT_MS = _env_int("VOICE_WORKER_MAX_SEGMENT_MS", 30000)
DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN")


@dataclass(slots=True)
class SessionState:
    session_id: str
    guild_id: str
    channel_id: str
    voice_client: discord.VoiceClient
    sink: SegmentingSink
    silence_task: asyncio.Task[Any]
    stop_waiter: asyncio.Future[dict[str, object]]


class VoiceWorker(discord.Client):
    def __init__(self) -> None:
        intents = discord.Intents.none()
        intents.guilds = True
        intents.voice_states = True
        super().__init__(intents=intents)
        self.spool_writer = SpoolWriter(VOICE_CAPTURE_AUDIO_DIR, VOICE_CAPTURE_SPOOL_DIR)
        self.sessions: dict[str, SessionState] = {}
        self.stdout_lock = asyncio.Lock()
        self.stdin_task: asyncio.Task[Any] | None = None
        self.shutdown_requested = False

    async def setup_hook(self) -> None:
        self.stdin_task = asyncio.create_task(self._read_stdin())

    async def on_ready(self) -> None:
        await self._emit({"type": "ready", "payload": {"userId": str(self.user.id), "username": self.user.name}})

    async def close(self) -> None:
        if self.stdin_task:
            self.stdin_task.cancel()
        await super().close()

    async def _emit(self, payload: dict[str, object]) -> None:
        async with self.stdout_lock:
            sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
            sys.stdout.flush()

    async def _emit_error(self, code: str, message: str, *, session_id: str | None = None) -> None:
        await self._emit({"type": "error", "payload": {"code": code, "message": message, "sessionId": session_id}})

    async def _respond(
        self,
        request_id: str,
        *,
        success: bool,
        payload: dict[str, object] | None = None,
        error: dict[str, object] | None = None,
    ) -> None:
        await self._emit(
            {
                "type": "response",
                "requestId": request_id,
                "success": success,
                "payload": payload or {},
                "error": error,
            }
        )

    async def _read_stdin(self) -> None:
        while not self.is_closed():
            try:
                line = await asyncio.to_thread(sys.stdin.readline)
            except asyncio.CancelledError:
                return

            if not line:
                if not self.shutdown_requested:
                    await self._shutdown()
                return

            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                LOGGER.warning("Ignoring malformed stdin payload: %s", line.rstrip())
                continue

            asyncio.create_task(self._handle_request(request))

    async def _handle_request(self, request: dict[str, object]) -> None:
        request_id = str(request.get("requestId") or "")
        request_type = request.get("type")
        payload = request.get("payload") or {}

        try:
            if request_type == "ready_check":
                await self._respond(request_id, success=True, payload={"ready": not self.is_closed()})
                return

            if request_type == "start_session":
                result = await self._start_session(payload)
                await self._respond(request_id, success=True, payload=result)
                return

            if request_type == "stop_session":
                result = await self._stop_session(str(payload.get("sessionId")))
                await self._respond(request_id, success=True, payload=result)
                return

            if request_type == "shutdown":
                await self._respond(request_id, success=True, payload={"shuttingDown": True})
                await self._shutdown()
                return

            await self._respond(
                request_id,
                success=False,
                error={"code": "UNKNOWN_REQUEST", "message": f"Unknown worker request: {request_type}"},
            )
        except Exception as error:  # pragma: no cover - exercised by integration
            LOGGER.exception("Worker request failed: %s", request_type)
            await self._emit_error("WORKER_REQUEST_FAILED", str(error), session_id=str(payload.get("sessionId") or ""))
            await self._respond(
                request_id,
                success=False,
                error={"code": "WORKER_REQUEST_FAILED", "message": str(error)},
            )

    async def _start_session(self, payload: dict[str, object]) -> dict[str, object]:
        session_id = str(payload["sessionId"])
        guild_id = int(payload["guildId"])
        channel_id = int(payload["channelId"])

        if session_id in self.sessions:
            existing = self.sessions[session_id]
            return {
                "sessionId": session_id,
                "guildId": existing.guild_id,
                "channelId": existing.channel_id,
                "alreadyRunning": True,
            }

        for other_session_id, other_session in list(self.sessions.items()):
            if other_session.guild_id == str(guild_id) and other_session_id != session_id:
                await self._stop_session(other_session_id)

        guild = self.get_guild(guild_id) or await self.fetch_guild(guild_id)
        channel = self.get_channel(channel_id) or await self.fetch_channel(channel_id)
        if channel is None or not hasattr(channel, "connect"):
            raise RuntimeError(f"Channel {channel_id} is not a voice-capable channel")

        voice_client = discord.utils.get(self.voice_clients, guild=guild)
        if voice_client is None:
            voice_client = await channel.connect()
        elif getattr(voice_client.channel, "id", None) != channel_id:
            await voice_client.move_to(channel)

        sink = SegmentingSink(
            session_id=session_id,
            guild_id=str(guild_id),
            channel_id=str(channel_id),
            spool_writer=self.spool_writer,
            emit_segment=self._emit_segment,
            silence_ms=VOICE_WORKER_SEGMENT_SILENCE_MS,
            max_segment_ms=VOICE_WORKER_MAX_SEGMENT_MS,
        )
        stop_waiter = asyncio.get_running_loop().create_future()
        silence_task = asyncio.create_task(self._monitor_session_silence(session_id))
        state = SessionState(
            session_id=session_id,
            guild_id=str(guild_id),
            channel_id=str(channel_id),
            voice_client=voice_client,
            sink=sink,
            silence_task=silence_task,
            stop_waiter=stop_waiter,
        )
        self.sessions[session_id] = state

        voice_client.start_recording(sink, self._recording_finished, session_id)
        await self._emit(
            {
                "type": "session_started",
                "payload": {
                    "sessionId": session_id,
                    "guildId": str(guild_id),
                    "channelId": str(channel_id),
                },
            }
        )
        return {"sessionId": session_id, "guildId": str(guild_id), "channelId": str(channel_id)}

    async def _stop_session(self, session_id: str) -> dict[str, object]:
        session = self.sessions.get(session_id)
        if session is None:
            return {"sessionId": session_id, "stopped": False}

        if not session.silence_task.done():
            session.silence_task.cancel()

        if session.voice_client.recording:
            session.voice_client.stop_recording()
        else:
            session.sink.cleanup()
            if session.voice_client.is_connected():
                await session.voice_client.disconnect(force=True)
            if not session.stop_waiter.done():
                session.stop_waiter.set_result({"sessionId": session_id, "stopped": True})
            self.sessions.pop(session_id, None)

        result = await asyncio.wait_for(session.stop_waiter, timeout=20)
        return result

    async def _shutdown(self) -> None:
        if self.shutdown_requested:
            return

        self.shutdown_requested = True
        for session_id in list(self.sessions.keys()):
            try:
                await self._stop_session(session_id)
            except Exception:
                LOGGER.exception("Failed to stop session %s during shutdown", session_id)

        await self.close()

    async def _recording_finished(self, sink: SegmentingSink, session_id: str) -> None:
        session = self.sessions.get(session_id)
        if session is None:
            return

        if not session.silence_task.done():
            session.silence_task.cancel()

        if session.voice_client.is_connected():
            await session.voice_client.disconnect(force=True)

        self.sessions.pop(session_id, None)
        result = {"sessionId": session_id, "stopped": True}
        if not session.stop_waiter.done():
            session.stop_waiter.set_result(result)

        await self._emit({"type": "session_stopped", "payload": result})

    async def _monitor_session_silence(self, session_id: str) -> None:
        try:
            while session_id in self.sessions:
                session = self.sessions.get(session_id)
                if session is None:
                    return
                session.sink.flush_inactive()
                await asyncio.sleep(max(0.5, VOICE_WORKER_SEGMENT_SILENCE_MS / 2000))
        except asyncio.CancelledError:
            return

    async def _emit_segment(self, record: dict[str, object]) -> None:
        await self._emit({"type": "segment_ready", "payload": record})


def main() -> None:
    if not DISCORD_TOKEN:
        raise SystemExit("DISCORD_TOKEN is required for the voice worker")

    worker = VoiceWorker()
    worker.run(DISCORD_TOKEN)


if __name__ == "__main__":
    main()
