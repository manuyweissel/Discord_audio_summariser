import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';

// Manifest file location
const MANIFEST_DIR = path.join(process.cwd(), 'data');
const MANIFEST_FILE = path.join(MANIFEST_DIR, 'audio_manifest.json');

// Ensure data directory exists
fs.mkdirSync(MANIFEST_DIR, { recursive: true });

// Debounce settings for async manifest writes
const SAVE_DEBOUNCE_MS = 500; // Wait 500ms before writing
let saveDebounceTimer = null;
let saveInProgress = false;
let pendingSave = false;

// Transcription status enum
export const TranscriptionStatus = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped' // For files too small to transcribe
};

/**
 * Audio entry structure:
 * {
 *   id: string,
 *   sessionId: string,
 *   guildId: string,
 *   channelId: string,
 *   userId: string,
 *   username: string,
 *   audioPath: string,
 *   status: TranscriptionStatus,
 *   transcribedText: string | null,
 *   errorMessage: string | null,
 *   retryCount: number,
 *   createdAt: string (ISO),
 *   updatedAt: string (ISO),
 *   fileSize: number,
 *   duration: number | null (estimated seconds)
 * }
 */

/**
 * Session structure:
 * {
 *   sessionId: string,
 *   guildId: string,
 *   channelId: string,
 *   startedAt: string (ISO),
 *   endedAt: string | null (ISO),
 *   status: 'active' | 'completed' | 'pending_recovery',
 *   audioEntries: string[] (entry IDs),
 *   transcriptPath: string | null,
 *   summaryPath: string | null,
 *   summarized: boolean
 * }
 */

// In-memory cache of the manifest
let manifestCache = null;

/**
 * Load manifest from disk
 */
function loadManifest() {
  try {
    if (fs.existsSync(MANIFEST_FILE)) {
      const data = fs.readFileSync(MANIFEST_FILE, 'utf-8');
      manifestCache = JSON.parse(data);
    } else {
      manifestCache = {
        version: '1.0',
        sessions: {},
        audioEntries: {},
        lastUpdated: new Date().toISOString()
      };
      saveManifest();
    }
  } catch (error) {
    logger.error("Failed to load manifest", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "manifest_load",
        event: "error",
        error_message: error.message
      }
    });
    // Initialize empty manifest on error
    manifestCache = {
      version: '1.0',
      sessions: {},
      audioEntries: {},
      lastUpdated: new Date().toISOString()
    };
  }
  return manifestCache;
}

/**
 * Actually perform the async write to disk
 * @private
 */
async function doSaveManifest() {
  if (!manifestCache) return;
  
  saveInProgress = true;
  
  try {
    manifestCache.lastUpdated = new Date().toISOString();
    const data = JSON.stringify(manifestCache, null, 2);
    
    // Write to temp file first, then rename (atomic operation)
    const tempFile = `${MANIFEST_FILE}.tmp`;
    await fsPromises.writeFile(tempFile, data, 'utf-8');
    await fsPromises.rename(tempFile, MANIFEST_FILE);
    
  } catch (error) {
    logger.error("Failed to save manifest", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "manifest_save",
        event: "error",
        error_message: error.message
      }
    });
  } finally {
    saveInProgress = false;
    
    // If another save was requested while we were writing, do it now
    if (pendingSave) {
      pendingSave = false;
      saveManifest();
    }
  }
}

/**
 * Save manifest to disk with debouncing
 * Prevents excessive writes during high activity
 * Uses async writes to avoid blocking the event loop
 */
function saveManifest() {
  // If save is in progress, mark as pending
  if (saveInProgress) {
    pendingSave = true;
    return;
  }
  
  // Clear any existing debounce timer
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }
  
  // Debounce: wait before actually writing
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    doSaveManifest().catch(err => {
      console.error('⚠️ Manifest save error:', err.message);
    });
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Force an immediate synchronous save (for shutdown)
 * Only use during graceful shutdown
 */
export function saveManifestSync() {
  try {
    if (!manifestCache) return;
    manifestCache.lastUpdated = new Date().toISOString();
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifestCache, null, 2));
  } catch (error) {
    console.error('Failed to save manifest:', error.message);
  }
}

/**
 * Get the manifest (loads if not cached)
 */
export function getManifest() {
  if (!manifestCache) {
    loadManifest();
  }
  return manifestCache;
}

/**
 * Create or get a session
 */
export function getOrCreateSession(sessionId, guildId, channelId) {
  const manifest = getManifest();

  if (!manifest.sessions[sessionId]) {
    manifest.sessions[sessionId] = {
      sessionId,
      guildId,
      channelId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'active',
      audioEntries: [],
      transcriptPath: null,
      summaryPath: null,
      summarized: false
    };
    saveManifest();

    logger.info("Created new session in manifest", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action: "manifest_session",
        event: "created"
      }
    });
  }

  return manifest.sessions[sessionId];
}

/**
 * Add an audio entry to the manifest
 */
export function addAudioEntry(sessionId, audioPath, userId, username, fileSize, options = {}) {
  const manifest = getManifest();
  const entryId = uuidv4();
  const [guildId, channelId] = sessionId.split(':');

  // Ensure session exists
  getOrCreateSession(sessionId, guildId, channelId);

  // Estimate duration based on file size (24kHz mono 16-bit = 48000 bytes/sec)
  const estimatedDuration = fileSize / 48000;

  const createdAt = options.createdAt || new Date().toISOString();
  const entry = {
    id: entryId,
    sessionId,
    guildId,
    channelId,
    userId,
    username,
    audioPath,
    status: TranscriptionStatus.PENDING,
    transcribedText: null,
    errorMessage: null,
    retryCount: 0,
    createdAt,
    updatedAt: createdAt,
    fileSize,
    duration: options.duration ?? estimatedDuration,
    captureSource: options.captureSource || null,
    captureEventId: options.captureEventId || null,
    startedAt: options.startedAt || null,
    endedAt: options.endedAt || null
  };

  manifest.audioEntries[entryId] = entry;
  manifest.sessions[sessionId].audioEntries.push(entryId);
  saveManifest();

  console.log(`📋 Added audio entry ${entryId.substr(0, 8)}... to manifest (${(fileSize / 1024).toFixed(1)} KB)`);

  return entry;
}

/**
 * Find a manifest audio entry by capture event ID
 * @param {string} captureEventId - Worker-generated capture event ID
 * @returns {Object|null}
 */
export function findAudioEntryByCaptureEventId(captureEventId) {
  if (!captureEventId) {
    return null;
  }

  const manifest = getManifest();
  return Object.values(manifest.audioEntries).find(entry => entry.captureEventId === captureEventId) || null;
}

/**
 * Update audio entry status
 */
export function updateAudioEntry(entryId, updates) {
  const manifest = getManifest();

  if (!manifest.audioEntries[entryId]) {
    console.error(`❌ Audio entry ${entryId} not found in manifest`);
    return null;
  }

  manifest.audioEntries[entryId] = {
    ...manifest.audioEntries[entryId],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  saveManifest();
  return manifest.audioEntries[entryId];
}

/**
 * Mark audio entry as transcribed
 */
export function markTranscribed(entryId, text) {
  return updateAudioEntry(entryId, {
    status: TranscriptionStatus.COMPLETED,
    transcribedText: text,
    errorMessage: null
  });
}

/**
 * Mark audio entry as failed
 */
export function markFailed(entryId, errorMessage) {
  const manifest = getManifest();
  const entry = manifest.audioEntries[entryId];

  if (!entry) return null;

  return updateAudioEntry(entryId, {
    status: TranscriptionStatus.FAILED,
    errorMessage,
    retryCount: (entry.retryCount || 0) + 1
  });
}

/**
 * Mark audio entry as skipped (too small)
 */
export function markSkipped(entryId, reason) {
  return updateAudioEntry(entryId, {
    status: TranscriptionStatus.SKIPPED,
    errorMessage: reason
  });
}

/**
 * Mark audio entry as in progress
 */
export function markInProgress(entryId) {
  return updateAudioEntry(entryId, {
    status: TranscriptionStatus.IN_PROGRESS
  });
}

/**
 * End a session
 */
export function endSession(sessionId, transcriptPath = null) {
  const manifest = getManifest();

  if (!manifest.sessions[sessionId]) {
    console.error(`❌ Session ${sessionId} not found in manifest`);
    return null;
  }

  manifest.sessions[sessionId].endedAt = new Date().toISOString();
  manifest.sessions[sessionId].status = 'completed';
  manifest.sessions[sessionId].transcriptPath = transcriptPath;

  saveManifest();

  console.log(`📋 Session ${sessionId} ended in manifest`);
  return manifest.sessions[sessionId];
}

/**
 * Mark session as summarized
 */
export function markSessionSummarized(sessionId, summaryPath) {
  const manifest = getManifest();

  if (!manifest.sessions[sessionId]) return null;

  manifest.sessions[sessionId].summaryPath = summaryPath;
  manifest.sessions[sessionId].summarized = true;

  saveManifest();
  return manifest.sessions[sessionId];
}

/**
 * Get all pending/failed audio entries for a session
 */
export function getUntranscribedEntries(sessionId = null) {
  const manifest = getManifest();
  const entries = [];

  for (const [entryId, entry] of Object.entries(manifest.audioEntries)) {
    if (sessionId && entry.sessionId !== sessionId) continue;

    if (entry.status === TranscriptionStatus.PENDING ||
        entry.status === TranscriptionStatus.FAILED ||
        entry.status === TranscriptionStatus.IN_PROGRESS) {
      // Check if file still exists
      if (fs.existsSync(entry.audioPath)) {
        entries.push(entry);
      } else {
        // Mark as skipped if file is missing
        updateAudioEntry(entryId, {
          status: TranscriptionStatus.SKIPPED,
          errorMessage: 'Audio file not found'
        });
      }
    }
  }

  // Sort by creation time
  entries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return entries;
}

/**
 * Get all transcribed entries for a session
 */
export function getTranscribedEntries(sessionId) {
  const manifest = getManifest();
  const entries = [];

  for (const [entryId, entry] of Object.entries(manifest.audioEntries)) {
    if (entry.sessionId !== sessionId) continue;

    if (entry.status === TranscriptionStatus.COMPLETED && entry.transcribedText) {
      entries.push(entry);
    }
  }

  // Sort by creation time
  entries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return entries;
}

/**
 * Check if a session is fully transcribed
 */
export function isSessionFullyTranscribed(sessionId) {
  const manifest = getManifest();
  const session = manifest.sessions[sessionId];

  if (!session) return false;

  for (const entryId of session.audioEntries) {
    const entry = manifest.audioEntries[entryId];
    if (!entry) continue;

    // If any entry is pending, failed, or in progress, session is not complete
    if (entry.status === TranscriptionStatus.PENDING ||
        entry.status === TranscriptionStatus.FAILED ||
        entry.status === TranscriptionStatus.IN_PROGRESS) {
      return false;
    }
  }

  return true;
}

/**
 * Mark stale active sessions as pending recovery
 * (sessions that have been active for more than the specified hours)
 * @param {number} hoursThreshold - Hours after which an active session is considered stale
 */
export function markStaleSessions(hoursThreshold = 2) {
  const manifest = getManifest();
  const cutoffTime = Date.now() - (hoursThreshold * 60 * 60 * 1000);
  let markedCount = 0;

  for (const [sessionId, session] of Object.entries(manifest.sessions)) {
    if (session.status !== 'active') continue;

    // Check if session has been active too long
    const startedAt = new Date(session.startedAt).getTime();
    if (startedAt < cutoffTime) {
      // Check last audio entry time
      let lastActivityTime = startedAt;
      for (const entryId of session.audioEntries) {
        const entry = manifest.audioEntries[entryId];
        if (entry) {
          const entryTime = new Date(entry.createdAt).getTime();
          if (entryTime > lastActivityTime) {
            lastActivityTime = entryTime;
          }
        }
      }

      // If last activity is also stale, mark for recovery
      if (lastActivityTime < cutoffTime) {
        session.status = 'pending_recovery';
        session.endedAt = new Date(lastActivityTime).toISOString();
        markedCount++;
        console.log(`📋 Marked stale session ${sessionId} for recovery (last activity: ${new Date(lastActivityTime).toISOString()})`);
      }
    }
  }

  if (markedCount > 0) {
    saveManifest();
    console.log(`📋 Marked ${markedCount} stale session(s) for recovery`);
  }

  return markedCount;
}

/**
 * Get sessions that need recovery (have untranscribed audio)
 */
export function getSessionsNeedingRecovery() {
  const manifest = getManifest();
  const sessions = [];

  for (const [sessionId, session] of Object.entries(manifest.sessions)) {
    // Skip active sessions (bot is currently recording)
    // Note: Stale active sessions should be marked as 'pending_recovery' first
    if (session.status === 'active') continue;

    // Skip already summarized sessions
    if (session.summarized) continue;

    // Check if session has untranscribed entries
    const untranscribed = getUntranscribedEntries(sessionId);
    if (untranscribed.length > 0) {
      sessions.push({
        ...session,
        untranscribedCount: untranscribed.length
      });
    } else if (!session.summarized && session.status === 'completed') {
      // Session is complete but not summarized
      sessions.push({
        ...session,
        untranscribedCount: 0,
        needsSummarization: true
      });
    }
  }

  return sessions;
}

/**
 * Get session statistics
 */
export function getSessionStats(sessionId) {
  const manifest = getManifest();
  const session = manifest.sessions[sessionId];

  if (!session) return null;

  let pending = 0, inProgress = 0, completed = 0, failed = 0, skipped = 0;
  let totalDuration = 0;

  for (const entryId of session.audioEntries) {
    const entry = manifest.audioEntries[entryId];
    if (!entry) continue;

    switch (entry.status) {
      case TranscriptionStatus.PENDING: pending++; break;
      case TranscriptionStatus.IN_PROGRESS: inProgress++; break;
      case TranscriptionStatus.COMPLETED: completed++; break;
      case TranscriptionStatus.FAILED: failed++; break;
      case TranscriptionStatus.SKIPPED: skipped++; break;
    }

    if (entry.duration) totalDuration += entry.duration;
  }

  return {
    total: session.audioEntries.length,
    pending,
    inProgress,
    completed,
    failed,
    skipped,
    totalDuration,
    isComplete: pending === 0 && inProgress === 0 && failed === 0
  };
}

/**
 * Clean up old completed sessions (older than 7 days)
 */
export function cleanupOldSessions(daysOld = 7) {
  const manifest = getManifest();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  let cleanedSessions = 0;
  let cleanedEntries = 0;

  for (const [sessionId, session] of Object.entries(manifest.sessions)) {
    if (!session.summarized) continue;
    if (!session.endedAt) continue;

    const endedAt = new Date(session.endedAt);
    if (endedAt > cutoffDate) continue;

    // Remove audio entries
    for (const entryId of session.audioEntries) {
      const entry = manifest.audioEntries[entryId];
      if (entry && fs.existsSync(entry.audioPath)) {
        try {
          fs.unlinkSync(entry.audioPath);
        } catch (e) {
          console.error(`Failed to delete audio file: ${entry.audioPath}`);
        }
      }
      delete manifest.audioEntries[entryId];
      cleanedEntries++;
    }

    delete manifest.sessions[sessionId];
    cleanedSessions++;
  }

  if (cleanedSessions > 0 || cleanedEntries > 0) {
    saveManifest();
    console.log(`🧹 Cleaned up ${cleanedSessions} old sessions and ${cleanedEntries} audio entries`);
  }

  return { cleanedSessions, cleanedEntries };
}

/**
 * Build transcript from manifest entries
 */
export function buildTranscriptFromManifest(sessionId) {
  const entries = getTranscribedEntries(sessionId);

  if (entries.length === 0) return null;

  const lines = entries.map(entry => {
    const timestamp = new Date(entry.createdAt).toISOString();
    return `[${timestamp}] ${entry.username}: ${entry.transcribedText}`;
  });

  return lines.join('\n');
}

// Initialize manifest on module load
loadManifest();
console.log('📋 Audio manifest service initialized');

// Log recovery status
const sessionsNeedingRecovery = getSessionsNeedingRecovery();
if (sessionsNeedingRecovery.length > 0) {
  console.log(`📋 Found ${sessionsNeedingRecovery.length} session(s) needing recovery`);
}
