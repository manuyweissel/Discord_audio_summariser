from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import resource
import time
from typing import Any
from uuid import uuid4

from aiohttp import web
import discord

from .config import SETTINGS
from .logger import logger


_MARKDOWN_ESCAPE_RE = re.compile(r"([@#`*_~|\\])")


def sanitize(value: object, max_length: int = 500) -> str:
    if not isinstance(value, str):
        return ""
    escaped = _MARKDOWN_ESCAPE_RE.sub(r"\\\1", value)
    escaped = re.sub(r"\n{3,}", "\n\n", escaped).strip()
    if len(escaped) > max_length:
        return escaped[: max_length - 3] + "..."
    return escaped


def format_grafana_alert_message(payload: Mapping[str, object]) -> str:
    rule_name = sanitize(payload.get("ruleName") or payload.get("title") or "Unknown rule", 200)
    state = sanitize(payload.get("state") or payload.get("status") or "unknown", 50)
    alert_message = sanitize(payload.get("message") or "", 1000)
    rule_url = sanitize(payload.get("ruleUrl") or payload.get("dashboardUrl") or "", 500)

    text = f"⚠️ **Grafana alert**\n**Rule:** {rule_name}\n**State:** {state}\n"
    if alert_message:
        text += f"**Message:** {alert_message}\n"
    if rule_url:
        text += f"**Link:** {rule_url}\n"
    return text


def format_uptime(total_seconds: float) -> str:
    seconds = max(0, int(total_seconds))
    days, seconds = divmod(seconds, 24 * 60 * 60)
    hours, seconds = divmod(seconds, 60 * 60)
    minutes, seconds = divmod(seconds, 60)
    parts: list[str] = []
    if days:
        parts.append(f"{days}d")
    if days or hours:
        parts.append(f"{hours}h")
    if days or hours or minutes:
        parts.append(f"{minutes}m")
    parts.append(f"{seconds}s")
    return " ".join(parts)


def _format_mb(kibibytes: float) -> str:
    return f"{kibibytes / 1024:.1f} MB"


def read_memory_usage() -> dict[str, str]:
    status_path = Path("/proc/self/status")
    if status_path.exists():
        parsed: dict[str, str] = {}
        for line in status_path.read_text(encoding="utf-8").splitlines():
            if not line.startswith(("VmRSS:", "VmHWM:", "VmSize:")):
                continue
            key, value = line.split(":", 1)
            parts = value.strip().split()
            if not parts:
                continue
            kibibytes = float(parts[0])
            if key == "VmRSS":
                parsed["rss"] = _format_mb(kibibytes)
            elif key == "VmHWM":
                parsed["peakRss"] = _format_mb(kibibytes)
            elif key == "VmSize":
                parsed["virtual"] = _format_mb(kibibytes)
        if parsed:
            return parsed

    usage = resource.getrusage(resource.RUSAGE_SELF)
    return {"rss": _format_mb(float(usage.ru_maxrss))}


class OpsServer:
    def __init__(self, bot: discord.Bot, get_state) -> None:
        self.bot = bot
        self.get_state = get_state
        self.runner: web.AppRunner | None = None
        self.site: web.TCPSite | None = None
        self.started_at: datetime | None = None
        self.started_monotonic: float | None = None
        self.daily_threads: dict[str, int] = {}

    @property
    def daily_thread_count(self) -> int:
        return len(self.daily_threads)

    async def start(self) -> None:
        if self.runner is not None:
            return
        app = web.Application(client_max_size=1024**2)
        app.router.add_get("/health", self.handle_health)
        app.router.add_post("/grafana-alert", self.handle_grafana_alert)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "0.0.0.0", SETTINGS.health_port)
        await self.site.start()
        self.started_at = datetime.now(timezone.utc)
        self.started_monotonic = time.monotonic()
        print(f"📡 Grafana webhook listening on port {SETTINGS.health_port} (all interfaces)")
        logger.info(
            "Grafana webhook server started",
            extra={
                "action": "grafana_webhook_start",
                "event": "start",
                "port": SETTINGS.health_port,
                "bind_address": "0.0.0.0",
            },
        )

    async def stop(self) -> None:
        if self.runner is not None:
            await self.runner.cleanup()
            self.runner = None
            self.site = None

    async def handle_health(self, request: web.Request) -> web.Response:
        del request
        return web.json_response(self.build_health_state())

    async def handle_grafana_alert(self, request: web.Request) -> web.Response:
        unauthorized = self.validate_webhook_request(request.headers, request.remote)
        if unauthorized is not None:
            return unauthorized

        if not SETTINGS.incidents_channel_id:
            logger.warning(
                "Grafana alert received but incidents channel is disabled",
                extra={"action": "grafana_alert", "event": "disabled"},
            )
            return web.json_response({"error": "disabled"}, status=503)

        alert_event_id = str(uuid4())
        started = time.monotonic()
        try:
            payload = await request.json()
            date_key = datetime.now(timezone.utc).date().isoformat()
            thread = await self.get_or_create_daily_grafana_thread(date_key)
            text = format_grafana_alert_message(payload)
            await thread.send(text)
            logger.info(
                "Grafana alert forwarded to Discord",
                extra={
                    "action": "grafana_alert",
                    "event": "complete",
                    "event_id": alert_event_id,
                    "duration_ms": int((time.monotonic() - started) * 1000),
                },
            )
            return web.json_response({"ok": True})
        except Exception as error:
            logger.error(
                "Failed to handle Grafana alert",
                extra={
                    "action": "grafana_alert",
                    "event": "error",
                    "event_id": alert_event_id,
                    "duration_ms": int((time.monotonic() - started) * 1000),
                    "error_message": str(error),
                },
            )
            return web.json_response({"error": "failed"}, status=500)

    def validate_webhook_request(
        self,
        headers: Mapping[str, str],
        remote_address: str | None,
    ) -> web.Response | None:
        if not SETTINGS.grafana_webhook_secret:
            logger.warning(
                "Grafana webhook secret not configured - accepting unauthenticated requests",
                extra={"action": "grafana_auth", "event": "warning"},
            )
            return None

        provided_secret = headers.get("x-webhook-secret") or headers.get("x-grafana-secret")
        if provided_secret == SETTINGS.grafana_webhook_secret:
            return None

        logger.warning(
            "Grafana webhook authentication failed",
            extra={
                "action": "grafana_auth",
                "event": "rejected",
                "ip_address": remote_address or "unknown",
                "has_secret": bool(provided_secret),
            },
        )
        return web.json_response({"error": "unauthorized"}, status=401)

    async def get_or_create_daily_grafana_thread(self, date_key: str):
        if not SETTINGS.incidents_channel_id:
            raise RuntimeError("INCIDENTS_CHANNEL_ID not set")

        cached_id = self.daily_threads.get(date_key)
        if cached_id:
            existing = self.bot.get_channel(cached_id)
            if existing is None:
                existing = await self.bot.fetch_channel(cached_id)
            if existing is not None and hasattr(existing, "send") and hasattr(existing, "id"):
                return existing
            self.daily_threads.pop(date_key, None)

        incidents_channel_id = int(SETTINGS.incidents_channel_id)
        incidents_channel = self.bot.get_channel(incidents_channel_id)
        if incidents_channel is None:
            incidents_channel = await self.bot.fetch_channel(incidents_channel_id)
        if incidents_channel is None or not hasattr(incidents_channel, "create_thread"):
            raise RuntimeError("Incidents channel not found or does not support threads")

        thread = await incidents_channel.create_thread(
            name=f"Grafana alerts – {date_key}",
            auto_archive_duration=1440,
            type=discord.ChannelType.public_thread,
        )
        self.daily_threads[date_key] = thread.id
        return thread

    def build_health_state(self) -> dict[str, Any]:
        base_state = dict(self.get_state())
        started_at = self.started_at.isoformat() if self.started_at is not None else None
        uptime_seconds = 0.0
        if self.started_monotonic is not None:
            uptime_seconds = max(0.0, time.monotonic() - self.started_monotonic)

        base_state.update(
            {
                "status": base_state.get("status", "ok"),
                "uptime": uptime_seconds,
                "uptimeFormatted": format_uptime(uptime_seconds),
                "serverStartTime": started_at,
                "memory": read_memory_usage(),
                "grafana": {
                    "enabled": bool(SETTINGS.incidents_channel_id),
                    "dailyThreadsTracked": self.daily_thread_count,
                },
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )
        return base_state


HealthServer = OpsServer
