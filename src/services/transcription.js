import fs from 'node:fs';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import { calculateDurationMs } from '../utils/index.js';
import {
  markTranscribed,
  markFailed,
  markInProgress,
  markSkipped
} from './manifest.js';

const openai = new OpenAI();

// Error types that indicate we should not retry
const PERMANENT_ERRORS = [
  'invalid_api_key',
  'audio_format'
];

// Error types that indicate API quota/rate issues (recoverable later)
const QUOTA_ERRORS = [
  'insufficient_quota',
  'rate_limit_exceeded'
];

/**
 * Check if error is a quota/rate limit error
 */
function isQuotaError(err) {
  if (err.status === 429) return true;
  if (err.code === 'insufficient_quota') return true;
  if (QUOTA_ERRORS.some(e => err.message?.includes(e))) return true;
  return false;
}

/**
 * Check if error is permanent (no point retrying)
 */
function isPermanentError(err) {
  if (err.status === 401) return true;
  if (err.status === 400 && err.message?.includes('audio_format')) return true;
  if (PERMANENT_ERRORS.some(e => err.message?.includes(e))) return true;
  return false;
}

/**
 * Get human-readable error message
 */
function getErrorMessage(err) {
  if (err.status === 401) {
    return 'Invalid API key';
  } else if (err.status === 429) {
    return 'Rate limit exceeded or insufficient credits';
  } else if (err.code === 'insufficient_quota') {
    return 'Quota exceeded - please add credits';
  } else if (err.status === 400) {
    return 'Bad request - check audio format';
  } else if (err.status === 413) {
    return 'File too large (max 25MB)';
  } else if (err.message?.includes('Connection') || err.message?.includes('timeout')) {
    return 'Connection error';
  } else if (err.message?.includes('audio_format')) {
    return 'Unsupported audio format';
  }
  return err.message || 'Unknown error';
}

/**
 * Transcribe an audio file using OpenAI Whisper
 * @param {string} wavPath - Path to the WAV file
 * @param {string} sessionId - Session identifier for logging
 * @param {string} userId - User ID for logging
 * @param {string} entryId - Manifest entry ID (optional)
 * @returns {Promise<{text: string, success: boolean, error: string|null}>}
 */
export async function transcribeAudio(wavPath, sessionId, userId, entryId = null) {
  if (!wavPath) {
    return { text: '', success: false, error: 'No audio path provided' };
  }

  const transcribeEventId = uuidv4();
  const startTime = Date.now();

  // Mark as in progress in manifest
  if (entryId) {
    markInProgress(entryId);
  }

  try {
    // Check if file exists and has content
    if (!fs.existsSync(wavPath)) {
      const error = 'Audio file not found';
      console.error(`❌ ${error}: ${wavPath}`);
      if (entryId) {
        markFailed(entryId, error);
      }
      return { text: '', success: false, error };
    }

    const stats = fs.statSync(wavPath);
    if (stats.size < 1000) {
      const error = `File too small: ${stats.size} bytes`;
      console.log(`⚠️ Skipping transcription - ${error}`);
      if (entryId) {
        markSkipped(entryId, error);
      }
      return { text: '', success: false, error };
    }

    const resp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: 'whisper-1',
      language: undefined, // Auto-detect language (supports German, English, etc.)
    });

    const text = resp.text?.trim() || '';

    if (text) {
      logger.info("Transcription successful", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: userId,
          event_id: transcribeEventId,
          action: "audio_transcription",
          event: "complete",
          duration_ms: calculateDurationMs(startTime)
        }
      });

      // Update manifest with successful transcription
      if (entryId) {
        markTranscribed(entryId, text);
      }
      return { text, success: true, error: null };
    }

    // Whisper succeeded but returned empty text (couldn't understand audio)
    const emptyReason = 'No speech detected or audio unclear';
    console.log(`⚠️ Whisper returned empty text for ${wavPath.split('/').pop()}`);
    if (entryId) {
      markSkipped(entryId, emptyReason);
    }
    return { text: '', success: false, error: emptyReason };

  } catch (err) {
    const errorMessage = getErrorMessage(err);
    const isQuota = isQuotaError(err);
    const isPermanent = isPermanentError(err);

    logger.error("Audio transcription failed", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: userId,
        event_id: transcribeEventId,
        action: "audio_transcription",
        event: "error",
        duration_ms: calculateDurationMs(startTime),
        error_type: err.constructor.name,
        error_message: err.message,
        error_code: err.code,
        error_status: err.status,
        is_quota_error: isQuota,
        is_permanent: isPermanent
      }
    });

    console.error(`❌ Whisper failed: ${errorMessage}`);

    // Update manifest with failure
    if (entryId) {
      if (isPermanent) {
        markSkipped(entryId, `Permanent error: ${errorMessage}`);
      } else {
        markFailed(entryId, errorMessage);
      }
    }

    // Don't throw for quota errors - we want to save the audio and retry later
    if (isQuota) {
      console.log('💰 Audio saved for later retry when API credits are available');
      return { text: '', success: false, error: errorMessage, isQuotaError: true };
    }

    // For other errors, return failure but don't throw
    return { text: '', success: false, error: errorMessage };
  }
}

/**
 * Transcribe with retry logic (for recovery service)
 * @param {string} wavPath - Path to the WAV file
 * @param {string} sessionId - Session identifier
 * @param {string} userId - User ID
 * @param {string} entryId - Manifest entry ID
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<{text: string, success: boolean, error: string|null}>}
 */
export async function transcribeWithRetry(wavPath, sessionId, userId, entryId, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(15000, 1000 * Math.pow(2, attempt));
      console.log(`🔄 Retry ${attempt + 1}/${maxRetries} in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    const result = await transcribeAudio(wavPath, sessionId, userId, entryId);

    if (result.success) {
      return result;
    }

    lastError = result.error;

    // Don't retry quota errors or permanent errors
    if (result.isQuotaError) {
      console.log('💰 Stopping retries due to quota error - will retry on next startup');
      return result;
    }
  }

  return { text: '', success: false, error: lastError };
}

/**
 * Validate OpenAI API key at startup
 * @param {string} startupEventId - Event ID for logging
 * @returns {Promise<boolean>} Whether the key is valid
 */
export async function validateOpenAIKey(startupEventId) {
  const validationEventId = uuidv4();
  const startTime = Date.now();

  logger.debug("Validating OpenAI API key", {
    extra: {
      footprint: null,
      batch_uuid: startupEventId,
      user_id: null,
      event_id: validationEventId,
      action: "openai_validation",
      event: "start"
    }
  });

  try {
    await openai.models.list();

    logger.info("OpenAI API key validation successful", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: validationEventId,
        action: "openai_validation",
        event: "complete",
        duration_ms: calculateDurationMs(startTime)
      }
    });

    return true;
  } catch (error) {
    logger.error("OpenAI API key validation failed", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: validationEventId,
        action: "openai_validation",
        event: "error",
        duration_ms: calculateDurationMs(startTime),
        error_type: error.constructor.name,
        error_message: error.message,
        error_code: error.code,
        error_status: error.status
      }
    });

    if (error.status === 401) {
      logger.error("Invalid OpenAI API key - check your OPENAI_API_KEY environment variable");
    } else if (error.status === 429) {
      logger.error("OpenAI API rate limit exceeded or insufficient credits");
    } else if (error.code === 'insufficient_quota') {
      logger.error("OpenAI API quota exceeded - please add credits to your account");
    }

    return false;
  }
}
