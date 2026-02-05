import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { WEEKLY_MEETING_CHANNEL_ID, TIMEZONE } from '../config.js';
import logger from '../logger.js';
import { calculateDurationMs } from '../utils/index.js';

/**
 * Schedule weekly meeting reminders
 * @param {Client} client - Discord client
 */
export function scheduleWeeklyMeetingReminder(client) {
  if (!WEEKLY_MEETING_CHANNEL_ID) {
    logger.warn("WEEKLY_MEETING_CHANNEL_ID not set – weekly reminders disabled");
    return;
  }

  // Runs every Thursday at 09:00 in Europe/Berlin
  cron.schedule(
    '0 9 * * 4',
    async () => {
      const reminderEventId = uuidv4();
      const startTime = Date.now();

      try {
        const channel = await client.channels.fetch(WEEKLY_MEETING_CHANNEL_ID);
        if (!channel || !channel.isTextBased()) {
          logger.error("Weekly reminder: channel not found or not text-based", {
            extra: {
              footprint: null,
              batch_uuid: null,
              user_id: null,
              event_id: reminderEventId,
              action: "weekly_reminder",
              event: "error"
            }
          });
          return;
        }

        await channel.send(
          "📝 Weekly prep: Please add agenda bullets for the weekly meeting to the current thread " +
          "and the shared doc:\n" +
          "https://docs.google.com/document/d/1P_3opjrJlhraPfpcRjGKUqtw2QwsmdSTp74tocNcNxg/edit?usp=sharing"
        );

        logger.info("Weekly meeting reminder sent", {
          extra: {
            footprint: null,
            batch_uuid: null,
            user_id: null,
            event_id: reminderEventId,
            action: "weekly_reminder",
            event: "complete",
            duration_ms: calculateDurationMs(startTime)
          }
        });
      } catch (err) {
        logger.error("Failed to send weekly meeting reminder", {
          extra: {
            footprint: null,
            batch_uuid: null,
            user_id: null,
            event_id: reminderEventId,
            action: "weekly_reminder",
            event: "error",
            duration_ms: calculateDurationMs(startTime)
          }
        }, err);
      }
    },
    { timezone: TIMEZONE }
  );
}
