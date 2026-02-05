import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import { TRANSCRIPT_DIR, SUMMARY_DIR } from '../config.js';
import { transcribeWithRetry } from './transcription.js';
import { summarizeTranscript } from './summarization.js';
import { convertToWordDoc } from './document.js';
import {
  getSessionsNeedingRecovery,
  getUntranscribedEntries,
  getTranscribedEntries,
  isSessionFullyTranscribed,
  buildTranscriptFromManifest,
  endSession,
  markSessionSummarized,
  getSessionStats,
  cleanupOldSessions,
  markStaleSessions
} from './manifest.js';

// Recovery state
let isRecovering = false;
let recoveryQueue = [];

/**
 * Run recovery for all sessions with untranscribed audio
 * @param {boolean} autoSummarize - Whether to auto-summarize completed sessions
 * @returns {Promise<{recovered: number, failed: number, summarized: number}>}
 */
export async function runRecovery(autoSummarize = true) {
  if (isRecovering) {
    console.log('⚠️ Recovery already in progress');
    return { recovered: 0, failed: 0, summarized: 0 };
  }

  isRecovering = true;
  const recoveryEventId = uuidv4();

  console.log('🔄 Starting audio recovery process...');

  logger.info("Starting audio recovery", {
    extra: {
      footprint: null,
      batch_uuid: null,
      user_id: null,
      event_id: recoveryEventId,
      action: "audio_recovery",
      event: "start"
    }
  });

  let recovered = 0;
  let failed = 0;
  let summarized = 0;

  try {
    // First, clean up old completed sessions
    cleanupOldSessions(7);

    // Get sessions needing recovery
    const sessions = getSessionsNeedingRecovery();

    if (sessions.length === 0) {
      console.log('✅ No sessions need recovery');
      isRecovering = false;
      return { recovered: 0, failed: 0, summarized: 0 };
    }

    console.log(`📋 Found ${sessions.length} session(s) needing recovery`);

    for (const session of sessions) {
      console.log(`\n📁 Processing session ${session.sessionId}...`);

      const stats = getSessionStats(session.sessionId);
      if (stats) {
        console.log(`   Total: ${stats.total}, Pending: ${stats.pending}, Failed: ${stats.failed}, Completed: ${stats.completed}`);
      }

      // Get untranscribed entries for this session
      const untranscribed = getUntranscribedEntries(session.sessionId);

      if (untranscribed.length > 0) {
        console.log(`   🎤 ${untranscribed.length} audio file(s) need transcription`);

        for (const entry of untranscribed) {
          console.log(`   📝 Transcribing ${path.basename(entry.audioPath)}...`);

          const result = await transcribeWithRetry(
            entry.audioPath,
            entry.sessionId,
            entry.userId,
            entry.id,
            3 // Max retries
          );

          if (result.success) {
            recovered++;
            console.log(`   ✅ Transcribed: "${result.text.substring(0, 50)}..."`);
          } else {
            failed++;
            console.log(`   ❌ Failed: ${result.error}`);

            // Stop recovery if we hit quota limits
            if (result.isQuotaError) {
              console.log('   💰 Stopping recovery due to quota limits');
              break;
            }
          }

          // Small delay between transcriptions to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Check if session is now fully transcribed
      if (autoSummarize && isSessionFullyTranscribed(session.sessionId)) {
        console.log(`   📄 Session fully transcribed, generating summary...`);

        try {
          const summaryResult = await generateSessionSummary(session.sessionId);
          if (summaryResult.success) {
            summarized++;
            console.log(`   ✅ Summary generated: ${summaryResult.summaryPath}`);
          }
        } catch (err) {
          console.error(`   ❌ Failed to generate summary: ${err.message}`);
        }
      }
    }

    console.log(`\n✅ Recovery complete: ${recovered} transcribed, ${failed} failed, ${summarized} summarized`);

    logger.info("Audio recovery completed", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: recoveryEventId,
        action: "audio_recovery",
        event: "complete",
        recovered,
        failed,
        summarized
      }
    });

  } catch (error) {
    logger.error("Audio recovery failed", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: recoveryEventId,
        action: "audio_recovery",
        event: "error",
        error_message: error.message
      }
    });
    console.error('❌ Recovery error:', error.message);
  } finally {
    isRecovering = false;
  }

  return { recovered, failed, summarized };
}

/**
 * Generate summary for a completed session
 * @param {string} sessionId - Session to summarize
 * @returns {Promise<{success: boolean, summaryPath: string|null}>}
 */
async function generateSessionSummary(sessionId) {
  // Build transcript from manifest entries
  const transcript = buildTranscriptFromManifest(sessionId);

  if (!transcript || transcript.trim().length === 0) {
    return { success: false, summaryPath: null, error: 'No transcript content' };
  }

  // Write transcript to file
  const [guildId, channelId] = sessionId.split(':');
  const ts = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const transcriptPath = path.join(TRANSCRIPT_DIR, `${guildId}-${channelId}-${ts}-recovered.log`);

  fs.writeFileSync(transcriptPath, transcript);
  endSession(sessionId, transcriptPath);

  // Create a mock sessionLogs map for the summarization function
  const sessionLogs = new Map();
  sessionLogs.set(sessionId, transcriptPath);

  try {
    // Generate summary
    const summary = await summarizeTranscript(guildId, channelId, sessionId, sessionLogs);

    if (!summary) {
      return { success: false, summaryPath: null, error: 'Summarization returned empty' };
    }

    // Generate Word document
    const now = new Date();
    const baseFileName = `Meeting_Minutes_${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}_${String(now.getDate()).padStart(2, '0')}__${String(now.getHours()).padStart(2, '0')}_${String(now.getMinutes()).padStart(2, '0')}_recovered`;

    const wordFileName = `${baseFileName}.docx`;
    const wordPath = path.join(SUMMARY_DIR, wordFileName);

    const titleMatch = summary.match(/Thema.*?-->(.*?)<!--/);
    const meetingTitle = titleMatch ? titleMatch[1].trim() : "Meeting";

    const wordBuffer = await convertToWordDoc(summary, meetingTitle);

    if (wordBuffer) {
      fs.writeFileSync(wordPath, wordBuffer);
      markSessionSummarized(sessionId, wordPath);

      console.log(`📄 Recovery summary saved: ${wordFileName}`);

      return { success: true, summaryPath: wordPath };
    }

    return { success: false, summaryPath: null, error: 'Word document generation failed' };

  } catch (error) {
    console.error('❌ Summary generation error:', error.message);
    return { success: false, summaryPath: null, error: error.message };
  }
}

/**
 * Get recovery status
 */
export function getRecoveryStatus() {
  const sessions = getSessionsNeedingRecovery();
  let totalUntranscribed = 0;

  for (const session of sessions) {
    totalUntranscribed += getUntranscribedEntries(session.sessionId).length;
  }

  return {
    isRecovering,
    sessionsNeedingRecovery: sessions.length,
    totalUntranscribed
  };
}

/**
 * Schedule periodic recovery checks
 * @param {number} intervalMs - Check interval in milliseconds (default: 30 minutes)
 */
export function schedulePeriodicRecovery(intervalMs = 30 * 60 * 1000) {
  console.log(`📅 Scheduling periodic recovery every ${intervalMs / 60000} minutes`);

  setInterval(async () => {
    // First check for stale sessions that might have been abandoned
    markStaleSessions(2);

    const status = getRecoveryStatus();
    if (status.totalUntranscribed > 0 && !status.isRecovering) {
      console.log(`\n🔄 Periodic recovery check: ${status.totalUntranscribed} files pending`);
      await runRecovery(true);
    }
  }, intervalMs);
}
