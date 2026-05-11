from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

from .config import ROOT_DIR, SETTINGS
from .logger import logger


def _helper_command() -> list[str]:
    if SETTINGS.helper_path:
        helper_path = Path(SETTINGS.helper_path)
        if helper_path.suffix == ".py":
            return [str(helper_path)]
        return [str(helper_path), "-m", "voice_helper.main"]
    return [sys.executable, "-m", "voice_helper.main"]


@dataclass(slots=True)
class PendingRequest:
    future: asyncio.Future
    timeout_handle: asyncio.TimerHandle


class VoiceHelperClient:
    def __init__(
        self,
        on_segment_ready: Callable[[dict[str, object]], Awaitable[None]],
        on_session_error: Callable[[dict[str, object]], Awaitable[None]] | None = None,
    ) -> None:
        self.on_segment_ready = on_segment_ready
        self.on_session_error = on_session_error
        self.process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._ready = asyncio.Event()
        self._pending: dict[str, PendingRequest] = {}
        self._lock = asyncio.Lock()
        self._session_metrics: dict[str, dict[str, object]] = {}
        self._stderr_suppression: dict[str, dict[str, float | int]] = {}

    async def start(self) -> None:
        async with self._lock:
            if self.process and self.process.returncode is None:
                return
            command = _helper_command()
            env = os.environ.copy()
            env["PYTHONPATH"] = str(ROOT_DIR)
            self.process = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(ROOT_DIR),
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self._ready.clear()
            self._session_metrics.clear()
            self._reader_task = asyncio.create_task(self._read_stdout())
            self._stderr_task = asyncio.create_task(self._read_stderr())
        try:
            await self._wait_until_ready()
        except Exception:
            await self.shutdown()
            raise

    @property
    def is_ready(self) -> bool:
        return self.process is not None and self.process.returncode is None and self._ready.is_set()

    async def ensure_ready(self) -> None:
        if self.process is None or self.process.returncode is not None:
            await self.start()
        if not self._ready.is_set():
            await self._wait_until_ready()

    async def _wait_until_ready(self) -> None:
        if self.process is None:
            raise RuntimeError("Voice helper process is not running")

        ready_task = asyncio.create_task(self._ready.wait())
        process_exit_task = asyncio.create_task(self.process.wait())
        try:
            done, pending = await asyncio.wait(
                {ready_task, process_exit_task},
                timeout=SETTINGS.helper_startup_timeout_ms / 1000,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            if ready_task in done and self._ready.is_set():
                return
            if process_exit_task in done:
                raise RuntimeError(f"Voice helper exited during startup with code {self.process.returncode}")
            raise RuntimeError("Voice helper did not become ready in time")
        finally:
            ready_task.cancel()
            process_exit_task.cancel()

    async def _read_stdout(self) -> None:
        assert self.process and self.process.stdout
        while True:
            line = await self.process.stdout.readline()
            if not line:
                break
            message = json.loads(line.decode("utf-8"))
            msg_type = message.get("type")
            if msg_type == "ready":
                self._ready.set()
            elif msg_type in {"session_started", "session_stats", "session_stopped"}:
                self._merge_session_payload(message.get("payload") or {})
            elif msg_type == "response":
                request_id = str(message.get("requestId"))
                pending = self._pending.pop(request_id, None)
                if pending:
                    pending.timeout_handle.cancel()
                    if message.get("success"):
                        pending.future.set_result(message.get("payload") or {})
                    else:
                        pending.future.set_exception(RuntimeError((message.get("error") or {}).get("message", "helper request failed")))
            elif msg_type == "segment_ready":
                try:
                    await self.on_segment_ready(message["payload"])
                except Exception as error:
                    logger.error(
                        "Voice helper segment ingest failed",
                        extra={"action": "voice_helper", "event": "segment_ingest_error", "error_message": str(error)},
                    )
            elif msg_type == "session_error":
                self._merge_session_payload((message.get("payload") or {}).get("stats") or {})
                if self.on_session_error is not None:
                    try:
                        await self.on_session_error(message.get("payload") or {})
                    except Exception:
                        logger.exception("Voice helper session error callback failed")
                session_error_payload = dict(message.get("payload") or {})
                if "message" in session_error_payload and "error_message" not in session_error_payload:
                    session_error_payload["error_message"] = session_error_payload.pop("message")
                logger.error(
                    "Voice helper session error",
                    extra={"action": "voice_helper", "event": "session_error", **session_error_payload},
                )
        self._ready.clear()
        self._flush_rate_limited_stderr(force=True)
        for request_id, pending in list(self._pending.items()):
            pending.timeout_handle.cancel()
            pending.future.set_exception(RuntimeError("Voice helper exited"))
            self._pending.pop(request_id, None)

    async def _read_stderr(self) -> None:
        assert self.process and self.process.stderr
        while True:
            line = await self.process.stderr.readline()
            if not line:
                break
            decoded = line.decode("utf-8", "ignore").rstrip()
            if "decryption failed:" in decoded.lower():
                self._record_rate_limited_stderr(decoded)
                continue
            self._flush_rate_limited_stderr(force=True)
            logger.info(
                "Voice helper stderr",
                extra={"action": "voice_helper", "event": "stderr", "stderr_line": decoded},
            )
        self._flush_rate_limited_stderr(force=True)

    def _merge_session_payload(self, payload: dict[str, object]) -> None:
        session_id = str(payload.get("sessionId") or "")
        if not session_id:
            return
        merged = dict(self._session_metrics.get(session_id) or {})
        merged.update(payload)
        stats = payload.get("stats")
        if isinstance(stats, dict):
            merged.update(stats)
        if "running" not in merged:
            merged["running"] = True
        if payload.get("stopped") is True:
            merged["running"] = False
        self._session_metrics[session_id] = merged

    def _session_log_context(self) -> dict[str, object]:
        for session_id, metrics in self._session_metrics.items():
            if metrics.get("running", True):
                return {
                    "session_id": session_id,
                    "phase": metrics.get("phase"),
                    "packets_received": metrics.get("packetsReceived"),
                    "media_decrypt_drops": metrics.get("mediaDecryptDrops"),
                    "pending_packets": metrics.get("pendingPackets"),
                }
        return {}

    def _record_rate_limited_stderr(self, line: str) -> None:
        now = time.monotonic()
        entry = self._stderr_suppression.setdefault(
            line,
            {"count": 0, "first_seen": now, "last_emitted": 0.0},
        )
        entry["count"] = int(entry["count"]) + 1
        if now - float(entry["last_emitted"]) >= 5.0:
            self._flush_rate_limited_stderr(line=line)

    def _flush_rate_limited_stderr(self, *, line: str | None = None, force: bool = False) -> None:
        now = time.monotonic()
        keys = [line] if line is not None else list(self._stderr_suppression.keys())
        for key in keys:
            entry = self._stderr_suppression.get(key)
            if entry is None:
                continue
            if not force and (now - float(entry["last_emitted"])) < 5.0:
                continue
            count = int(entry["count"])
            if count <= 0:
                continue
            entry["last_emitted"] = now
            entry["count"] = 0
            logger.warning(
                "Voice helper stderr suppressed",
                extra={
                    "action": "voice_helper",
                    "event": "stderr_rate_limited",
                    "stderr_line": key,
                    "suppressed_count": count,
                    **self._session_log_context(),
                },
            )

    def get_session_metrics(self, session_id: str) -> dict[str, object]:
        return dict(self._session_metrics.get(session_id) or {})

    def get_state(self) -> dict[str, object]:
        running = {
            session_id: dict(metrics)
            for session_id, metrics in self._session_metrics.items()
            if metrics.get("running", True)
        }
        return {
            "ready": self.is_ready,
            "activeSessionCount": len(running),
            "sessions": running,
        }

    async def request(self, request_type: str, payload: dict[str, object], timeout: float = 30.0) -> dict[str, object]:
        await self.ensure_ready()
        assert self.process and self.process.stdin
        request_id = str(uuid4())
        loop = asyncio.get_running_loop()
        future = loop.create_future()

        def _on_timeout() -> None:
            pending = self._pending.pop(request_id, None)
            if pending and not pending.future.done():
                pending.future.set_exception(RuntimeError(f"Voice helper request timed out: {request_type}"))

        timeout_handle = loop.call_later(timeout, _on_timeout)
        self._pending[request_id] = PendingRequest(future=future, timeout_handle=timeout_handle)
        self.process.stdin.write(
            (json.dumps({"requestId": request_id, "type": request_type, "payload": payload}, ensure_ascii=True) + "\n").encode("utf-8")
        )
        await self.process.stdin.drain()
        return await future

    async def start_session(self, payload: dict[str, object]) -> dict[str, object]:
        return await self.request("start_session", payload, timeout=45.0)

    async def stop_session(self, session_id: str) -> dict[str, object]:
        return await self.request("stop_session", {"sessionId": session_id}, timeout=30.0)

    async def shutdown(self) -> None:
        if self.process is None:
            return
        try:
            if self.process.returncode is None and self.process.stdin is not None:
                with contextlib.suppress(Exception):
                    await self.request("shutdown", {}, timeout=10.0)
        finally:
            tasks = [task for task in (self._reader_task, self._stderr_task) if task is not None]
            if self.process.returncode is None:
                self.process.terminate()
                with contextlib.suppress(ProcessLookupError):
                    await self.process.wait()
            if self.process.stdin is not None:
                with contextlib.suppress(Exception):
                    self.process.stdin.close()
            if self._reader_task:
                self._reader_task.cancel()
            if self._stderr_task:
                self._stderr_task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self.process = None
            self._reader_task = None
            self._stderr_task = None
            self._ready.clear()
            self._flush_rate_limited_stderr(force=True)
            self._stderr_suppression.clear()
