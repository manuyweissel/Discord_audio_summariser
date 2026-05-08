import { SlashCommandBuilder } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TRANSCRIPT_DIR } from '../config.js';
import logger from '../logger.js';
import { v4 as uuidv4 } from 'uuid';
import { handleJoin, sessionLogs } from './join.js';
import { handleLeave } from './leave.js';
import { isNonFatalInteractionError, safeRespond } from '../utils/index.js';

// Define slash commands
export const commands = [
  new SlashCommandBuilder().setName('join')
    .setDescription('Join the caller\'s voice channel & start transcribing'),
  new SlashCommandBuilder().setName('leave')
    .setDescription('Leave the current voice channel'),
];

/**
 * Generate a log file name for a session
 * @param {string} guildId - Discord guild ID
 * @param {string} channelId - Discord channel ID
 * @returns {string} Full path to the log file
 */
function makeLogFileName(guildId, channelId) {
  const ts = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  return path.join(TRANSCRIPT_DIR, `${guildId}-${channelId}-${ts}.log`);
}

/**
 * Write a transcript entry to the session log
 * Uses fs.promises.appendFile for sequential consistency (fixes race condition)
 * @param {string} guildId - Discord guild ID
 * @param {string} channelId - Discord channel ID
 * @param {string} username - Display name of the speaker
 * @param {string} text - Transcribed text content
 * @param {string} sessionId - Session identifier
 * @returns {Promise<void>}
 */
export async function writeTranscript(guildId, channelId, username, text, sessionId) {
  const key = sessionId || `${guildId}:${channelId}`;
  if (!sessionLogs.has(key)) {
    sessionLogs.set(key, makeLogFileName(guildId, channelId));
  }

  const logFile = sessionLogs.get(key);
  const line = `[${new Date().toISOString()}] ${username}: ${text}\n`;

  try {
    // Use awaited fs.promises.appendFile for sequential consistency
    // This prevents race conditions when multiple transcriptions complete simultaneously
    await fs.appendFile(logFile, line, 'utf-8');
  } catch (err) {
    logger.error("Failed to write transcript", {
      extra: {
        footprint: null,
        batch_uuid: `${guildId}:${channelId}`,
        user_id: username,
        event_id: uuidv4(),
        action: "transcript_write",
        event: "error",
        error_message: err.message
      }
    });
  }
}

/**
 * Handle interaction create events
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const interactionEventId = uuidv4();
  const responseContext = {
    batch_uuid: interactionEventId,
    user_id: interaction.user?.id
  };

  try {
    if (interaction.commandName === 'join') {
      await handleJoin(interaction, writeTranscript);
      return;
    }

    if (interaction.commandName === 'leave') {
      await handleLeave(interaction);
      return;
    }
  } catch (error) {
    const nonFatal = isNonFatalInteractionError(error);
    const logFn = nonFatal ? logger.warn : logger.error;

    logFn("Interaction handler failed", {
      extra: {
        footprint: null,
        batch_uuid: interactionEventId,
        user_id: interaction.user?.id,
        event_id: uuidv4(),
        action: "interaction_handling",
        event: nonFatal ? "non_fatal" : "error",
        command: interaction.commandName,
        error_code: error?.code,
        error_message: error?.message
      }
    });

    await safeRespond(
      interaction,
      {
        content: '❌ Beim Verarbeiten des Befehls ist ein Fehler aufgetreten. Bitte versuche es erneut.',
        ephemeral: true
      },
      { logger, context: responseContext }
    );
  }
}
