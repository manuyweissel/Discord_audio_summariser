import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  generateDependencyReport
} from '@discordjs/voice';
import { once } from 'node:events';
import { PermissionFlagsBits } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import { BOT_TOKEN, VOICE_BACKEND } from '../config.js';
import { captureUserAudio } from '../services/audio.js';
import { transcribeAudio } from '../services/transcription.js';
import { pendingTranscriptions } from '../services/voiceCapturePipeline.js';
import {
  ensureVoiceWorkerReady,
  isVoiceWorkerHealthy,
  startVoiceWorkerSession,
  stopVoiceWorkerSession
} from '../services/voiceWorkerClient.js';
import {
  withSessionConcurrency,
  clearSessionConcurrency,
  safeDeferReply,
  safeRespond
} from '../utils/index.js';

// Storage for session data
export const sessionLogs = new Map();
const captureInProgress = new Set();

// Track active connections for reconnection
const activeConnections = new Map();

// Per-user rate limiting state
const userRateLimits = new Map();

// Connection health check interval (30 seconds)
const HEALTH_CHECK_INTERVAL = 30000;
// Max reconnection attempts
const MAX_RECONNECT_ATTEMPTS = 5;
// Reconnection delay base (exponential backoff)
const RECONNECT_DELAY_BASE = 1000;
// Session idle timeout (3 minutes) - auto-disconnect if channel is empty
const SESSION_IDLE_TIMEOUT = 3 * 60 * 1000;
// Rate limit: max transcriptions per user per minute
// Set very high (1000) - effectively unlimited for normal use
const USER_RATE_LIMIT = 1000;
const USER_RATE_LIMIT_WINDOW = 60 * 1000;
// Rate limit cleanup interval (5 minutes)
const RATE_LIMIT_CLEANUP_INTERVAL = 5 * 60 * 1000;
// Audio issue diagnostics entry expiry (10 minutes)
const AUDIO_ISSUE_EXPIRY_MS = 10 * 60 * 1000;
// Voice connection ready timeout (configurable for slow networks/regions)
const VOICE_READY_TIMEOUT_MS = Number(process.env.VOICE_READY_TIMEOUT_MS || 30000);
const VOICE_READY_GRACE_TIMEOUT_MS = Number(process.env.VOICE_READY_GRACE_TIMEOUT_MS || 30000);
// Voice connection retries for initial join/rejoin
const VOICE_CONNECT_MAX_ATTEMPTS = Math.max(1, Number(process.env.VOICE_CONNECT_MAX_ATTEMPTS || 3));
const VOICE_CONNECT_RETRY_DELAY_MS = Number(process.env.VOICE_CONNECT_RETRY_DELAY_MS || 1500);
const VOICE_SIGNAL_RECOVERY_TIMEOUT_MS = Number(process.env.VOICE_SIGNAL_RECOVERY_TIMEOUT_MS || 5000);
const DISCORD_SESSION_REFRESH_COOLDOWN_MS = Number(process.env.DISCORD_SESSION_REFRESH_COOLDOWN_MS || 60000);
const VOICE_NETWORK_CLOSE_CODE_DAVE_REQUIRED = 4017;
// Keep existing behavior by default (self-muted bot)
const BOT_SELF_MUTE = process.env.DISCORD_BOT_SELF_MUTE !== 'false';
const VOICE_CONNECT_FALLBACK_UNMUTE = process.env.VOICE_CONNECT_FALLBACK_UNMUTE !== 'false';
const STALE_REMOTE_VOICE_RESET_DELAY_MS = Number(process.env.STALE_REMOTE_VOICE_RESET_DELAY_MS || 1500);

let opusDependencyStatus = null;
let voiceDependencyReport = null;
let discordSessionRefreshPromise = null;
let lastDiscordSessionRefreshAt = 0;
const VOICE_ENCRYPTION_LIBRARIES = [
  'sodium-native',
  'sodium',
  'libsodium-wrappers',
  '@stablelib/xchacha20poly1305',
  '@noble/ciphers'
];

function hasDependencyInstalled(report, dependencyName) {
  const escaped = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const installedPattern = new RegExp(`- ${escaped}:\\s+(?!not found$).+`, 'm');
  return installedPattern.test(report);
}

function getVoiceDependencyReport() {
  if (!voiceDependencyReport) {
    voiceDependencyReport = generateDependencyReport();
  }
  return voiceDependencyReport;
}

function hasSupportedEncryptionLibrary(report) {
  return VOICE_ENCRYPTION_LIBRARIES.some(dep => hasDependencyInstalled(report, dep));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createVoiceJoinError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function getVoiceJoinStrategy(attempt) {
  const useUnmutedFallback = VOICE_CONNECT_FALLBACK_UNMUTE && attempt > 1;

  return {
    label: useUnmutedFallback ? 'unmuted-fallback' : 'default',
    selfDeaf: false,
    selfMute: useUnmutedFallback ? false : BOT_SELF_MUTE,
    readyTimeoutMs: VOICE_READY_TIMEOUT_MS,
    readyGraceTimeoutMs: VOICE_READY_GRACE_TIMEOUT_MS,
  };
}

function formatVoiceDebugTail(messages, limit = 8) {
  if (!messages.length) {
    return null;
  }

  return messages.slice(-limit).join(' || ');
}

async function refreshDiscordGatewaySession(client, { sessionId, action, reason }) {
  const now = Date.now();

  if (discordSessionRefreshPromise) {
    return discordSessionRefreshPromise;
  }

  if (now - lastDiscordSessionRefreshAt < DISCORD_SESSION_REFRESH_COOLDOWN_MS) {
    logger.warn("Skipping Discord client session refresh due to cooldown", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action,
        event: "gateway_refresh_skipped",
        reason,
        cooldown_ms: DISCORD_SESSION_REFRESH_COOLDOWN_MS
      }
    });
    return false;
  }

  discordSessionRefreshPromise = (async () => {
    logger.warn("Refreshing Discord client session after voice join failures", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action,
        event: "gateway_refresh_start",
        reason
      }
    });

    try {
      const readyPromise = once(client, 'ready');
      client.destroy();
      await client.login(BOT_TOKEN);
      await readyPromise;
      lastDiscordSessionRefreshAt = Date.now();

      logger.info("Discord client session refreshed", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: null,
          event_id: uuidv4(),
          action,
          event: "gateway_refresh_complete",
          reason
        }
      });
      return true;
    } catch (error) {
      lastDiscordSessionRefreshAt = Date.now();
      logger.error("Discord client session refresh failed", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: null,
          event_id: uuidv4(),
          action,
          event: "gateway_refresh_error",
          reason,
          error_message: error?.message
        }
      });
      return false;
    } finally {
      discordSessionRefreshPromise = null;
    }
  })();

  return discordSessionRefreshPromise;
}

async function waitForVoiceReady(connection, { attempt, sessionId, action, strategy }) {
  const transitions = [];
  const debugMessages = [];
  let signallingRecoveryTimer = null;
  let rejectOnRegression;
  let observedNetworking = null;
  let detachNetworkingCloseListener = null;
  let networkingCloseCode = null;

  const clearSignallingRecoveryTimer = () => {
    if (signallingRecoveryTimer) {
      clearTimeout(signallingRecoveryTimer);
      signallingRecoveryTimer = null;
    }
  };

  const regressionPromise = new Promise((_, reject) => {
    rejectOnRegression = reject;
  });

  const readyAbortController = new AbortController();

  const stateChangeHandler = (oldState, newState) => {
    const transition = `${oldState.status}->${newState.status}`;
    transitions.push(transition);
    logger.info("Voice connection state changed", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action,
        event: "state_change",
        attempt,
        strategy: strategy.label,
        from_status: oldState.status,
        to_status: newState.status
      }
    });

    attachNetworkingCloseListener(newState.networking);

    if (newState.status !== VoiceConnectionStatus.Signalling) {
      clearSignallingRecoveryTimer();
      return;
    }

    if (oldState.status === VoiceConnectionStatus.Connecting) {
      clearSignallingRecoveryTimer();
      signallingRecoveryTimer = setTimeout(() => {
        signallingRecoveryTimer = null;

        if (connection.state?.status !== VoiceConnectionStatus.Signalling) {
          return;
        }

        const error = createVoiceJoinError(
          'Voice connection regressed to signalling and did not recover',
          'VOICE_SIGNALLING_REGRESSION',
          {
            finalStatus: connection.state?.status,
            transitions: [...transitions],
            debugTail: formatVoiceDebugTail(debugMessages)
          }
        );

        readyAbortController.abort();
        rejectOnRegression(error);
      }, VOICE_SIGNAL_RECOVERY_TIMEOUT_MS);

      logger.warn("Voice connection regressed to signalling before reaching Ready", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: null,
          event_id: uuidv4(),
          action,
          event: "signalling_regression",
          attempt,
          strategy: strategy.label,
          recovery_timeout_ms: VOICE_SIGNAL_RECOVERY_TIMEOUT_MS
        }
      });
    }
  };

  const debugHandler = (message) => {
    debugMessages.push(message);
    if (debugMessages.length > 25) {
      debugMessages.shift();
    }
  };

  const errorHandler = (error) => {
    debugMessages.push(`connection-error: ${error?.message || 'unknown error'}`);
    if (debugMessages.length > 25) {
      debugMessages.shift();
    }
  };

  const attachNetworkingCloseListener = (networking) => {
    if (!networking || networking === observedNetworking) {
      return;
    }

    if (detachNetworkingCloseListener) {
      detachNetworkingCloseListener();
    }

    const closeHandler = (code) => {
      networkingCloseCode = code;
      debugMessages.push(`networking-close: ${code}`);
      if (debugMessages.length > 25) {
        debugMessages.shift();
      }

      logger.warn("Voice networking closed before Ready", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: null,
          event_id: uuidv4(),
          action,
          event: "networking_close",
          attempt,
          strategy: strategy.label,
          close_code: code
        }
      });
    };

    networking.once('close', closeHandler);
    detachNetworkingCloseListener = () => {
      networking.off?.('close', closeHandler);
    };
    observedNetworking = networking;
  };

  connection.on('stateChange', stateChangeHandler);
  connection.on('debug', debugHandler);
  connection.on('error', errorHandler);
  attachNetworkingCloseListener(connection.state?.networking);

  try {
    await Promise.race([
      entersState(connection, VoiceConnectionStatus.Ready, readyAbortController.signal),
      regressionPromise,
      sleep(strategy.readyTimeoutMs).then(() => {
        throw createVoiceJoinError(
          'Voice connection ready wait timed out',
          'VOICE_READY_TIMEOUT',
          {
            finalStatus: connection.state?.status,
            transitions: [...transitions],
            debugTail: formatVoiceDebugTail(debugMessages)
          }
        );
      })
    ]);
    return;
  } catch (error) {
    const finalStatus = connection.state?.status;
    const sawProgress = transitions.some(transition =>
      transition.includes(VoiceConnectionStatus.Signalling) ||
      transition.includes(VoiceConnectionStatus.Connecting)
    );
    const regressedToSignalling = transitions.includes(
      `${VoiceConnectionStatus.Connecting}->${VoiceConnectionStatus.Signalling}`
    );
    const debugTail = formatVoiceDebugTail(debugMessages);

    if (networkingCloseCode === VOICE_NETWORK_CLOSE_CODE_DAVE_REQUIRED) {
      throw createVoiceJoinError(
        'Discord rejected the voice join with close code 4017 (DAVE E2EE required)',
        'VOICE_DAVE_REQUIRED',
        {
          closeCode: networkingCloseCode,
          finalStatus,
          transitions: [...transitions],
          debugTail
        }
      );
    }

    logger.warn("Voice connection did not reach Ready", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action,
        event: "ready_timeout",
        attempt,
        strategy: strategy.label,
        final_status: finalStatus,
        saw_progress: sawProgress,
        regressed_to_signalling: regressedToSignalling,
        transitions: transitions.join(' | '),
        debug_tail: debugTail
      }
    });

    if (regressedToSignalling || finalStatus === VoiceConnectionStatus.Signalling) {
      throw createVoiceJoinError(
        error?.message || 'Voice connection regressed to signalling',
        error?.code || 'VOICE_SIGNALLING_REGRESSION',
        {
          finalStatus,
          transitions: [...transitions],
          debugTail
        }
      );
    }

    if (
      sawProgress ||
      finalStatus === VoiceConnectionStatus.Connecting
    ) {
      logger.info("Extending voice connection wait due to observed progress", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: null,
          event_id: uuidv4(),
          action,
          event: "ready_grace_period",
          attempt,
          strategy: strategy.label,
          grace_timeout_ms: strategy.readyGraceTimeoutMs,
          debug_tail: debugTail
        }
      });

      await entersState(connection, VoiceConnectionStatus.Ready, strategy.readyGraceTimeoutMs);
      return;
    }

    throw error;
  } finally {
    readyAbortController.abort();
    clearSignallingRecoveryTimer();
    detachNetworkingCloseListener?.();
    connection.off('stateChange', stateChangeHandler);
    connection.off('debug', debugHandler);
    connection.off('error', errorHandler);
  }
}

/**
 * Detect available Opus engine at runtime for voice reliability diagnostics
 * @returns {Promise<{available: boolean, engine: string}>}
 */
async function ensureOpusDependency() {
  if (opusDependencyStatus) {
    return opusDependencyStatus;
  }

  try {
    await import('@discordjs/opus');
    opusDependencyStatus = { available: true, engine: '@discordjs/opus' };
    logger.info("Opus runtime ready", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "voice_runtime",
        event: "ready",
        opus_engine: '@discordjs/opus'
      }
    });
    return opusDependencyStatus;
  } catch (nativeErr) {
    try {
      await import('opusscript');
      opusDependencyStatus = { available: true, engine: 'opusscript' };
      logger.warn("Using opusscript fallback for Opus (slower than @discordjs/opus)", {
        extra: {
          footprint: null,
          batch_uuid: null,
          user_id: null,
          event_id: uuidv4(),
          action: "voice_runtime",
          event: "warning",
          opus_engine: 'opusscript'
        }
      });
      return opusDependencyStatus;
    } catch (scriptErr) {
      opusDependencyStatus = { available: false, engine: 'none' };
      logger.error("No Opus dependency available - voice capture cannot start", {
        extra: {
          footprint: null,
          batch_uuid: null,
          user_id: null,
          event_id: uuidv4(),
          action: "voice_runtime",
          event: "error",
          native_error: nativeErr?.message,
          fallback_error: scriptErr?.message
        }
      });
      return opusDependencyStatus;
    }
  }
}

/**
 * Validate runtime dependencies required for Discord voice encryption/transport
 * @returns {Promise<{available: boolean, reason?: string}>}
 */
async function ensureVoiceRuntimeDependencies() {
  const opusStatus = await ensureOpusDependency();
  if (!opusStatus.available) {
    return { available: false, reason: 'missing_opus' };
  }

  const dependencyReport = getVoiceDependencyReport();
  if (!hasSupportedEncryptionLibrary(dependencyReport)) {
    logger.error("No supported Discord voice encryption library found", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "voice_runtime",
        event: "error",
        reason: "missing_encryption_dependency",
        dependency_report: dependencyReport
      }
    });
    return { available: false, reason: 'missing_encryption' };
  }

  return { available: true };
}

/**
 * Establish voice connection with bounded retries to reduce transient AbortError failures
 * @param {Object} params - Connection parameters
 * @returns {Promise<import('@discordjs/voice').VoiceConnection>}
 */
async function resetRemoteBotVoiceState(guild, { sessionId, action, attempt, targetChannelId, reason }) {
  const botMember = await guild.members.fetchMe().catch(() => guild.members.me);
  if (!botMember) {
    return false;
  }

  const remoteChannelId = botMember?.voice?.channelId ?? null;

  if (!remoteChannelId) {
    return false;
  }

  logger.warn("Resetting remote bot voice state", {
    extra: {
      footprint: null,
      batch_uuid: sessionId,
      user_id: null,
      event_id: uuidv4(),
      action,
      event: "remote_voice_state_reset_start",
      attempt,
      reason,
      remote_channel_id: remoteChannelId,
      target_channel_id: targetChannelId
    }
  });

  try {
    await botMember.voice.disconnect(reason);
    await sleep(STALE_REMOTE_VOICE_RESET_DELAY_MS);

    logger.info("Remote bot voice state reset completed", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action,
        event: "remote_voice_state_reset_complete",
        attempt,
        reason,
        remote_channel_id: remoteChannelId
      }
    });
    return true;
  } catch (error) {
    logger.warn("Failed to reset remote bot voice state", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action,
        event: "remote_voice_state_reset_failed",
        attempt,
        reason,
        remote_channel_id: remoteChannelId,
        error_message: error?.message
      }
    });
    return false;
  }
}

async function connectToVoiceWithRetry({ channelId, guildId, adapterCreator, guild, sessionId, action = 'voice_join' }) {
  let lastError = null;

  for (let attempt = 1; attempt <= VOICE_CONNECT_MAX_ATTEMPTS; attempt++) {
    const strategy = getVoiceJoinStrategy(attempt);

    logger.info("Starting voice connection attempt", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action,
        event: "attempt_start",
        attempt,
        max_attempts: VOICE_CONNECT_MAX_ATTEMPTS,
        strategy: strategy.label,
        self_deaf: strategy.selfDeaf,
        self_mute: strategy.selfMute,
        timeout_ms: strategy.readyTimeoutMs,
        grace_timeout_ms: strategy.readyGraceTimeoutMs
      }
    });

    if (attempt > 1 && guild) {
      await resetRemoteBotVoiceState(guild, {
        sessionId,
        action,
        attempt,
        targetChannelId: channelId,
        reason: 'Reset bot voice state before retry'
      });
    }

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: strategy.selfDeaf,
      selfMute: strategy.selfMute,
      debug: true,
    });

    try {
      await waitForVoiceReady(connection, { attempt, sessionId, action, strategy });
      return connection;
    } catch (error) {
      lastError = error;

      logger.warn("Voice connection attempt failed", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: null,
          event_id: uuidv4(),
          action,
          event: "retry",
          attempt,
          max_attempts: VOICE_CONNECT_MAX_ATTEMPTS,
          strategy: strategy.label,
          timeout_ms: strategy.readyTimeoutMs,
          grace_timeout_ms: strategy.readyGraceTimeoutMs,
          final_status: connection.state?.status,
          error_code: error?.code,
          error_message: error?.message,
          debug_tail: error?.debugTail || null
        }
      });

      try {
        connection.destroy();
      } catch (destroyErr) {
        // Ignore connection destroy errors while retrying
      }

      if (error?.code === 'VOICE_DAVE_REQUIRED') {
        throw error;
      }

      if (attempt < VOICE_CONNECT_MAX_ATTEMPTS) {
        if (guild) {
          await resetRemoteBotVoiceState(guild, {
            sessionId,
            action,
            attempt,
            targetChannelId: channelId,
            reason: 'Reset bot voice state after failed join'
          });
        }

        const delay = VOICE_CONNECT_RETRY_DELAY_MS * attempt;
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error('Voice connection failed');
}

/**
 * Clean up expired rate limit entries to prevent memory leak
 * Removes entries older than 2x the rate limit window
 */
function cleanupExpiredRateLimits() {
  const now = Date.now();
  let cleanedCount = 0;
  let cleanedAudioIssues = 0;
  
  for (const [userId, limit] of userRateLimits) {
    if (now - limit.windowStart > USER_RATE_LIMIT_WINDOW * 2) {
      userRateLimits.delete(userId);
      cleanedCount++;
    }
  }

  for (const [userId, issue] of userAudioIssues) {
    if (now - issue.lastSeen > AUDIO_ISSUE_EXPIRY_MS) {
      userAudioIssues.delete(userId);
      cleanedAudioIssues++;
    }
  }
  
  if (cleanedCount > 0 || cleanedAudioIssues > 0) {
    logger.debug("Cleaned up expired rate limits", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "rate_limit_cleanup",
        event: "complete",
        cleaned_count: cleanedCount,
        cleaned_audio_issues: cleanedAudioIssues,
        remaining_count: userRateLimits.size
      }
    });
  }
}

// Schedule periodic rate limit cleanup to prevent memory leak
const rateLimitCleanupIntervalId = setInterval(cleanupExpiredRateLimits, RATE_LIMIT_CLEANUP_INTERVAL);
rateLimitCleanupIntervalId.unref?.();

// Track users with persistent audio issues (for diagnostics only - no pausing)
const userAudioIssues = new Map();
const AUDIO_ISSUE_THRESHOLD = 10; // Log a hint after this many consecutive failures

/**
 * Track audio capture failure for a user (diagnostics only)
 * @param {string} userId - User ID
 * @param {string} username - Username for display
 */
function trackAudioIssue(userId, username) {
  const current = userAudioIssues.get(userId) || { count: 0, lastSeen: 0, warned: false };
  const now = Date.now();
  
  // Reset count if last issue was > 5 minutes ago
  if (now - current.lastSeen > 5 * 60 * 1000) {
    current.count = 0;
    current.warned = false;
  }
  
  current.count++;
  current.lastSeen = now;
  current.username = username;
  
  // Log a hint once after many failures (but don't pause)
  if (current.count === AUDIO_ISSUE_THRESHOLD && !current.warned) {
    current.warned = true;
    console.log(`💡 ${username}: ${AUDIO_ISSUE_THRESHOLD}+ audio failures - user may need to check Discord mic settings`);
  }
  
  userAudioIssues.set(userId, current);
}

/**
 * Reset audio issue counter on successful capture
 * @param {string} userId - User ID
 */
function resetAudioIssue(userId) {
  userAudioIssues.delete(userId);
}

/**
 * Setup connection state handlers for resilience
 * @param {VoiceConnection} connection - The voice connection
 * @param {Object} connectionInfo - Info needed for reconnection
 */
function setupConnectionHandlers(connection, connectionInfo) {
  const { channelId, guildId, adapterCreator, interaction, writeTranscript } = connectionInfo;
  const sessionId = `${guildId}:${channelId}`;

  // Handle disconnection
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log(`⚠️ Voice connection disconnected for session ${sessionId}`);

    logger.warn("Voice connection disconnected", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action: "voice_connection",
        event: "disconnected"
      }
    });

    try {
      // Try to reconnect within 5 seconds (Discord may be moving us)
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      console.log('🔄 Connection is reconnecting...');
    } catch (error) {
      // Seems like a real disconnect, try to rejoin
      console.log('❌ Connection lost, attempting to rejoin...');

      const reconnectInfo = activeConnections.get(sessionId);
      if (reconnectInfo && reconnectInfo.attempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectInfo.attempts++;
        const delay = RECONNECT_DELAY_BASE * Math.pow(2, reconnectInfo.attempts - 1);

        console.log(`🔄 Reconnection attempt ${reconnectInfo.attempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);

        if (reconnectInfo.reconnectTimeoutId) {
          clearTimeout(reconnectInfo.reconnectTimeoutId);
        }

        reconnectInfo.reconnectTimeoutId = setTimeout(() => {
          reconnectInfo.reconnectTimeoutId = null;
          attemptReconnection(connectionInfo);
        }, delay);
      } else {
        console.log('❌ Max reconnection attempts reached, giving up');
        connection.destroy();
        activeConnections.delete(sessionId);
      }
    }
  });

  // Handle successful connection/reconnection
  connection.on(VoiceConnectionStatus.Ready, () => {
    console.log(`✅ Voice connection ready for session ${sessionId}`);

    // Reset reconnection attempts on successful connection
    const reconnectInfo = activeConnections.get(sessionId);
    if (reconnectInfo) {
      reconnectInfo.attempts = 0;
      if (reconnectInfo.reconnectTimeoutId) {
        clearTimeout(reconnectInfo.reconnectTimeoutId);
        reconnectInfo.reconnectTimeoutId = null;
      }
    }

    logger.info("Voice connection ready", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action: "voice_connection",
        event: "ready"
      }
    });
  });

  // Handle destroyed connection
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    console.log(`🗑️ Voice connection destroyed for session ${sessionId}`);

    const reconnectInfo = activeConnections.get(sessionId);
    if (reconnectInfo?.reconnectTimeoutId) {
      clearTimeout(reconnectInfo.reconnectTimeoutId);
      reconnectInfo.reconnectTimeoutId = null;
    }

    activeConnections.delete(sessionId);

    // Clean up any pending transcriptions
    const pendingSet = pendingTranscriptions.get(sessionId);
    if (pendingSet && pendingSet.size > 0) {
      console.log(`🧹 Cleaning up ${pendingSet.size} pending transcription(s) after disconnect`);
      pendingTranscriptions.delete(sessionId);
    }
  });

  // Handle errors
  connection.on('error', (error) => {
    console.error(`❌ Voice connection error for session ${sessionId}:`, error.message);

    logger.error("Voice connection error", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action: "voice_connection",
        event: "error",
        error_message: error.message
      }
    });
  });

  // Store connection info for potential reconnection
  activeConnections.set(sessionId, {
    connectionInfo,
    attempts: 0,
    lastActivity: Date.now(),
    reconnectTimeoutId: null
  });
}

/**
 * Attempt to reconnect to the voice channel
 * @param {Object} connectionInfo - Connection information
 */
async function attemptReconnection(connectionInfo) {
  const { channelId, guildId, adapterCreator, interaction, writeTranscript } = connectionInfo;
  const sessionId = `${guildId}:${channelId}`;

  try {
    // Check if there's still an existing connection
    const existingConnection = getVoiceConnection(guildId);
    if (existingConnection && existingConnection.state.status !== VoiceConnectionStatus.Destroyed) {
      console.log('🔄 Existing connection found, attempting to recover...');
      return;
    }

    console.log(`🔄 Rejoining voice channel ${channelId}...`);

    const newConnection = await connectToVoiceWithRetry({
      channelId,
      guildId,
      adapterCreator,
      sessionId,
      action: 'voice_reconnection'
    });

    console.log('✅ Successfully reconnected to voice channel');

    // Re-setup handlers
    setupConnectionHandlers(newConnection, connectionInfo);

    // Re-setup speaking listener
    setupSpeakingListener(newConnection, interaction, writeTranscript);

    logger.info("Voice reconnection successful", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action: "voice_reconnection",
        event: "complete"
      }
    });

  } catch (error) {
    console.error(`❌ Reconnection failed:`, error.message);

    logger.error("Voice reconnection failed", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action: "voice_reconnection",
        event: "error",
        error_message: error.message
      }
    });

    // Schedule another attempt if we haven't hit the max
    const reconnectInfo = activeConnections.get(sessionId);
    if (reconnectInfo && reconnectInfo.attempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectInfo.attempts++;
      const delay = RECONNECT_DELAY_BASE * Math.pow(2, reconnectInfo.attempts - 1);
      console.log(`🔄 Will retry reconnection in ${delay}ms (attempt ${reconnectInfo.attempts}/${MAX_RECONNECT_ATTEMPTS})`);

      if (reconnectInfo.reconnectTimeoutId) {
        clearTimeout(reconnectInfo.reconnectTimeoutId);
      }

      reconnectInfo.reconnectTimeoutId = setTimeout(() => {
        reconnectInfo.reconnectTimeoutId = null;
        attemptReconnection(connectionInfo);
      }, delay);
    } else {
      console.log('❌ Giving up on reconnection after max attempts');
      activeConnections.delete(sessionId);
    }
  }
}

/**
 * Setup the speaking listener for audio capture
 * Includes rate limiting to prevent abuse
 * @param {VoiceConnection} connection - The voice connection
 * @param {CommandInteraction} interaction - Discord interaction
 * @param {Function} writeTranscript - Function to write transcript entries
 */
function setupSpeakingListener(connection, interaction, writeTranscript) {
  const channel = interaction.member.voice?.channel;
  if (!channel) return;

  // Remove any existing listeners to prevent duplicates (fixes MaxListeners warning)
  connection.receiver.speaking.removeAllListeners('start');

  connection.receiver.speaking.on('start', async (userId) => {
    const sessionId = `${interaction.guild.id}:${channel.id}`;
    const captureKey = `${sessionId}:${userId}`;

    // Update last activity and clear idle timeout
    const reconnectInfo = activeConnections.get(sessionId);
    if (reconnectInfo) {
      reconnectInfo.lastActivity = Date.now();
      // Clear idle timeout since someone is speaking
      if (reconnectInfo.idleTimeoutId) {
        clearTimeout(reconnectInfo.idleTimeoutId);
        reconnectInfo.idleTimeoutId = null;
      }
    }

    // Get username early for better logging (cache-friendly, Discord caches members)
    const username = await interaction.guild.members
      .fetch(userId)
      .then(u => u.displayName)
      .catch(() => `User-${userId.slice(-4)}`);

    // Check per-user rate limit to prevent abuse (logs only once per window)
    if (isUserRateLimited(userId, username)) {
      return; // Message already logged inside isUserRateLimited
    }

    console.log(`🎤 ${username} started speaking`);

    // Check if connection is still valid
    if (connection.state.status === 'destroyed' ||
        connection.state.status === VoiceConnectionStatus.Disconnected) {
      console.log('⚠️ Ignoring speaking event - connection not ready');
      return;
    }

    if (captureInProgress.has(captureKey)) {
      return; // avoid re-entrant capture for same speaker/session
    }
    captureInProgress.add(captureKey);

    // Track this transcription as pending
    if (!pendingTranscriptions.has(sessionId)) {
      pendingTranscriptions.set(sessionId, new Set());
    }

    const transcriptionId = uuidv4();
    pendingTranscriptions.get(sessionId).add(transcriptionId);

    try {
      // 1) Capture user audio -> WAV (limit parallelism per session)
      // Audio is always saved to manifest for recovery
      console.log(`🎵 Starting audio capture for ${username}`);
      const captureResult = await withSessionConcurrency(
        sessionId,
        () => captureUserAudio(connection, userId, username),
        2
      );

      if (!captureResult.wavPath || captureResult.tooSmall) {
        // Don't log error for short audio - it's normal for brief sounds/coughs
        if (!captureResult.tooSmall) {
          const errorReason = captureResult.error || 'unknown';
          // Provide actionable hint based on error type
          let hint = '';
          if (errorReason.includes('No audio packets') || errorReason.includes('muted')) {
            hint = ' → Check if user has mic muted or using Push-to-Talk';
            trackAudioIssue(userId, username); // Track for pattern detection
          } else if (errorReason.includes('Capture timeout')) {
            hint = ' → User may have network issues or unstable connection';
            trackAudioIssue(userId, username);
          }
          console.log(`❌ ${username}: ${errorReason}${hint}`);
        }
        const pendingSet = pendingTranscriptions.get(sessionId);
        if (pendingSet) {
          pendingSet.delete(transcriptionId);
        }
        captureInProgress.delete(captureKey);
        return;
      }

      // Successful capture - reset issue tracker
      resetAudioIssue(userId);
      console.log(`✅ Audio captured for user ${username}: ${captureResult.wavPath}`);

      // 2) Transcribe with retry logic (uses manifest tracking)
      let transcriptionResult = null;
      let retries = 3;
      let attempt = 0;

      while (retries >= 0) {
        transcriptionResult = await withSessionConcurrency(
          sessionId,
          () => transcribeAudio(
            captureResult.wavPath,
            sessionId,
            userId,
            captureResult.entryId // Pass manifest entry ID
          ),
          2
        );

        if (transcriptionResult.success) {
          break; // Success!
        }

        // Don't retry quota errors - audio is saved for later
        if (transcriptionResult.isQuotaError) {
          console.log('💰 Audio saved for later retry (quota exceeded)');
          break;
        }

        retries--;
        if (retries >= 0) {
          attempt++;
          const backoff = Math.min(15000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
          console.log(`🔄 Retrying transcription (attempt ${attempt + 1}) in ${backoff}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }

      // Write to transcript file if successful
      if (transcriptionResult?.success && transcriptionResult.text?.trim()) {
        console.log(`📝 ${username} (${userId}): ${transcriptionResult.text}`);
        writeTranscript(interaction.guild.id, channel.id, username, transcriptionResult.text, sessionId);
      } else if (!transcriptionResult?.isQuotaError) {
        // Log specific error reason (no more "Unknown error")
        const reason = transcriptionResult?.error || 'Empty response from Whisper';
        console.log(`⚠️ Transcription failed for ${username}: ${reason}`);
        // Audio is already saved in manifest for recovery
      }

    } catch (err) {
      logger.error("Voice processing failed", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: userId,
          event_id: uuidv4(),
          action: "voice_processing",
          event: "error"
        }
      }, err);
      // Audio is still saved in manifest for recovery
    } finally {
      const pendingSet = pendingTranscriptions.get(sessionId);
      if (pendingSet) {
        pendingSet.delete(transcriptionId);
        console.log(`🧹 Cleaned up transcription ${transcriptionId.substr(0, 8)}... (${pendingSet.size} remaining)`);
      }
      captureInProgress.delete(captureKey);
    }
  });
}

/**
 * Check if the voice channel is empty (only bot present)
 * @param {Object} connectionInfo - Connection information
 * @returns {Promise<boolean>} True if channel is empty
 */
async function isChannelEmpty(connectionInfo) {
  try {
    const { interaction, channelId } = connectionInfo;
    const channel = await interaction.guild.channels.fetch(channelId);
    if (!channel || !channel.members) return true;
    
    // Count members excluding bots
    const humanMembers = channel.members.filter(member => !member.user.bot);
    return humanMembers.size === 0;
  } catch (err) {
    // If we can't check, assume not empty to be safe
    return false;
  }
}

/**
 * Start the idle timeout checker for empty channels
 * @param {string} sessionId - The session identifier
 * @param {Object} connectionInfo - Connection information
 */
function startIdleTimeoutChecker(sessionId, connectionInfo) {
  const reconnectInfo = activeConnections.get(sessionId);
  if (!reconnectInfo) return;
  
  // Clear any existing timeout
  if (reconnectInfo.idleTimeoutId) {
    clearTimeout(reconnectInfo.idleTimeoutId);
  }
  
  reconnectInfo.idleTimeoutId = setTimeout(async () => {
    const isEmpty = await isChannelEmpty(connectionInfo);
    
    if (isEmpty) {
      console.log(`⏰ Session ${sessionId} timed out - channel empty for ${SESSION_IDLE_TIMEOUT / 1000} seconds`);
      
      logger.info("Session idle timeout triggered", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: null,
          event_id: uuidv4(),
          action: "session_timeout",
          event: "triggered",
          idle_duration_ms: SESSION_IDLE_TIMEOUT
        }
      });
      
      if (connectionInfo.backend === 'python') {
        try {
          await stopVoiceWorkerSession(sessionId);
        } catch (error) {
          logger.warn("Failed to stop python voice worker session during idle timeout", {
            extra: {
              footprint: null,
              batch_uuid: sessionId,
              user_id: null,
              event_id: uuidv4(),
              action: "session_timeout",
              event: "worker_stop_failed",
              error_message: error?.message
            }
          });
        }
      } else {
        const connection = getVoiceConnection(connectionInfo.guildId);
        if (connection) {
          connection.destroy();
        }
      }
      cleanupSession(sessionId);
      
      // Try to notify the channel
      try {
        const channel = await connectionInfo.interaction.guild.channels.fetch(connectionInfo.channelId);
        if (channel && channel.isVoiceBased()) {
          const textChannel = connectionInfo.interaction.channel;
          if (textChannel && textChannel.isTextBased()) {
            await textChannel.send('⏰ Bot disconnected due to idle timeout (channel was empty for 3 minutes).');
          }
        }
      } catch (err) {
        // Ignore notification errors
      }
    } else {
      // Channel not empty, restart the timeout
      startIdleTimeoutChecker(sessionId, connectionInfo);
    }
  }, SESSION_IDLE_TIMEOUT);
}

/**
 * Start a health check interval for the connection
 * Monitors connection health and triggers reconnection if needed
 * @param {string} sessionId - The session identifier
 */
function startHealthCheck(sessionId) {
  const intervalId = setInterval(async () => {
    const reconnectInfo = activeConnections.get(sessionId);
    if (!reconnectInfo) {
      clearInterval(intervalId);
      return;
    }

    const { connectionInfo } = reconnectInfo;
    const connection = getVoiceConnection(connectionInfo.guildId);

    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
      console.log(`💔 Health check: Connection lost for session ${sessionId}`);
      clearInterval(intervalId);

      // Attempt reconnection if we haven't exceeded max attempts
      if (reconnectInfo.attempts < MAX_RECONNECT_ATTEMPTS) {
        attemptReconnection(connectionInfo);
      }
      return;
    }

    // Check if channel is empty and start idle timeout if so
    const isEmpty = await isChannelEmpty(connectionInfo);
    if (isEmpty && !reconnectInfo.idleTimeoutId) {
      console.log(`👻 Channel appears empty, starting idle timeout for session ${sessionId}`);
      startIdleTimeoutChecker(sessionId, connectionInfo);
    } else if (!isEmpty && reconnectInfo.idleTimeoutId) {
      // Someone joined, clear the idle timeout
      clearTimeout(reconnectInfo.idleTimeoutId);
      reconnectInfo.idleTimeoutId = null;
    }

    // Log health status periodically
    const timeSinceLastActivity = Date.now() - reconnectInfo.lastActivity;
    if (timeSinceLastActivity > 300000) { // 5 minutes
      console.log(`💤 Connection idle for ${Math.round(timeSinceLastActivity / 60000)} minutes`);
    }

  }, HEALTH_CHECK_INTERVAL);

  // Store interval ID for cleanup
  const reconnectInfo = activeConnections.get(sessionId);
  if (reconnectInfo) {
    reconnectInfo.healthCheckInterval = intervalId;
  }
}

/**
 * Handle the /join command
 * @param {CommandInteraction} interaction - Discord interaction
 * @param {Function} writeTranscript - Function to write transcript entries
 */
export async function handleJoin(interaction, writeTranscript) {
  const interactionEventId = uuidv4();
  const responseContext = {
    batch_uuid: interactionEventId,
    user_id: interaction.user?.id
  };

  const channel = interaction.member.voice?.channel;
  if (!channel) {
    logger.warn("User not in voice channel", {
      extra: {
        footprint: null,
        batch_uuid: interactionEventId,
        user_id: interaction.user.id,
        event_id: uuidv4(),
        action: "interaction_handling",
        event: "error"
      }
    });
    await safeRespond(
      interaction,
      { content: 'Jump into a voice channel first!', ephemeral: true },
      { logger, context: responseContext }
    );
    return;
  }

  // Validate bot permissions for the voice channel
  const botMember = await interaction.guild.members.fetchMe().catch(() => interaction.guild.members.me);
  const permissions = channel.permissionsFor(botMember);
  const sessionId = `${channel.guild.id}:${channel.id}`;
  
  if (!permissions.has(PermissionFlagsBits.ViewChannel)) {
    await safeRespond(
      interaction,
      {
        content: '❌ I cannot see this voice channel. Please check my permissions.',
        ephemeral: true
      },
      { logger, context: responseContext }
    );
    return;
  }
  
  if (!permissions.has(PermissionFlagsBits.Connect)) {
    await safeRespond(
      interaction,
      {
        content: '❌ I don\'t have permission to connect to this voice channel.',
        ephemeral: true
      },
      { logger, context: responseContext }
    );
    return;
  }
  
  if (!permissions.has(PermissionFlagsBits.Speak)) {
    logger.warn("Bot missing Speak permission - audio capture may fail", {
      extra: {
        footprint: null,
        batch_uuid: interactionEventId,
        user_id: interaction.user.id,
        event_id: uuidv4(),
        action: "permission_check",
        event: "warning",
        channel_id: channel.id
      }
    });
  }

  // Check for existing connection
  const existingConnection = getVoiceConnection(channel.guild.id);
  if (
    (existingConnection && existingConnection.state.status !== VoiceConnectionStatus.Destroyed)
    || hasActiveSessionForGuild(channel.guild.id)
  ) {
    await safeRespond(
      interaction,
      {
        content: '🎙️ Already connected to a voice channel. Use `/leave` first to disconnect.',
        ephemeral: true
      },
      { logger, context: responseContext }
    );
    return;
  }

  const remoteBotVoiceChannelId = botMember?.voice?.channelId ?? null;
  if (remoteBotVoiceChannelId) {
    logger.warn("Bot has remote voice state without a local connection", {
      extra: {
        footprint: null,
        batch_uuid: interactionEventId,
        user_id: interaction.user.id,
        event_id: uuidv4(),
        action: "voice_join",
        event: "stale_remote_voice_state",
        remote_channel_id: remoteBotVoiceChannelId,
        target_channel_id: channel.id
      }
    });

    const staleResetSucceeded = await resetRemoteBotVoiceState(channel.guild, {
      sessionId: interactionEventId,
      action: 'voice_join',
      attempt: 0,
      targetChannelId: channel.id,
      reason: 'Reset stale bot voice state before reconnect'
    });

    if (staleResetSucceeded) {
      logger.info("Stale remote bot voice state cleared", {
        extra: {
          footprint: null,
          batch_uuid: interactionEventId,
          user_id: interaction.user.id,
          event_id: uuidv4(),
          action: "voice_join",
          event: "stale_remote_voice_state_cleared",
          remote_channel_id: remoteBotVoiceChannelId
        }
      });
    } else {
      const movePermissionAvailable = permissions.has(PermissionFlagsBits.MoveMembers);
      logger.warn("Failed to clear stale remote bot voice state", {
        extra: {
          footprint: null,
          batch_uuid: interactionEventId,
          user_id: interaction.user.id,
          event_id: uuidv4(),
          action: "voice_join",
          event: "stale_remote_voice_state_clear_failed",
          remote_channel_id: remoteBotVoiceChannelId,
          error_message: movePermissionAvailable ? 'Unknown reset failure' : 'Missing Move Members permission',
          move_members_permission: movePermissionAvailable
        }
      });
    }
  }

  logger.info("Received voice join request", {
    extra: {
      footprint: null,
      batch_uuid: interactionEventId,
      user_id: interaction.user.id,
      event_id: uuidv4(),
      action: "voice_join",
      event: "request",
      target_channel_id: channel.id,
      target_channel_name: channel.name,
      target_rtc_region: channel.rtcRegion ?? 'auto',
      bot_remote_voice_channel_id: remoteBotVoiceChannelId,
      bot_self_mute_default: BOT_SELF_MUTE
    }
  });

  try {
    const didDefer = await safeDeferReply(interaction, {}, { logger, context: responseContext });
    if (!didDefer) {
      return;
    }

    if (VOICE_BACKEND === 'python') {
      const workerReady = isVoiceWorkerHealthy() || await ensureVoiceWorkerReady();
      if (!workerReady) {
        await safeRespond(
          interaction,
          {
            content: '❌ Python voice worker is not ready. Check the worker startup logs and `VOICE_WORKER_PYTHON`.',
            ephemeral: true
          },
          { logger, context: responseContext }
        );
        return;
      }

      await startVoiceWorkerSession({
        sessionId,
        guildId: channel.guild.id,
        channelId: channel.id
      });

      const connectionInfo = {
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        interaction,
        writeTranscript,
        backend: 'python'
      };

      activeConnections.set(sessionId, {
        backend: 'python',
        connectionInfo,
        attempts: 0,
        lastActivity: Date.now(),
        reconnectTimeoutId: null,
        idleTimeoutId: null,
        healthCheckInterval: null
      });

      startIdleTimeoutChecker(sessionId, connectionInfo);

      logger.info("Joined voice channel via python worker", {
        extra: {
          footprint: null,
          batch_uuid: interactionEventId,
          user_id: interaction.user.id,
          event_id: uuidv4(),
          action: "voice_join",
          event: "complete",
          backend: "python",
          channel_name: channel.name,
          channel_id: channel.id
        }
      });

      await safeRespond(
        interaction,
        `🎙️ **Transkription gestartet** in **${channel.name}**\n📝 Sprechen Sie - ich erstelle automatisch ein Protokoll!\n\n_DAVE voice capture läuft über den Python-Worker._`,
        { logger, context: responseContext }
      );
      return;
    }

    const voiceRuntimeStatus = await ensureVoiceRuntimeDependencies();
    if (!voiceRuntimeStatus.available) {
      const runtimeMessage = voiceRuntimeStatus.reason === 'missing_encryption'
        ? '❌ Voice runtime nicht verfügbar: Verschlüsselungsbibliothek fehlt. Bitte `npm i @noble/ciphers` ausführen und Bot neu starten.'
        : '❌ Audio runtime nicht verfügbar (Opus dependency fehlt). Bitte @discordjs/opus oder opusscript installieren.';

      await safeRespond(
        interaction,
        {
          content: runtimeMessage,
          ephemeral: true
        },
        { logger, context: responseContext }
      );
      return;
    }

    let activeGuild = channel.guild;
    let activeChannel = channel;
    let connection;

    try {
      connection = await connectToVoiceWithRetry({
        channelId: activeChannel.id,
        guildId: activeGuild.id,
        adapterCreator: activeGuild.voiceAdapterCreator,
        guild: activeGuild,
        sessionId,
        action: 'voice_join'
      });
    } catch (error) {
      if (error?.code !== 'VOICE_SIGNALLING_REGRESSION') {
        throw error;
      }

      const sessionRefreshed = await refreshDiscordGatewaySession(interaction.client, {
        sessionId,
        action: 'voice_join',
        reason: 'voice_signalling_regression'
      });

      if (!sessionRefreshed) {
        throw error;
      }

      let refreshedGuild = interaction.client.guilds.cache.get(channel.guild.id) ?? null;
      if (!refreshedGuild) {
        refreshedGuild = await interaction.client.guilds.fetch(channel.guild.id).catch(() => null);
      }

      let refreshedChannel = refreshedGuild?.channels?.cache.get(channel.id) ?? null;
      if (!refreshedChannel && refreshedGuild) {
        refreshedChannel = await refreshedGuild.channels.fetch(channel.id).catch(() => null);
      }

      if (!refreshedGuild || !refreshedChannel?.isVoiceBased?.()) {
        throw error;
      }

      activeGuild = refreshedGuild;
      activeChannel = refreshedChannel;

      logger.info("Retrying voice join after Discord client session refresh", {
        extra: {
          footprint: null,
          batch_uuid: interactionEventId,
          user_id: interaction.user.id,
          event_id: uuidv4(),
          action: "voice_join",
          event: "gateway_refresh_retry",
          target_channel_id: activeChannel.id,
          target_channel_name: activeChannel.name
        }
      });

      connection = await connectToVoiceWithRetry({
        channelId: activeChannel.id,
        guildId: activeGuild.id,
        adapterCreator: activeGuild.voiceAdapterCreator,
        guild: activeGuild,
        sessionId,
        action: 'voice_join_after_gateway_refresh'
      });
    }

    const connectionInfo = {
      channelId: activeChannel.id,
      guildId: activeGuild.id,
      adapterCreator: activeGuild.voiceAdapterCreator,
      interaction,
      writeTranscript
    };

    // Setup connection handlers for resilience
    setupConnectionHandlers(connection, connectionInfo);

    // Setup speaking listener
    setupSpeakingListener(connection, interaction, writeTranscript);

    // Start health check
    startHealthCheck(sessionId);
    
    // Also start initial idle timeout check
    startIdleTimeoutChecker(sessionId, connectionInfo);

    logger.info("Joined voice channel", {
      extra: {
        footprint: null,
        batch_uuid: interactionEventId,
        user_id: interaction.user.id,
        event_id: uuidv4(),
        action: "voice_join",
        event: "complete",
        channel_name: activeChannel.name,
        channel_id: activeChannel.id
      }
    });

    await safeRespond(
      interaction,
      `🎙️ **Transkription gestartet** in **${activeChannel.name}**\n📝 Sprechen Sie - ich erstelle automatisch ein Protokoll!\n\n_Verbindung wird automatisch wiederhergestellt falls nötig._`,
      { logger, context: responseContext }
    );

  } catch (error) {
    const joinErrorMessage = error?.code === 'VOICE_DAVE_REQUIRED'
      ? '❌ Discord rejected this voice channel with close code 4017. Since March 2, 2026, non-Stage voice channels require DAVE end-to-end encryption, and the current bot voice stack cannot join them.'
      : `❌ Error joining voice channel: ${error.message}`;

    logger.error("Failed to join voice channel", {
      extra: {
        footprint: null,
        batch_uuid: interactionEventId,
        user_id: interaction.user.id,
        event_id: uuidv4(),
        action: "voice_join",
        event: "error",
        error_message: error.message
      }
    });

    await safeRespond(
      interaction,
      {
        content: joinErrorMessage,
        ephemeral: true
      },
      { logger, context: responseContext }
    );
    return;
  }
}

/**
 * Check if a user is rate limited
 * @param {string} userId - User ID to check
 * @param {string} username - Username for logging
 * @returns {boolean} True if user should be rate limited
 */
function isUserRateLimited(userId, username = 'Unknown') {
  const now = Date.now();
  const userLimit = userRateLimits.get(userId);
  
  if (!userLimit) {
    userRateLimits.set(userId, { 
      count: 1, 
      windowStart: now, 
      logged: false, 
      suppressedCount: 0,
      username 
    });
    return false;
  }
  
  // Reset window if expired
  if (now - userLimit.windowStart > USER_RATE_LIMIT_WINDOW) {
    // Log summary if we suppressed messages
    if (userLimit.suppressedCount > 0) {
      console.log(`📊 ${userLimit.username}: Rate limit window reset (${userLimit.suppressedCount} events suppressed)`);
    }
    userRateLimits.set(userId, { 
      count: 1, 
      windowStart: now, 
      logged: false, 
      suppressedCount: 0,
      username 
    });
    return false;
  }
  
  // Check if limit exceeded
  if (userLimit.count >= USER_RATE_LIMIT) {
    // Only log the FIRST time we hit the limit
    if (!userLimit.logged) {
      userLimit.logged = true;
      logger.warn("User rate limited", {
        extra: {
          footprint: null,
          batch_uuid: null,
          user_id: userId,
          event_id: uuidv4(),
          action: "rate_limit",
          event: "exceeded",
          count: userLimit.count,
          limit: USER_RATE_LIMIT
        }
      });
      console.log(`⚠️ ${username} rate limited (${USER_RATE_LIMIT}/min) - suppressing further messages`);
    } else {
      // Silently count suppressed events
      userLimit.suppressedCount++;
    }
    return true;
  }
  
  userLimit.count++;
  return false;
}

/**
 * Clean up rate limit entry for a user
 * @param {string} userId - User ID to clean up
 */
function clearUserRateLimit(userId) {
  userRateLimits.delete(userId);
}

/**
 * Clean up a session (called from leave command)
 * Ensures all resources are properly released to prevent memory leaks
 * @param {string} sessionId - The session identifier
 */
export function cleanupSession(sessionId) {
  const reconnectInfo = activeConnections.get(sessionId);
  if (reconnectInfo) {
    // Clear health check interval
    if (reconnectInfo.healthCheckInterval) {
      clearInterval(reconnectInfo.healthCheckInterval);
    }
    // Clear idle timeout if set
    if (reconnectInfo.idleTimeoutId) {
      clearTimeout(reconnectInfo.idleTimeoutId);
    }
    // Clear any delayed reconnection attempt
    if (reconnectInfo.reconnectTimeoutId) {
      clearTimeout(reconnectInfo.reconnectTimeoutId);
    }
    activeConnections.delete(sessionId);
  }
  
  // Clear concurrency state to prevent memory leak in concurrencyStates Map
  clearSessionConcurrency(sessionId);
  
  // Clean up pending transcriptions
  pendingTranscriptions.delete(sessionId);
  
  // Clean up capture in progress flags for this session
  for (const key of captureInProgress) {
    if (key.startsWith(sessionId)) {
      captureInProgress.delete(key);
    }
  }
  
  logger.info("Session cleanup completed", {
    extra: {
      footprint: null,
      batch_uuid: sessionId,
      user_id: null,
      event_id: uuidv4(),
      action: "session_cleanup",
      event: "complete"
    }
  });
}

/**
 * Cleanup module-level resources used by /join command handlers
 * Called during bot shutdown to avoid timer leaks in long-running processes
 */
export function cleanupJoinCommandResources() {
  clearInterval(rateLimitCleanupIntervalId);

  for (const sessionId of Array.from(activeConnections.keys())) {
    cleanupSession(sessionId);
  }

  userRateLimits.clear();
  userAudioIssues.clear();
}

/**
 * Get all active session IDs
 * Used for graceful shutdown to disconnect all voice connections
 * @returns {string[]} Array of active session IDs
 */
export function getActiveSessions() {
  return Array.from(activeConnections.keys());
}

export function getActiveSessionInfo(sessionId) {
  return activeConnections.get(sessionId) || null;
}

export function getActiveSessionIdForGuild(guildId) {
  for (const [sessionId, sessionInfo] of activeConnections.entries()) {
    if (sessionInfo?.connectionInfo?.guildId === guildId) {
      return sessionId;
    }
  }

  return null;
}

export function hasActiveSessionForGuild(guildId) {
  return Boolean(getActiveSessionIdForGuild(guildId));
}

/**
 * Get the guild ID from a session ID
 * @param {string} sessionId - Session ID in format "guildId:channelId"
 * @returns {string} Guild ID
 */
export function getGuildFromSession(sessionId) {
  return sessionId.split(':')[0];
}
