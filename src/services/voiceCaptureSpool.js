import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../logger.js';
import { VOICE_CAPTURE_SPOOL_DIR } from '../config.js';

const SPOOL_SUFFIX = '.json';

function sortByNameAsc(left, right) {
  return left.localeCompare(right);
}

export function getVoiceCaptureSpoolDir() {
  return VOICE_CAPTURE_SPOOL_DIR;
}

export async function listVoiceCaptureSpoolFiles() {
  await fs.mkdir(VOICE_CAPTURE_SPOOL_DIR, { recursive: true });
  const entries = await fs.readdir(VOICE_CAPTURE_SPOOL_DIR, { withFileTypes: true });

  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(SPOOL_SUFFIX))
    .map(entry => path.join(VOICE_CAPTURE_SPOOL_DIR, entry.name))
    .sort(sortByNameAsc);
}

export async function readVoiceCaptureSpoolRecord(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

export async function deleteVoiceCaptureSpoolRecord(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function logMalformedVoiceCaptureSpoolRecord(filePath, error) {
  logger.error("Failed to read voice capture spool record", {
    extra: {
      footprint: null,
      batch_uuid: null,
      user_id: null,
      event_id: null,
      action: "voice_capture_spool",
      event: "error",
      file_path: filePath,
      error_message: error?.message
    }
  });
}
