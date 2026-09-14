from __future__ import annotations

import asyncio
import sys

from .bot import run_bot
from .config import SETTINGS
from .single_instance import AlreadyRunningError, SingleInstanceLock


def main() -> None:
    SETTINGS.validate()
    lock = SingleInstanceLock(SETTINGS.data_dir / "summarise_bot.lock")
    try:
        lock.acquire()
    except AlreadyRunningError as error:
        print(f"\u274c {error}", file=sys.stderr)
        raise SystemExit(1)
    try:
        asyncio.run(run_bot())
    finally:
        lock.release()


if __name__ == "__main__":
    main()
