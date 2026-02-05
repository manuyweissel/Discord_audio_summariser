/**
 * Concurrency Management Module
 * 
 * Provides per-session concurrency limiting to prevent overwhelming
 * external APIs (like OpenAI Whisper) with too many simultaneous requests.
 * 
 * @module utils/concurrency
 */

// Simple per-session concurrency limiter
// Key: sessionId, Value: { active: number, queue: Function[] }
const concurrencyStates = new Map();

/**
 * @typedef {Object} ConcurrencyState
 * @property {number} active - Number of currently active operations
 * @property {Function[]} queue - Queue of pending operations
 */

/**
 * Limit concurrent operations per session using a semaphore pattern.
 * Operations that exceed the limit are queued and executed when slots become available.
 * 
 * @param {string} sessionId - The session identifier (e.g., "guildId:channelId")
 * @param {Function} fn - The async function to run with concurrency limiting
 * @param {number} [limit=2] - Maximum concurrent operations per session
 * @returns {Promise<*>} Promise that resolves with the function result
 * 
 * @example
 * // Limit transcription to 2 concurrent operations per session
 * const result = await withSessionConcurrency(
 *   sessionId,
 *   () => transcribeAudio(wavPath),
 *   2
 * );
 */
export function withSessionConcurrency(sessionId, fn, limit = 2) {
  if (!concurrencyStates.has(sessionId)) {
    concurrencyStates.set(sessionId, { active: 0, queue: [] });
  }
  const state = concurrencyStates.get(sessionId);

  return new Promise((resolve, reject) => {
    const run = async () => {
      state.active += 1;
      try {
        const result = await fn();
        resolve(result);
      } catch (e) {
        reject(e);
      } finally {
        state.active -= 1;
        if (state.queue.length > 0) {
          const next = state.queue.shift();
          next();
        }
      }
    };

    if (state.active < limit) {
      run();
    } else {
      state.queue.push(run);
    }
  });
}

/**
 * Clear concurrency state for a session.
 * Should be called during session cleanup to prevent memory leaks.
 * Any queued operations will be lost.
 * 
 * @param {string} sessionId - The session identifier to clear
 * @returns {boolean} True if state was cleared, false if no state existed
 * 
 * @example
 * // Clean up session resources
 * cleanupSession(sessionId);
 * clearSessionConcurrency(sessionId);
 */
export function clearSessionConcurrency(sessionId) {
  return concurrencyStates.delete(sessionId);
}

/**
 * Get the current concurrency state for a session (for debugging/monitoring)
 * 
 * @param {string} sessionId - The session identifier
 * @returns {ConcurrencyState|null} The current state or null if none exists
 */
export function getSessionConcurrencyState(sessionId) {
  const state = concurrencyStates.get(sessionId);
  if (!state) return null;
  return {
    active: state.active,
    queueLength: state.queue.length
  };
}

/**
 * Get all session IDs that have concurrency state
 * 
 * @returns {string[]} Array of session IDs with active concurrency state
 */
export function getAllConcurrencySessions() {
  return Array.from(concurrencyStates.keys());
}
