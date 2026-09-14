"""Refuse to start a second bot process against the same data directory.

Two processes sharing one Discord token both try to hold the voice connection, and Discord
invalidates one of them with close code 4006 ("session no longer valid"). On 2026-09-11 that
cost the opening minutes of a standup: one instance was started detached while another was
already running, and the two fought over the voice websocket until one was killed.

The lock is advisory and released automatically when the process exits (including a crash or
SIGKILL), because the kernel drops flock with the file descriptor.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX
    fcntl = None  # type: ignore[assignment]


class AlreadyRunningError(RuntimeError):
    def __init__(self, pid: str, lock_path: Path) -> None:
        self.pid = pid
        self.lock_path = lock_path
        super().__init__(
            f"Another summarise_bot process is already running (pid {pid}).\n"
            f"Two instances share one Discord token and will fight over the voice connection "
            f"(close code 4006), so this one is stopping.\n"
            f"Stop the other with:  kill {pid}\n"
            f"Lock file: {lock_path}"
        )


class SingleInstanceLock:
    def __init__(self, lock_path: Path) -> None:
        self.lock_path = lock_path
        self._handle = None

    def acquire(self) -> "SingleInstanceLock":
        if fcntl is None:  # pragma: no cover - non-POSIX
            return self
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.lock_path.open("a+")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.seek(0)
            pid = (handle.read().strip() or "unknown")
            handle.close()
            raise AlreadyRunningError(pid, self.lock_path) from None
        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()))
        handle.flush()
        self._handle = handle
        return self

    def release(self) -> None:
        if self._handle is None:
            return
        try:
            if fcntl is not None:
                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            self._handle.close()
        except OSError:
            pass
        finally:
            self._handle = None

    def __enter__(self) -> "SingleInstanceLock":
        return self.acquire()

    def __exit__(self, *_exc_info: object) -> None:
        self.release()
