from __future__ import annotations

import asyncio

from .bot import run_bot
from .config import SETTINGS


def main() -> None:
    SETTINGS.validate()
    asyncio.run(run_bot())


if __name__ == "__main__":
    main()
