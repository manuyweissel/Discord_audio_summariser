import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

// ---------- Environment Variables ----------
export const BOT_TOKEN = process.env.DISCORD_TOKEN;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const WEEKLY_MEETING_CHANNEL_ID = process.env.WEEKLY_MEETING_CHANNEL_ID;
export const INCIDENTS_CHANNEL_ID = process.env.INCIDENTS_CHANNEL_ID;
export const TIMEZONE = process.env.TIMEZONE || 'Europe/Berlin';
export const GRAFANA_WEBHOOK_PORT = Number(process.env.GRAFANA_WEBHOOK_PORT || 3000);
export const GRAFANA_WEBHOOK_SECRET = process.env.GRAFANA_WEBHOOK_SECRET;
export const VOICE_BACKEND = process.env.VOICE_BACKEND || 'python';
export const VOICE_WORKER_PYTHON = process.env.VOICE_WORKER_PYTHON || '';
export const VOICE_WORKER_STARTUP_TIMEOUT_MS = Number(process.env.VOICE_WORKER_STARTUP_TIMEOUT_MS || 30000);
export const VOICE_WORKER_SEGMENT_SILENCE_MS = Number(process.env.VOICE_WORKER_SEGMENT_SILENCE_MS || 2000);
export const VOICE_WORKER_MAX_SEGMENT_MS = Number(process.env.VOICE_WORKER_MAX_SEGMENT_MS || 30000);

// Circuit breaker configuration
export const CIRCUIT_BREAKER_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_THRESHOLD || 5);
export const CIRCUIT_BREAKER_TIMEOUT = Number(process.env.CIRCUIT_BREAKER_TIMEOUT || 60000);

// ---------- Directory Setup ----------
export const AUDIO_DIR = path.join(process.cwd(), 'audios');
export const TRANSCRIPT_DIR = path.join(process.cwd(), 'transcripts');
export const SUMMARY_DIR = path.join(process.cwd(), 'summaries');
export const DATA_DIR = path.join(process.cwd(), 'data');
export const VOICE_CAPTURE_SPOOL_DIR = path.join(DATA_DIR, 'voice_capture_spool');

// Ensure directories exist
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
fs.mkdirSync(SUMMARY_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(VOICE_CAPTURE_SPOOL_DIR, { recursive: true });

// ---------- Validation ----------
export function validateConfig(logger, startupEventId) {
  if (!BOT_TOKEN) {
    logger.error("Missing DISCORD_TOKEN environment variable", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: uuidv4(),
        action: "bot_startup",
        event: "error"
      }
    });
    return false;
  }

  if (!OPENAI_API_KEY) {
    logger.error("Missing OPENAI_API_KEY environment variable", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: uuidv4(),
        action: "bot_startup",
        event: "error"
      }
    });
    return false;
  }

  if (!WEEKLY_MEETING_CHANNEL_ID) {
    logger.warn("WEEKLY_MEETING_CHANNEL_ID not set - weekly reminders will be disabled", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: uuidv4(),
        action: "bot_startup",
        event: "warning"
      }
    });
  }

  if (!INCIDENTS_CHANNEL_ID) {
    logger.warn("INCIDENTS_CHANNEL_ID not set - Grafana alerts will be disabled", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: uuidv4(),
        action: "bot_startup",
        event: "warning"
      }
    });
  }

  return true;
}
