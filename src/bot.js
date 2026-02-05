import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { v4 as uuidv4 } from 'uuid';

// Import modules
import { BOT_TOKEN, validateConfig } from './config.js';
import logger from './logger.js';
import { validateOpenAIKey } from './services/transcription.js';
import { runRecovery, schedulePeriodicRecovery, getRecoveryStatus } from './services/recovery.js';
import { markStaleSessions, cleanupOldSessions } from './services/manifest.js';
import { commands, handleInteraction } from './commands/index.js';
import { getActiveSessions, getGuildFromSession, cleanupSession } from './commands/join.js';
import { startGrafanaWebhookServer, stopGrafanaWebhookServer } from './integrations/grafana.js';
import { scheduleWeeklyMeetingReminder } from './integrations/weekly-reminder.js';
import { cleanupTokenizer } from './utils/index.js';

// Cleanup interval (24 hours)
const SESSION_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;

// Track if shutdown is in progress
let isShuttingDown = false;

// ---------- Startup ----------
const startupEventId = uuidv4();

logger.info("Bot startup initiated", {
  extra: {
    footprint: null,
    batch_uuid: startupEventId,
    user_id: null,
    event_id: uuidv4(),
    action: "bot_startup",
    event: "start"
  }
});

// Validate configuration
if (!validateConfig(logger, startupEventId)) {
  process.exit(1);
}

// ---------- Discord Client Setup ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- Ready Event ----------
client.once('ready', async () => {
  const readyEventId = uuidv4();
  const startTime = Date.now();

  logger.info("Discord client ready", {
    extra: {
      footprint: null,
      batch_uuid: startupEventId,
      user_id: null,
      event_id: readyEventId,
      action: "discord_ready",
      event: "start"
    }
  });

  // Validate OpenAI API key
  const isApiKeyValid = await validateOpenAIKey(startupEventId);
  if (!isApiKeyValid) {
    logger.error("Bot will continue but OpenAI features may not work", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: uuidv4(),
        action: "discord_ready",
        event: "warning"
      }
    });
  }

  // Register slash commands
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands.map(cmd => cmd.toJSON()) }
    );

    logger.info("Slash commands registered successfully", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: readyEventId,
        action: "discord_ready",
        event: "complete",
        duration_ms: Date.now() - startTime
      }
    });

    console.log(`✅ Bot ready: ${client.user.tag}`);
    console.log('✅ Commands registered');

  } catch (err) {
    logger.error("Failed to register slash commands", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: readyEventId,
        action: "discord_ready",
        event: "error",
        duration_ms: Date.now() - startTime
      }
    }, err);
  }

  // Schedule weekly meeting reminder
  scheduleWeeklyMeetingReminder(client);

  // Start Grafana webhook server (pass getActiveSessions for health endpoint)
  startGrafanaWebhookServer(client, getActiveSessions);

  // ---------- Periodic Maintenance ----------
  // Schedule cleanup of old sessions (runs daily)
  setInterval(() => {
    try {
      const { cleanedSessions, cleanedEntries } = cleanupOldSessions(7);
      if (cleanedSessions > 0 || cleanedEntries > 0) {
        logger.info("Scheduled session cleanup completed", {
          extra: {
            footprint: null,
            batch_uuid: null,
            user_id: null,
            event_id: uuidv4(),
            action: "scheduled_cleanup",
            event: "complete",
            cleaned_sessions: cleanedSessions,
            cleaned_entries: cleanedEntries
          }
        });
      }
    } catch (err) {
      console.error('⚠️ Scheduled cleanup failed:', err.message);
    }
  }, SESSION_CLEANUP_INTERVAL);
  console.log('📅 Scheduled daily cleanup of old sessions (7+ days)');

  // ---------- Audio Recovery System ----------
  // First, mark any stale "active" sessions (older than 2 hours) for recovery
  // This handles cases where the bot crashed without calling /leave
  const staleCount = markStaleSessions(2);
  if (staleCount > 0) {
    console.log(`🔄 Found ${staleCount} stale session(s) from previous bot runs`);
  }

  // Check for untranscribed audio from previous sessions
  const recoveryStatus = getRecoveryStatus();
  if (recoveryStatus.totalUntranscribed > 0) {
    console.log(`\n📋 Found ${recoveryStatus.totalUntranscribed} untranscribed audio file(s) from ${recoveryStatus.sessionsNeedingRecovery} session(s)`);

    // Only run recovery if API key is valid
    if (isApiKeyValid) {
      console.log('🔄 Starting audio recovery in 10 seconds...');

      // Delay recovery to ensure bot is fully ready
      setTimeout(async () => {
        try {
          await runRecovery(true); // Auto-summarize completed sessions
        } catch (err) {
          console.error('❌ Recovery failed:', err.message);
        }
      }, 10000);
    } else {
      console.log('⚠️ Skipping recovery - OpenAI API key not valid');
      console.log('💡 Audio files are saved and will be processed on next restart');
    }
  } else {
    console.log('✅ No pending audio recovery needed');
  }

  // Schedule periodic recovery (every 30 minutes)
  schedulePeriodicRecovery(30 * 60 * 1000);
});

// ---------- Interaction Handler ----------
client.on('interactionCreate', handleInteraction);

// ---------- Global Error Handling ----------
process.on('unhandledRejection', (reason) => {
  // Log the actual error to console for debugging
  console.error('❌ Unhandled Promise Rejection:', reason);
  
  logger.error(`Unhandled Promise Rejection: ${reason?.message || reason}`, {
    extra: {
      footprint: null,
      batch_uuid: null,
      user_id: null,
      event_id: uuidv4(),
      action: "error_handling",
      event: "error",
      error_type: "UnhandledPromiseRejection",
      error_message: reason?.message || String(reason),
      error_stack: reason?.stack
    }
  });
});

process.on('uncaughtException', (error) => {
  // Log the actual error to console for debugging
  console.error('❌ Uncaught Exception:', error);
  
  logger.error(`Uncaught Exception: ${error.message}`, {
    extra: {
      footprint: null,
      batch_uuid: null,
      user_id: null,
      event_id: uuidv4(),
      action: "error_handling",
      event: "error",
      error_type: "UncaughtException",
      error_message: error.message,
      error_stack: error.stack
    }
  });
  gracefulShutdown('uncaughtException');
});

// ---------- Graceful Shutdown ----------
/**
 * Gracefully shutdown the bot, cleaning up all resources
 * @param {string} signal - Signal that triggered shutdown
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log('⏳ Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  const shutdownEventId = uuidv4();
  const shutdownStartTime = Date.now();
  
  console.log(`\n🛑 Received ${signal}, initiating graceful shutdown...`);
  
  logger.info("Graceful shutdown initiated", {
    extra: {
      footprint: null,
      batch_uuid: null,
      user_id: null,
      event_id: shutdownEventId,
      action: "graceful_shutdown",
      event: "start",
      signal
    }
  });
  
  try {
    // 1. Stop Grafana webhook server
    console.log('🔌 Stopping Grafana webhook server...');
    await stopGrafanaWebhookServer();
    
    // 2. Stop accepting new voice connections and cleanup all sessions
    console.log('🔌 Disconnecting from voice channels...');
    
    // Get all active sessions and clean them up
    const activeSessions = getActiveSessions();
    for (const sessionId of activeSessions) {
      try {
        const guildId = getGuildFromSession(sessionId);
        const connection = getVoiceConnection(guildId);
        if (connection) {
          connection.destroy();
          console.log(`   ✅ Disconnected from guild ${guildId}`);
        }
        // Clean up session resources
        cleanupSession(sessionId);
      } catch (err) {
        console.error(`   ⚠️ Error disconnecting session ${sessionId}:`, err.message);
      }
    }
    
    // 3. Wait for pending transcriptions (with timeout)
    console.log('⏳ Waiting for pending transcriptions to complete (max 30s)...');
    await new Promise(resolve => setTimeout(resolve, 5000)); // Give 5 seconds grace period
    
    // 4. Clean up resources
    console.log('🧹 Cleaning up resources...');
    
    // Clean up tiktoken encoder
    cleanupTokenizer();
    
    // 5. Destroy Discord client
    console.log('🤖 Destroying Discord client...');
    client.destroy();
    
    const shutdownDuration = Date.now() - shutdownStartTime;
    
    logger.info("Graceful shutdown completed", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: shutdownEventId,
        action: "graceful_shutdown",
        event: "complete",
        duration_ms: shutdownDuration
      }
    });
    
    console.log(`✅ Graceful shutdown completed in ${shutdownDuration}ms`);
    
  } catch (err) {
    logger.error("Error during graceful shutdown", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: shutdownEventId,
        action: "graceful_shutdown",
        event: "error",
        error_message: err.message
      }
    });
    console.error('❌ Error during shutdown:', err.message);
  } finally {
    // Force exit after cleanup
    process.exit(signal === 'uncaughtException' ? 1 : 0);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// ---------- Start Bot ----------
client.login(BOT_TOKEN);
