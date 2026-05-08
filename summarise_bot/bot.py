from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import signal
from typing import Any

import discord

from .config import SETTINGS
from .document import convert_to_word_doc
from .health import OpsServer
from .logger import logger
from .manifest import (
    build_transcript_from_manifest,
    cleanup_old_sessions,
    end_session,
    get_session,
    mark_session_pending_recovery,
    mark_session_summarized,
    mark_stale_sessions,
    save_manifest_sync,
)
from .pipeline import VoiceCapturePipeline
from .recovery import RecoveryService
from .reminders import WeeklyReminderScheduler
from .summarization import summarize_transcript
from .summarization import close_client as close_summary_client
from .transcript import TranscriptStore
from .transcription import validate_openai_key
from .transcription import close_client as close_transcription_client
from .voice_helper_client import VoiceHelperClient
from .voice_protocol import GatewayVoiceStateProtocol


@dataclass(slots=True)
class ActiveSession:
    session_id: str
    guild_id: int
    channel_id: int
    protocol: GatewayVoiceStateProtocol


class SummariseBotRuntime:
    def __init__(self) -> None:
        intents = discord.Intents.default()
        intents.guilds = True
        intents.voice_states = True

        self.bot = discord.Bot(intents=intents)
        self.transcript_store = TranscriptStore()
        self.pipeline = VoiceCapturePipeline(self.bot, self.transcript_store)
        self.recovery = RecoveryService(self.transcript_store)
        self.helper = VoiceHelperClient(self.pipeline.ingest_record, self.handle_session_error)
        self.health = OpsServer(self.bot, self.get_health_state)
        self.reminders = WeeklyReminderScheduler(self.bot)
        self.active_sessions: dict[int, ActiveSession] = {}
        self._started = False
        self._periodic_recovery_task: asyncio.Task | None = None
        self._background_tasks: set[asyncio.Task] = set()
        self._shutting_down = False

        self.bot.event(self.on_ready)
        self.bot.event(self.on_application_command_error)
        self._register_commands()

    def _register_commands(self) -> None:
        @self.bot.slash_command(name="join", description="Join the caller's voice channel & start transcribing")
        async def join(ctx: discord.ApplicationContext) -> None:
            await self.handle_join(ctx)

        @self.bot.slash_command(name="leave", description="Leave the current voice channel")
        async def leave(ctx: discord.ApplicationContext) -> None:
            await self.handle_leave(ctx)

    async def on_ready(self) -> None:
        if self._started:
            return
        self._started = True
        logger.info("Discord client ready", extra={"action": "discord_ready", "event": "start"})
        print(f"✅ Bot ready: {self.bot.user}")
        api_key_valid = await validate_openai_key()
        try:
            await self.helper.start()
            print("🐍 Python voice helper ready")
        except Exception as error:
            logger.error(
                "Voice helper failed to start",
                extra={"action": "voice_helper", "event": "start_error", "error_message": str(error)},
            )
            print(f"❌ Voice helper failed to start: {error}")

        await self.health.start()
        await self.reminders.start()
        cleanup_old_sessions(7)
        stale = mark_stale_sessions(SETTINGS.stale_session_hours)
        if stale:
            print(f"🔄 Found {stale} stale session(s) from previous runs")
        replay = await self.pipeline.replay_spool()
        if replay["replayed"] or replay["failed"]:
            print(f"🧵 Replayed {replay['replayed']} pending voice segment(s) ({replay['failed']} failed)")
        if api_key_valid:
            self._track_task(asyncio.create_task(self.recovery.run(auto_summarize=True)))
        self._periodic_recovery_task = asyncio.create_task(self._periodic_recovery_loop())
        self._track_task(self._periodic_recovery_task)

    def _track_task(self, task: asyncio.Task) -> asyncio.Task:
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        return task

    async def _periodic_recovery_loop(self) -> None:
        while True:
            await asyncio.sleep(SETTINGS.recovery_interval_ms / 1000)
            mark_stale_sessions(SETTINGS.stale_session_hours)
            await self.recovery.run(auto_summarize=True)

    async def on_application_command_error(self, ctx: discord.ApplicationContext, error: Exception) -> None:
        logger.error(
            "Application command failed",
            extra={"action": "interaction_handling", "event": "error", "error_message": str(error)},
        )
        try:
            await ctx.respond("❌ Beim Verarbeiten des Befehls ist ein Fehler aufgetreten.", ephemeral=True)
        except Exception:
            pass

    async def handle_join(self, ctx: discord.ApplicationContext) -> None:
        await ctx.defer()
        voice_state = getattr(ctx.author, "voice", None)
        if voice_state is None or voice_state.channel is None:
            await ctx.followup.send("❌ Bitte zuerst einem Sprachkanal beitreten.")
            return
        if ctx.guild_id in self.active_sessions:
            await ctx.followup.send("⚠️ In diesem Server läuft bereits eine Aufnahme.")
            return
        try:
            await self.helper.ensure_ready()
        except Exception as error:
            await ctx.followup.send(f"❌ Voice helper ist nicht bereit: {error}")
            return

        logger.info("Received voice join request", extra={"action": "voice_join", "event": "request"})
        protocol = await voice_state.channel.connect(cls=GatewayVoiceStateProtocol, reconnect=False, timeout=30.0)
        assert isinstance(protocol, GatewayVoiceStateProtocol)
        try:
            session_payload = protocol.export_session(self.bot.user.id)
            await self.helper.start_session(session_payload)
        except Exception as error:
            logger.error(
                "Voice session start failed",
                extra={"action": "voice_join", "event": "error", "error_message": str(error)},
            )
            with contextlib.suppress(Exception):
                await protocol.disconnect(force=True)
            await ctx.followup.send(f"❌ Sprachaufnahme konnte nicht gestartet werden: {error}")
            return

        active = ActiveSession(
            session_id=str(session_payload["sessionId"]),
            guild_id=int(session_payload["guildId"]),
            channel_id=int(session_payload["channelId"]),
            protocol=protocol,
        )
        self.active_sessions[ctx.guild_id] = active
        logger.info("Voice session started", extra={"action": "voice_join", "event": "complete", "session_id": active.session_id})
        await ctx.followup.send(f"🎙️ Aufnahme gestartet in <#{active.channel_id}>.")

    async def handle_leave(self, ctx: discord.ApplicationContext) -> None:
        await ctx.defer()
        active = self.active_sessions.get(ctx.guild_id)
        if active is None:
            await ctx.followup.send("❌ Der Bot ist aktuell in keinem Sprachkanal aktiv.")
            return

        logger.info("Received voice leave request", extra={"action": "voice_leave", "event": "request", "session_id": active.session_id})
        try:
            await self.helper.stop_session(active.session_id)
        except Exception as error:
            logger.warning(
                "Failed stopping voice helper session",
                extra={"action": "voice_leave", "event": "helper_stop_failed", "error_message": str(error), "session_id": active.session_id},
            )

        try:
            await active.protocol.disconnect(force=True)
        except Exception as error:
            logger.warning(
                "Failed disconnecting voice protocol",
                extra={"action": "voice_leave", "event": "protocol_disconnect_failed", "error_message": str(error), "session_id": active.session_id},
            )

        await ctx.followup.send("📝 Verarbeite noch offene Transkriptionen...")
        await self.pipeline.wait_for_pending(active.session_id, timeout=30.0)

        transcript_path = await self._ensure_transcript_path(active)
        summary_path: Path | None = None
        if transcript_path is not None:
            summary = await summarize_transcript(transcript_path)
            if summary:
                summary_path = await self._write_summary_file(active.session_id, summary)

        self.transcript_store.release(active.session_id)
        self.active_sessions.pop(ctx.guild_id, None)
        if summary_path is None or not summary_path.exists():
            await ctx.followup.send("❌ Verbindung getrennt. Kein Transkript gefunden oder nichts zu erstellen.")
            return

        try:
            await ctx.followup.send(
                content="📝 **Meeting-Protokoll erstellt!** 📄",
                file=discord.File(str(summary_path), filename=summary_path.name),
            )
        except Exception:
            await ctx.followup.send(f"📝 Meeting-Protokoll erstellt. Datei gespeichert: `{summary_path.name}`")

    async def handle_session_error(self, payload: dict[str, object]) -> None:
        session_id = str(payload.get("sessionId") or "")
        if session_id:
            mark_session_pending_recovery(session_id)
            for guild_id, active in list(self.active_sessions.items()):
                if active.session_id == session_id:
                    self.active_sessions.pop(guild_id, None)
                    with contextlib.suppress(Exception):
                        await active.protocol.disconnect(force=True)
                    break

    async def _ensure_transcript_path(self, active: ActiveSession) -> Path | None:
        released = self.transcript_store.session_logs.get(active.session_id)
        if released is not None and released.exists():
            end_session(active.session_id, str(released))
            return released
        session = get_session(active.session_id)
        if session and session.get("transcriptPath"):
            transcript_path = Path(session["transcriptPath"])
            if transcript_path.exists():
                end_session(active.session_id, str(transcript_path))
                return transcript_path
        transcript = build_transcript_from_manifest(active.session_id)
        if not transcript.strip():
            return None
        ts = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(":", "-")
        transcript_path = SETTINGS.transcript_dir / f"{active.guild_id}-{active.channel_id}-{ts}-recovered.log"
        transcript_path.write_text(transcript, encoding="utf-8")
        end_session(active.session_id, str(transcript_path))
        return transcript_path

    async def _write_summary_file(self, session_id: str, summary: str) -> Path | None:
        title = "Meeting"
        for line in summary.splitlines():
            if line.startswith("## Meeting Topic"):
                break
            if line.startswith("# Meeting Minutes —"):
                title = line.replace("# Meeting Minutes —", "").strip() or "Meeting"
        buffer = convert_to_word_doc(summary, title)
        if buffer is None:
            return None
        file_name = f"Meeting_Minutes_{datetime.now().strftime('%Y_%m_%d__%H_%M')}.docx"
        output_path = SETTINGS.summary_dir / file_name
        output_path.write_bytes(buffer)
        mark_session_summarized(session_id, str(output_path))
        return output_path

    def get_health_state(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "activeSessions": len(self.active_sessions),
            "helperReady": self.helper.process is not None and self.helper.process.returncode is None,
            "recovery": self.recovery.get_status(),
        }

    async def shutdown(self) -> None:
        if self._shutting_down:
            return
        self._shutting_down = True
        for task in list(self._background_tasks):
            task.cancel()
        for active in list(self.active_sessions.values()):
            mark_session_pending_recovery(active.session_id)
            try:
                await self.helper.stop_session(active.session_id)
            except Exception:
                pass
            try:
                await active.protocol.disconnect(force=True)
            except Exception:
                pass
        await asyncio.gather(*list(self._background_tasks), return_exceptions=True)
        self.active_sessions.clear()
        await self.reminders.stop()
        await self.helper.shutdown()
        await self.health.stop()
        with contextlib.suppress(Exception):
            if not self.bot.is_closed():
                await self.bot.close()
        with contextlib.suppress(Exception):
            await close_transcription_client()
        with contextlib.suppress(Exception):
            await close_summary_client()
        save_manifest_sync()

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        stop_event = asyncio.Event()

        def _request_stop() -> None:
            stop_event.set()

        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, _request_stop)

        bot_task = asyncio.create_task(self.bot.start(SETTINGS.discord_token))
        stop_task = asyncio.create_task(stop_event.wait())
        bot_error: Exception | None = None
        try:
            done, pending = await asyncio.wait({bot_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if stop_task in done and not bot_task.done():
                await self.bot.close()
            result = await asyncio.gather(bot_task, return_exceptions=True)
            if result and isinstance(result[0], Exception):
                bot_error = result[0]
        finally:
            await self.shutdown()
        if bot_error is not None and not isinstance(bot_error, asyncio.CancelledError):
            raise bot_error


async def run_bot() -> None:
    runtime = SummariseBotRuntime()
    await runtime.run()
