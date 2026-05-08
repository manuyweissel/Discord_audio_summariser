import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import {
  AUDIO_DIR,
  VOICE_BACKEND,
  VOICE_CAPTURE_SPOOL_DIR,
  VOICE_WORKER_MAX_SEGMENT_MS,
  VOICE_WORKER_PYTHON,
  VOICE_WORKER_SEGMENT_SILENCE_MS,
  VOICE_WORKER_STARTUP_TIMEOUT_MS
} from '../config.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

let workerProcess = null;
let workerReady = false;
let startupPromise = null;
let shutdownPromise = null;
let lineReader = null;
let startupTimer = null;
let nextRequestId = 1;
let segmentReadyHandler = null;
const pendingRequests = new Map();

function getWorkerPythonCommand() {
  if (VOICE_WORKER_PYTHON) {
    return VOICE_WORKER_PYTHON;
  }

  const dedicatedVenvPython = path.join(process.cwd(), '.voice-worker-venv', 'bin', 'python');
  return dedicatedVenvPython;
}

function clearStartupTimer() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

function rejectPendingRequests(error) {
  for (const { reject, timer } of pendingRequests.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pendingRequests.clear();
}

function cleanupWorkerState() {
  workerProcess = null;
  workerReady = false;
  startupPromise = null;
  shutdownPromise = null;
  clearStartupTimer();
  if (lineReader) {
    lineReader.close();
    lineReader = null;
  }
}

async function handleWorkerMessage(message) {
  if (!message?.type) {
    return;
  }

  if (message.type === 'ready') {
    workerReady = true;
    clearStartupTimer();
    return;
  }

  if (message.type === 'response') {
    const pending = pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    pendingRequests.delete(message.requestId);
    clearTimeout(pending.timer);

    if (message.success) {
      pending.resolve(message.payload);
    } else {
      const error = new Error(message.error?.message || 'Voice worker request failed');
      error.code = message.error?.code || 'VOICE_WORKER_REQUEST_FAILED';
      pending.reject(error);
    }
    return;
  }

  if (message.type === 'segment_ready' && segmentReadyHandler) {
    Promise.resolve(segmentReadyHandler(message.payload)).catch(error => {
      logger.error("Failed to process worker segment event", {
        extra: {
          footprint: null,
          batch_uuid: message.payload?.sessionId,
          user_id: message.payload?.userId,
          event_id: message.payload?.eventId || uuidv4(),
          action: "voice_worker",
          event: "segment_processing_error",
          error_message: error?.message
        }
      });
    });
    return;
  }

  if (message.type === 'error') {
    logger.error("Voice worker reported an error", {
      extra: {
        footprint: null,
        batch_uuid: message.payload?.sessionId || null,
        user_id: null,
        event_id: uuidv4(),
        action: "voice_worker",
        event: "error",
        error_code: message.payload?.code,
        error_message: message.payload?.message
      }
    });
  }
}

function createWorkerEnvironment() {
  return {
    ...process.env,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    VOICE_CAPTURE_AUDIO_DIR: AUDIO_DIR,
    VOICE_CAPTURE_SPOOL_DIR,
    VOICE_WORKER_SEGMENT_SILENCE_MS: String(VOICE_WORKER_SEGMENT_SILENCE_MS),
    VOICE_WORKER_MAX_SEGMENT_MS: String(VOICE_WORKER_MAX_SEGMENT_MS),
  };
}

function createWorkerError(message, code = 'VOICE_WORKER_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function startVoiceWorker({ onSegmentReady } = {}) {
  if (VOICE_BACKEND !== 'python') {
    return false;
  }

  if (workerReady && workerProcess) {
    return true;
  }

  if (startupPromise) {
    return startupPromise;
  }

  segmentReadyHandler = onSegmentReady || null;

  startupPromise = new Promise((resolve, reject) => {
    const pythonCommand = getWorkerPythonCommand();

    workerProcess = spawn(pythonCommand, ['-m', 'voice_worker.main'], {
      cwd: process.cwd(),
      env: createWorkerEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe']
    });

    workerProcess.stderr.on('data', chunk => {
      process.stderr.write(chunk);
    });

    workerProcess.on('error', error => {
      const wrapped = createWorkerError(`Failed to start voice worker: ${error.message}`, 'VOICE_WORKER_START_FAILED');
      rejectPendingRequests(wrapped);
      cleanupWorkerState();
      reject(wrapped);
    });

    workerProcess.on('exit', (code, signal) => {
      const message = `Voice worker exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}`;
      const error = createWorkerError(message, 'VOICE_WORKER_EXITED');
      rejectPendingRequests(error);

      if (!workerReady && startupPromise) {
        reject(error);
      }

      cleanupWorkerState();
    });

    lineReader = readline.createInterface({ input: workerProcess.stdout });
    lineReader.on('line', line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        logger.warn("Ignoring non-JSON line from voice worker", {
          extra: {
            footprint: null,
            batch_uuid: null,
            user_id: null,
            event_id: uuidv4(),
            action: "voice_worker",
            event: "invalid_stdout",
            line
          }
        });
        return;
      }

      handleWorkerMessage(message).catch(err => {
        logger.error("Failed to handle voice worker message", {
          extra: {
            footprint: null,
            batch_uuid: null,
            user_id: null,
            event_id: uuidv4(),
            action: "voice_worker",
            event: "message_error",
            error_message: err?.message
          }
        });
      });

      if (message.type === 'ready' && workerProcess) {
        resolve(true);
      }
    });

    startupTimer = setTimeout(() => {
      const error = createWorkerError(
        `Voice worker did not become ready within ${VOICE_WORKER_STARTUP_TIMEOUT_MS}ms`,
        'VOICE_WORKER_START_TIMEOUT'
      );
      rejectPendingRequests(error);
      workerProcess?.kill('SIGTERM');
      cleanupWorkerState();
      reject(error);
    }, VOICE_WORKER_STARTUP_TIMEOUT_MS);
  }).finally(() => {
    startupPromise = null;
  });

  return startupPromise;
}

function sendWorkerRequest(type, payload = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  if (!workerProcess || !workerReady) {
    return Promise.reject(createWorkerError('Voice worker is not ready', 'VOICE_WORKER_NOT_READY'));
  }

  const requestId = String(nextRequestId++);
  const message = JSON.stringify({
    requestId,
    type,
    payload
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(createWorkerError(`Voice worker request timed out: ${type}`, 'VOICE_WORKER_TIMEOUT'));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer });
    workerProcess.stdin.write(`${message}\n`);
  });
}

export async function ensureVoiceWorkerReady() {
  if (VOICE_BACKEND !== 'python') {
    return false;
  }

  if (!workerReady || !workerProcess) {
    return false;
  }

  try {
    await sendWorkerRequest('ready_check', {}, 10000);
    return true;
  } catch (error) {
    return false;
  }
}

export function isVoiceWorkerHealthy() {
  return workerReady && !!workerProcess;
}

export async function startVoiceWorkerSession({ sessionId, guildId, channelId }) {
  return sendWorkerRequest('start_session', { sessionId, guildId, channelId });
}

export async function stopVoiceWorkerSession(sessionId) {
  return sendWorkerRequest('stop_session', { sessionId });
}

export async function shutdownVoiceWorker() {
  if (VOICE_BACKEND !== 'python') {
    return false;
  }

  if (shutdownPromise) {
    return shutdownPromise;
  }

  if (!workerProcess) {
    return true;
  }

  shutdownPromise = (async () => {
    try {
      if (workerReady) {
        await sendWorkerRequest('shutdown', {}, 15000).catch(() => null);
      }
    } finally {
      workerProcess?.kill('SIGTERM');
      cleanupWorkerState();
    }
    return true;
  })().finally(() => {
    shutdownPromise = null;
  });

  return shutdownPromise;
}
