import fs from 'node:fs';
import path from 'node:path';
import { getVoiceConnection } from '@discordjs/voice';
import { AttachmentBuilder } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import { SUMMARY_DIR } from '../config.js';
import { calculateDurationMs } from '../utils/index.js';
import { summarizeTranscript } from '../services/summarization.js';
import { convertToWordDoc } from '../services/document.js';
import { sessionLogs, pendingTranscriptions, cleanupSession } from './join.js';

/**
 * Wait for all pending transcriptions to complete
 */
async function waitForPendingTranscriptions(sessionId, maxWaitTime = 15000) {
  const startTime = Date.now();
  const checkInterval = 2000;
  let lastLogTime = 0;
  const logInterval = 5000;

  while (Date.now() - startTime < maxWaitTime) {
    const pending = pendingTranscriptions.get(sessionId);
    if (!pending || pending.size === 0) {
      console.log('✅ All transcriptions completed');
      return true;
    }

    const now = Date.now();
    if (now - lastLogTime > logInterval) {
      console.log(`⏳ Waiting for ${pending.size} transcription(s) to complete...`);
      lastLogTime = now;
    }

    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }

  // Timeout reached - give extra time
  const remaining = pendingTranscriptions.get(sessionId)?.size || 0;
  if (remaining > 0) {
    console.log(`⚠️ Timeout reached: ${remaining} transcription(s) still pending. Giving extra time...`);

    const extraWaitTime = 15000;
    const extraStartTime = Date.now();

    while (Date.now() - extraStartTime < extraWaitTime) {
      const stillPending = pendingTranscriptions.get(sessionId);
      if (!stillPending || stillPending.size === 0) {
        console.log('✅ All remaining transcriptions completed during extra time');
        return true;
      }

      if (Date.now() - lastLogTime > logInterval) {
        console.log(`⏳ Extra time: ${stillPending.size} transcription(s) still processing...`);
        lastLogTime = Date.now();
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    const finalRemaining = pendingTranscriptions.get(sessionId)?.size || 0;
    if (finalRemaining > 0) {
      console.log(`⚠️ Final timeout: ${finalRemaining} transcription(s) could not complete. Proceeding anyway...`);
    }
  }
  return false;
}

/**
 * Handle the /leave command
 * @param {CommandInteraction} interaction - Discord interaction
 */
export async function handleLeave(interaction) {
  await interaction.deferReply();

  const interactionEventId = uuidv4();
  const leaveEventId = uuidv4();
  const leaveStartTime = Date.now();

  const conn = getVoiceConnection(interaction.guild.id);
  let sessionId = null;

  if (conn) {
    const channelId = conn.joinConfig.channelId;
    sessionId = `${interaction.guild.id}:${channelId}`;

    // Clean up stale pending transcriptions
    const pendingSet = pendingTranscriptions.get(sessionId);
    const pendingCount = pendingSet ? pendingSet.size : 0;
    if (pendingCount > 0) {
      console.log(`🧹 Cleaning up ${pendingCount} stale pending transcription(s)...`);
      pendingTranscriptions.delete(sessionId);
    }

    // Clean up health check and connection tracking
    cleanupSession(sessionId);

    conn.destroy();
    console.log('🔌 Voice connection closed');

    console.log('📝 Finalizing transcriptions...');
    await interaction.editReply('📝 Verarbeite noch offene Transkriptionen...');

    // Give time for final audio processing
    console.log('⏳ Allowing time for final audio processing...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const remainingAfterCleanup = pendingTranscriptions.get(sessionId);
    if (!remainingAfterCleanup || remainingAfterCleanup.size === 0) {
      console.log('✅ No pending transcriptions - proceeding immediately');
    }

    const allComplete = await waitForPendingTranscriptions(sessionId);

    if (allComplete) {
      console.log('✅ All transcriptions completed');
      await interaction.editReply('📝 Erstelle Meeting-Protokoll...');
    } else {
      console.log('⚠️ Some transcriptions may be incomplete');
      await interaction.editReply('⚠️ Erstelle Protokoll (einige Transkriptionen unvollständig)...');
    }

    pendingTranscriptions.delete(sessionId);
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

        await interaction.editReply({
          content: `📝 **Meeting-Protokoll erstellt!** 📄\n\n📄 **Microsoft Word (.docx)** - Professionell editierbar\n\n💼 Das Word-Dokument ist business-ready!`,
          files: [attachment]
        });

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

        await interaction.editReply(
          `📝 **Meeting-Protokoll erstellt!** \n📁 Datei gespeichert: \`${wordFileName}\`\n\n*Hinweis: Datei-Upload fehlgeschlagen, bitte lokale Datei verwenden.*`
        );
      }
    } else {
      await interaction.editReply(`⚠️ Meeting-Protokoll konnte nicht erstellt werden.`);
    }
  } else {
    await interaction.editReply('❌ Verbindung getrennt. Kein Transkript gefunden oder nichts zu erstellen.');
  }
}
