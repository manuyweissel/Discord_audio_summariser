from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


load_dotenv()


ROOT_DIR = Path(__file__).resolve().parent.parent
DISCORD_LOG_FILE = ROOT_DIR / "discord-bot.log"
MEETING_BLUEPRINT_PATH = ROOT_DIR / "meeting_minutes_blueprint.md"
MANIFEST_PATH = ROOT_DIR / "data" / "audio_manifest.json"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(slots=True)
class Settings:
    discord_token: str
    openai_api_key: str
    timezone: str
    audio_dir: Path
    transcript_dir: Path
    summary_dir: Path
    data_dir: Path
    spool_dir: Path
    manifest_path: Path
    helper_path: str
    helper_startup_timeout_ms: int
    voice_segment_silence_ms: int
    voice_max_segment_ms: int
    health_port: int
    grafana_webhook_secret: str | None
    recovery_interval_ms: int
    stale_session_hours: int
    circuit_breaker_threshold: int
    circuit_breaker_timeout_ms: int
    weekly_meeting_channel_id: str | None
    incidents_channel_id: str | None

    @classmethod
    def load(cls) -> "Settings":
        audio_dir = Path(os.environ.get("VOICE_CAPTURE_AUDIO_DIR", ROOT_DIR / "audios"))
        transcript_dir = Path(os.environ.get("TRANSCRIPT_DIR", ROOT_DIR / "transcripts"))
        summary_dir = Path(os.environ.get("SUMMARY_DIR", ROOT_DIR / "summaries"))
        data_dir = Path(os.environ.get("DATA_DIR", ROOT_DIR / "data"))
        spool_dir = Path(os.environ.get("VOICE_CAPTURE_SPOOL_DIR", data_dir / "voice_capture_spool"))

        for directory in (audio_dir, transcript_dir, summary_dir, data_dir, spool_dir):
            directory.mkdir(parents=True, exist_ok=True)

        helper_path = os.environ.get("VOICE_HELPER_PATH", "").strip()
        if not helper_path:
            helper_path = os.environ.get("VOICE_WORKER_PYTHON", "").strip()

        return cls(
            discord_token=os.environ.get("DISCORD_TOKEN", "").strip(),
            openai_api_key=os.environ.get("OPENAI_API_KEY", "").strip(),
            timezone=os.environ.get("TIMEZONE", "Europe/Berlin"),
            audio_dir=audio_dir,
            transcript_dir=transcript_dir,
            summary_dir=summary_dir,
            data_dir=data_dir,
            spool_dir=spool_dir,
            manifest_path=Path(os.environ.get("MANIFEST_PATH", MANIFEST_PATH)),
            helper_path=helper_path,
            helper_startup_timeout_ms=_env_int("VOICE_HELPER_STARTUP_TIMEOUT_MS", 30000),
            voice_segment_silence_ms=_env_int(
                "VOICE_SEGMENT_SILENCE_MS",
                _env_int("VOICE_WORKER_SEGMENT_SILENCE_MS", 2000),
            ),
            voice_max_segment_ms=_env_int(
                "VOICE_MAX_SEGMENT_MS",
                _env_int("VOICE_WORKER_MAX_SEGMENT_MS", 30000),
            ),
            health_port=_env_int("HEALTH_PORT", _env_int("GRAFANA_WEBHOOK_PORT", 3002)),
            grafana_webhook_secret=os.environ.get("GRAFANA_WEBHOOK_SECRET"),
            recovery_interval_ms=_env_int("RECOVERY_INTERVAL_MS", 30 * 60 * 1000),
            stale_session_hours=_env_int("STALE_SESSION_HOURS", 2),
            circuit_breaker_threshold=_env_int("CIRCUIT_BREAKER_THRESHOLD", 5),
            circuit_breaker_timeout_ms=_env_int("CIRCUIT_BREAKER_TIMEOUT", 60000),
            weekly_meeting_channel_id=(os.environ.get("WEEKLY_MEETING_CHANNEL_ID") or "").strip() or None,
            incidents_channel_id=(os.environ.get("INCIDENTS_CHANNEL_ID") or "").strip() or None,
        )

    def validate(self) -> None:
        missing = []
        if not self.discord_token:
            missing.append("DISCORD_TOKEN")
        if not self.openai_api_key:
            missing.append("OPENAI_API_KEY")
        if missing:
            joined = ", ".join(missing)
            raise RuntimeError(f"Missing required environment variable(s): {joined}")


SETTINGS = Settings.load()
