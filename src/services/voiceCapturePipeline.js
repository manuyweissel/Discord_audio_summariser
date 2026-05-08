import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import { addAudioEntry, findAudioEntryByCaptureEventId } from './manifest.js';
import { transcribeWithRetry } from './transcription.js';
import {
  listVoiceCaptureSpoolFiles,
  readVoiceCaptureSpoolRecord,
  deleteVoiceCaptureSpoolRecord,
  logMalformedVoiceCaptureSpoolRecord
} from './voiceCaptureSpool.js';

export const pendingTranscriptions = new Map();

let discordClient = null;
let transcriptWriter = null;
const ingestInFlight = new Set();

function ensureConfigured() {
  if (!discordClient || !transcriptWriter) {
    throw new Error('Voice capture pipeline is not configured');
  }
}

function getPendingSet(sessionId) {
  if (!pendingTranscriptions.has(sessionId)) {
    pendingTranscriptions.set(sessionId, new Set());
  }

  return pendingTranscriptions.get(sessionId);
}

async function resolveUsername(guildId, userId) {
  const guild = discordClient.guilds.cache.get(guildId)
    ?? await discordClient.guilds.fetch(guildId).catch(() => null);

  if (!guild) {
    return `User-${userId.slice(-4)}`;
  }

  const member = guild.members.cache.get(userId)
    ?? await guild.members.fetch(userId).catch(() => null);

  return member?.displayName || member?.user?.username || `User-${userId.slice(-4)}`;
}

async function writeTranscriptLine(sessionRecord, username, text) {
  if (!text?.trim()) {
    return;
  }

  await transcriptWriter(
    sessionRecord.guildId,
    sessionRecord.channelId,
    username,
    text.trim(),
    sessionRecord.sessionId
  );
}

export function configureVoiceCapturePipeline({ client, writeTranscript }) {
  discordClient = client;
  transcriptWriter = writeTranscript;
}

export function getPendingVoiceProcessingCount(sessionId) {
  return pendingTranscriptions.get(sessionId)?.size || 0;
}

export async function waitForPendingVoiceProcessing(sessionId, maxWaitTime = 30000) {
  const startTime = Date.now();
  const checkInterval = 2000;
  let lastLogTime = 0;
  const logInterval = 5000;

  while (Date.now() - startTime < maxWaitTime) {
    const pending = getPendingVoiceProcessingCount(sessionId);
    if (pending === 0) {
      return true;
    }

    const now = Date.now();
    if (now - lastLogTime >= logInterval) {
      console.log(`⏳ Waiting for ${pending} voice processing task(s) in session ${sessionId}...`);
      lastLogTime = now;
    }

    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }

  return getPendingVoiceProcessingCount(sessionId) === 0;
}

export async function ingestVoiceCaptureRecord(record, { spoolPath = null } = {}) {
  ensureConfigured();

  const {
    eventId,
    sessionId,
    guildId,
    channelId,
    userId,
    wavPath,
    fileSize,
    startedAt,
    endedAt
  } = record || {};

  if (!eventId || !sessionId || !guildId || !channelId || !userId || !wavPath) {
    throw new Error('Invalid voice capture record payload');
  }

  if (ingestInFlight.has(eventId)) {
    return { skipped: true, reason: 'already_processing' };
  }

  if (findAudioEntryByCaptureEventId(eventId)) {
    if (spoolPath) {
      await deleteVoiceCaptureSpoolRecord(spoolPath);
    }
    return { skipped: true, reason: 'already_ingested' };
  }

  if (!fs.existsSync(wavPath)) {
    logger.warn("Voice capture record referenced a missing wav file", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: userId,
        event_id: eventId,
        action: "voice_capture_ingest",
        event: "missing_wav",
        wav_path: wavPath
      }
    });

    if (spoolPath) {
      await deleteVoiceCaptureSpoolRecord(spoolPath);
    }
    return { skipped: true, reason: 'missing_wav' };
  }

  ingestInFlight.add(eventId);
  const trackingId = uuidv4();
  getPendingSet(sessionId).add(trackingId);

  try {
    const stats = fs.statSync(wavPath);
    const username = await resolveUsername(guildId, userId);
    const entry = addAudioEntry(
      sessionId,
      wavPath,
      userId,
      username,
      fileSize || stats.size,
      {
        captureSource: 'python_worker',
        captureEventId: eventId,
        createdAt: endedAt || startedAt,
        startedAt,
        endedAt,
        duration: startedAt && endedAt
          ? Math.max(0, (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000)
          : undefined
      }
    );

    const transcription = await transcribeWithRetry(
      wavPath,
      sessionId,
      userId,
      entry.id,
      3
    );

    if (transcription.success && transcription.text?.trim()) {
      await writeTranscriptLine({ guildId, channelId, sessionId }, username, transcription.text);
      console.log(`📝 ${username} (${userId}): ${transcription.text}`);
    } else if (!transcription.isQuotaError) {
      console.log(`⚠️ Transcription failed for ${username}: ${transcription.error || 'Empty response from Whisper'}`);
    } else {
      console.log('💰 Audio saved for later retry (quota exceeded)');
    }

    if (spoolPath) {
      await deleteVoiceCaptureSpoolRecord(spoolPath);
    }

    return { success: true, entryId: entry.id, transcription };
  } finally {
    ingestInFlight.delete(eventId);

    const pendingSet = pendingTranscriptions.get(sessionId);
    if (pendingSet) {
      pendingSet.delete(trackingId);
      if (pendingSet.size === 0) {
        pendingTranscriptions.delete(sessionId);
      }
    }
  }
}

export async function replayPendingVoiceCaptureSpool() {
  ensureConfigured();
  const spoolFiles = await listVoiceCaptureSpoolFiles();

  if (spoolFiles.length === 0) {
    return { replayed: 0, failed: 0 };
  }

  let replayed = 0;
  let failed = 0;

  for (const spoolFile of spoolFiles) {
    try {
      const record = await readVoiceCaptureSpoolRecord(spoolFile);
      await ingestVoiceCaptureRecord(record, { spoolPath: spoolFile });
      replayed++;
    } catch (error) {
      failed++;
      await logMalformedVoiceCaptureSpoolRecord(spoolFile, error);
    }
  }

  return { replayed, failed };
}
