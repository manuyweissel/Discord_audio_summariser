import { v4 as uuidv4 } from 'uuid';

const NON_FATAL_INTERACTION_ERROR_CODES = new Set([10062, 40060]);

function getDiscordErrorCode(error) {
  if (typeof error?.code === 'number') {
    return error.code;
  }

  if (typeof error?.rawError?.code === 'number') {
    return error.rawError.code;
  }

  return null;
}

function normalizePayload(payload) {
  if (typeof payload === 'string') {
    return { content: payload };
  }
  return payload;
}

function buildEditReplyPayload(payload) {
  const normalized = normalizePayload(payload);
  if (!normalized || typeof normalized !== 'object') {
    return normalized;
  }

  // editReply does not accept ephemeral; remove it when converting from reply payloads
  const { ephemeral, ...editPayload } = normalized;
  return editPayload;
}

export function isNonFatalInteractionError(error) {
  return NON_FATAL_INTERACTION_ERROR_CODES.has(getDiscordErrorCode(error));
}

function logInteractionResponseError(logger, error, action, context = {}) {
  const nonFatal = isNonFatalInteractionError(error);
  const logFn = nonFatal ? logger?.warn : logger?.error;
  const message = nonFatal
    ? 'Non-fatal interaction response error'
    : 'Interaction response failed';

  if (typeof logFn !== 'function') {
    return;
  }

  logFn(message, {
    extra: {
      footprint: null,
      batch_uuid: context.batch_uuid ?? null,
      user_id: context.user_id ?? null,
      event_id: uuidv4(),
      action,
      event: nonFatal ? 'non_fatal' : 'error',
      error_code: getDiscordErrorCode(error),
      error_message: error?.message
    }
  });
}

export async function safeDeferReply(interaction, options = {}, { logger, context = {} } = {}) {
  if (interaction.deferred || interaction.replied) {
    return true;
  }

  try {
    await interaction.deferReply(options);
    return true;
  } catch (error) {
    logInteractionResponseError(logger, error, 'interaction_defer', context);
    return false;
  }
}

export async function safeRespond(interaction, payload, { logger, context = {} } = {}) {
  try {
    if (interaction.deferred) {
      await interaction.editReply(buildEditReplyPayload(payload));
      return true;
    }

    if (interaction.replied) {
      await interaction.followUp(normalizePayload(payload));
      return true;
    }

    await interaction.reply(normalizePayload(payload));
    return true;
  } catch (error) {
    logInteractionResponseError(logger, error, 'interaction_respond', context);
    return false;
  }
}
