from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
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
            self._reader_task = asyncio.create_task(self._read_stdout())
            self._stderr_task = asyncio.create_task(self._read_stderr())
        await self._wait_until_ready()

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
            logger.info(
                "Voice helper stderr",
                extra={"action": "voice_helper", "event": "stderr", "stderr_line": line.decode('utf-8', 'ignore').rstrip()},
            )

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
