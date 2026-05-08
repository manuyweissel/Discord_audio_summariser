from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from .config import DISCORD_LOG_FILE


class JsonFileHandler(logging.FileHandler):
    def emit(self, record: logging.LogRecord) -> None:
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "message": record.getMessage(),
        }
        extra = _extract_extra(record)
        if extra:
            payload["extra"] = extra
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        self.stream.write(json.dumps(payload, ensure_ascii=True) + "\n")
        self.flush()


class ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.now().strftime("%H:%M:%S")
        extra = _extract_extra(record)
        suffix = ""
        if extra.get("action") and extra.get("event"):
            suffix = f" | {extra['action']}:{extra['event']}"
        if extra.get("stderr_line"):
            suffix += f" | {extra['stderr_line']}"
        return f"{ts} [{record.levelname}] {record.getMessage()}{suffix}"


def _extract_extra(record: logging.LogRecord) -> dict[str, object]:
    standard = {
        "name",
        "msg",
        "args",
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",
        "exc_text",
        "stack_info",
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "message",
        "asctime",
    }
    return {key: value for key, value in record.__dict__.items() if key not in standard}


def build_logger() -> logging.Logger:
    logger = logging.getLogger("summarise_bot")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    logger.propagate = False

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(ConsoleFormatter())
    logger.addHandler(console_handler)

    file_handler = JsonFileHandler(DISCORD_LOG_FILE, encoding="utf-8")
    logger.addHandler(file_handler)
    return logger


logger = build_logger()
