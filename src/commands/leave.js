import fs from 'node:fs';
import path from 'node:path';
import { getVoiceConnection } from '@discordjs/voice';
import { AttachmentBuilder } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import { SUMMARY_DIR, VOICE_BACKEND } from '../config.js';
import { calculateDurationMs, safeDeferReply, safeRespond } from '../utils/index.js';
import { summarizeTranscript } from '../services/summarization.js';
import { convertToWordDoc } from '../services/document.js';
import { waitForPendingVoiceProcessing } from '../services/voiceCapturePipeline.js';
import { stopVoiceWorkerSession } from '../services/voiceWorkerClient.js';
import {
  sessionLogs,
  cleanupSession,
  getActiveSessionIdForGuild,
  getActiveSessionInfo
} from './join.js';

/**
 * Handle the /leave command
 * @param {CommandInteraction} interaction - Discord interaction
 */
export async function handleLeave(interaction) {
  const interactionEventId = uuidv4();
  const leaveEventId = uuidv4();
  const leaveStartTime = Date.now();
  const responseContext = {
    batch_uuid: interactionEventId,
    user_id: interaction.user?.id
  };

  const didDefer = await safeDeferReply(interaction, {}, { logger, context: responseContext });
  if (!didDefer) {
    return;
  }

  const conn = getVoiceConnection(interaction.guild.id);
  const activeSessionId = getActiveSessionIdForGuild(interaction.guild.id);
  let sessionId = null;

  if (conn) {
    const channelId = conn.joinConfig.channelId;
    sessionId = `${interaction.guild.id}:${channelId}`;
  } else if (activeSessionId) {
    sessionId = activeSessionId;
  }

  if (sessionId) {
    const activeSession = getActiveSessionInfo(sessionId);

    if (VOICE_BACKEND === 'python' && activeSession?.backend === 'python') {
      await stopVoiceWorkerSession(sessionId).catch(error => {
        logger.warn("Failed to stop python voice worker session", {
          extra: {
            footprint: null,
            batch_uuid: sessionId,
            user_id: interaction.user.id,
            event_id: uuidv4(),
            action: "voice_leave",
            event: "worker_stop_failed",
            error_message: error?.message
          }
        });
      });
      console.log('🔌 Python voice worker session closed');
    } else if (conn) {
      conn.destroy();
      console.log('🔌 Voice connection closed');
    }

    console.log('📝 Finalizing transcriptions...');
    await safeRespond(
      interaction,
      '📝 Verarbeite noch offene Transkriptionen...',
      { logger, context: responseContext }
    );

    const allComplete = await waitForPendingVoiceProcessing(sessionId, 30000);
    cleanupSession(sessionId);

    if (allComplete) {
      console.log('✅ All transcriptions completed');
      await safeRespond(
        interaction,
        '📝 Erstelle Meeting-Protokoll...',
        { logger, context: responseContext }
      );
    } else {
      console.log('⚠️ Some transcriptions may be incomplete');
      await safeRespond(
        interaction,
        '⚠️ Erstelle Protokoll (einige Transkriptionen unvollständig)...',
        { logger, context: responseContext }
      );
    }
  }

  let summary = null;
  try {
    const preservedChannelId = sessionId ? sessionId.split(':')[1] : null;
    summary = await summarizeTranscript(interaction.guild.id, preservedChannelId, sessionId, sessionLogs);
  } catch (err) {
    logger.error("Failed to summarize transcript", {
      extra: {
        footprint: null,
        batch_uuid: interactionEventId,
        user_id: interaction.user.id,
        event_id: leaveEventId,
        action: "voice_leave",
        event: "error",
        duration_ms: calculateDurationMs(leaveStartTime)
      }
    }, err);
  } finally {
    if (sessionId) {
      sessionLogs.delete(sessionId);
      console.log(`🗑️ Cleaned up session log for ${sessionId}`);
    }
  }

  if (summary) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const baseFileName = `Meeting_Minutes_${year}_${month}_${day}__${hour}_${minute}`;

    // Extract meeting title from summary
    const titleMatch = summary.match(/Thema.*?-->(.*?)<!--/);
    const meetingTitle = titleMatch ? titleMatch[1].trim() : "Meeting";

    // Generate Word document
    const wordFileName = `${baseFileName}.docx`;
    const wordPath = path.join(SUMMARY_DIR, wordFileName);
    let wordBuffer = null;

    try {
      wordBuffer = await convertToWordDoc(summary, meetingTitle);
      if (wordBuffer) {
        fs.writeFileSync(wordPath, wordBuffer);
        console.log(`📄 Word document generated: ${wordFileName}`);
      }
    } catch (error) {
      console.error('Failed to generate Word document:', error);
    }

    // Upload Word document
    if (wordBuffer) {
      try {
        const attachment = new AttachmentBuilder(wordPath, { name: wordFileName });

        await safeRespond(
          interaction,
          {
            content: `📝 **Meeting-Protokoll erstellt!** 📄\n\n📄 **Microsoft Word (.docx)** - Professionell editierbar\n\n💼 Das Word-Dokument ist business-ready!`,
            files: [attachment]
          },
          { logger, context: responseContext }
        );

        console.log(`✅ Uploaded: ${wordFileName}`);

        logger.info("Summary files created and uploaded successfully", {
          extra: {
            footprint: null,
            batch_uuid: interactionEventId,
            user_id: interaction.user.id,
            event_id: leaveEventId,
            action: "voice_leave",
            event: "complete",
            duration_ms: calculateDurationMs(leaveStartTime)
          }
        });

      } catch (uploadError) {
        logger.error("Failed to upload summary file", {
          extra: {
            footprint: null,
            batch_uuid: interactionEventId,
            user_id: interaction.user.id,
            event_id: uuidv4(),
            action: "file_upload",
            event: "error"
          }
        }, uploadError);

        await safeRespond(
          interaction,
          `📝 **Meeting-Protokoll erstellt!** \n📁 Datei gespeichert: \`${wordFileName}\`\n\n*Hinweis: Datei-Upload fehlgeschlagen, bitte lokale Datei verwenden.*`,
          { logger, context: responseContext }
        );
      }
    } else {
      await safeRespond(
        interaction,
        '⚠️ Meeting-Protokoll konnte nicht erstellt werden.',
        { logger, context: responseContext }
      );
    }
  } else {
    await safeRespond(
      interaction,
      '❌ Verbindung getrennt. Kein Transkript gefunden oder nichts zu erstellen.',
      { logger, context: responseContext }
    );
  }
}
