import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection
} from '@discordjs/voice';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import { captureUserAudio } from '../services/audio.js';
import { transcribeAudio } from '../services/transcription.js';
import { withSessionConcurrency, clearSessionConcurrency } from '../utils/index.js';

// Storage for session data
export const sessionLogs = new Map();
export const pendingTranscriptions = new Map();
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

/**
 * Clean up expired rate limit entries to prevent memory leak
 * Removes entries older than 2x the rate limit window
 */
function cleanupExpiredRateLimits() {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [userId, limit] of userRateLimits) {
    if (now - limit.windowStart > USER_RATE_LIMIT_WINDOW * 2) {
      userRateLimits.delete(userId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    logger.debug("Cleaned up expired rate limits", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "rate_limit_cleanup",
        event: "complete",
        cleaned_count: cleanedCount,
        remaining_count: userRateLimits.size
      }
    });
  }
}

// Schedule periodic rate limit cleanup to prevent memory leak
setInterval(cleanupExpiredRateLimits, RATE_LIMIT_CLEANUP_INTERVAL);

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

        setTimeout(() => {
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
    lastActivity: Date.now()
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

    const newConnection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    // Wait for the connection to be ready
    await entersState(newConnection, VoiceConnectionStatus.Ready, 20_000);

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

      setTimeout(() => {
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
      
      // Destroy connection and cleanup
      const connection = getVoiceConnection(connectionInfo.guildId);
      if (connection) {
        connection.destroy();
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
    return interaction.reply({ content: 'Jump into a voice channel first!', ephemeral: true });
  }

  // Validate bot permissions for the voice channel
  const botMember = interaction.guild.members.me;
  const permissions = channel.permissionsFor(botMember);
  
  if (!permissions.has('ViewChannel')) {
    return interaction.reply({
      content: '❌ I cannot see this voice channel. Please check my permissions.',
      ephemeral: true
    });
  }
  
  if (!permissions.has('Connect')) {
    return interaction.reply({
      content: '❌ I don\'t have permission to connect to this voice channel.',
      ephemeral: true
    });
  }
  
  if (!permissions.has('Speak')) {
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
  if (existingConnection && existingConnection.state.status !== VoiceConnectionStatus.Destroyed) {
    return interaction.reply({
      content: '🎙️ Already connected to a voice channel. Use `/leave` first to disconnect.',
      ephemeral: true
    });
  }

  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    // Wait for the connection to be ready (with timeout)
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      console.error('Failed to establish voice connection:', error);
      connection.destroy();
      return interaction.reply({
        content: '❌ Failed to connect to voice channel. Please try again.',
        ephemeral: true
      });
    }

    const connectionInfo = {
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      interaction,
      writeTranscript
    };

    // Setup connection handlers for resilience
    setupConnectionHandlers(connection, connectionInfo);

    // Setup speaking listener
    setupSpeakingListener(connection, interaction, writeTranscript);

    // Start health check
    const sessionId = `${channel.guild.id}:${channel.id}`;
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
        channel_name: channel.name,
        channel_id: channel.id
      }
    });

    interaction.reply(`🎙️ **Transkription gestartet** in **${channel.name}**\n📝 Sprechen Sie - ich erstelle automatisch ein Protokoll!\n\n_Verbindung wird automatisch wiederhergestellt falls nötig._`);

  } catch (error) {
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

    return interaction.reply({
      content: `❌ Error joining voice channel: ${error.message}`,
      ephemeral: true
    });
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
 * Get all active session IDs
 * Used for graceful shutdown to disconnect all voice connections
 * @returns {string[]} Array of active session IDs
 */
export function getActiveSessions() {
  return Array.from(activeConnections.keys());
}

/**
 * Get the guild ID from a session ID
 * @param {string} sessionId - Session ID in format "guildId:channelId"
 * @returns {string} Guild ID
 */
export function getGuildFromSession(sessionId) {
  return sessionId.split(':')[0];
}
