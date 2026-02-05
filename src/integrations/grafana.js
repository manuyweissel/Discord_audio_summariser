import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { INCIDENTS_CHANNEL_ID, GRAFANA_WEBHOOK_PORT, GRAFANA_WEBHOOK_SECRET } from '../config.js';
import logger from '../logger.js';
import { calculateDurationMs } from '../utils/index.js';

// Track daily Grafana alert threads
const grafanaDailyThreads = new Map();

// Store server instance for graceful shutdown
let grafanaServer = null;

// Track server start time for health endpoint
let serverStartTime = null;

/**
 * Sanitize a string to prevent Discord markdown injection
 * Escapes special characters and limits length
 * @param {string} str - String to sanitize
 * @param {number} maxLength - Maximum allowed length (default: 500)
 * @returns {string} Sanitized string
 */
function sanitize(str, maxLength = 500) {
  if (!str || typeof str !== 'string') return '';
  
  // Escape Discord markdown special characters
  const escaped = str
    .replace(/[@#`*_~|\\]/g, '\\$&')  // Escape markdown chars
    .replace(/\n{3,}/g, '\n\n')        // Limit consecutive newlines
    .trim();
  
  // Limit length
  if (escaped.length > maxLength) {
    return escaped.slice(0, maxLength - 3) + '...';
  }
  
  return escaped;
}

/**
 * Middleware to validate Grafana webhook secret
 * Rejects unauthenticated requests with 401 Unauthorized
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware function
 */
function validateWebhookSecret(req, res, next) {
  // If no secret is configured, skip validation (but warn)
  if (!GRAFANA_WEBHOOK_SECRET) {
    logger.warn("Grafana webhook secret not configured - accepting unauthenticated requests", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "grafana_auth",
        event: "warning"
      }
    });
    return next();
  }
  
  const providedSecret = req.headers['x-webhook-secret'] || req.headers['x-grafana-secret'];
  
  if (!providedSecret || providedSecret !== GRAFANA_WEBHOOK_SECRET) {
    logger.warn("Grafana webhook authentication failed", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "grafana_auth",
        event: "rejected",
        ip_address: req.ip,
        has_secret: !!providedSecret
      }
    });
    
    return res.status(401).json({ error: 'unauthorized' });
  }
  
  next();
}

/**
 * Get or create a daily thread for Grafana alerts
 */
async function getOrCreateDailyGrafanaThread(client, dateKey) {
  if (!INCIDENTS_CHANNEL_ID) {
    throw new Error("INCIDENTS_CHANNEL_ID not set");
  }

  // Reuse cached thread if possible
  const existingId = grafanaDailyThreads.get(dateKey);
  if (existingId) {
    const existingChannel = await client.channels.fetch(existingId).catch(() => null);
    if (existingChannel && existingChannel.isThread()) {
      return existingChannel;
    }
  }

  const incidentsChannel = await client.channels.fetch(INCIDENTS_CHANNEL_ID);
  if (!incidentsChannel || !incidentsChannel.isTextBased()) {
    throw new Error("Incidents channel not found or not text-based");
  }

  // Create a new thread for this date
  const thread = await incidentsChannel.threads.create({
    name: `Grafana alerts – ${dateKey}`,
    autoArchiveDuration: 1440 // 24h
  });

  grafanaDailyThreads.set(dateKey, thread.id);
  return thread;
}

/**
 * Format a Grafana alert message with sanitized inputs
 * @param {Object} payload - Raw Grafana webhook payload
 * @returns {string} Formatted and sanitized message
 */
function formatGrafanaAlertMessage(payload) {
  // Sanitize all user-controllable fields
  const ruleName = sanitize(payload.ruleName || payload.title || 'Unknown rule', 200);
  const state = sanitize(payload.state || payload.status || 'unknown', 50);
  const message = sanitize(payload.message || '', 1000);
  const ruleUrl = sanitize(payload.ruleUrl || payload.dashboardUrl || '', 500);

  let text = `⚠️ **Grafana alert**\n` +
             `**Rule:** ${ruleName}\n` +
             `**State:** ${state}\n`;

  if (message) {
    text += `**Message:** ${message}\n`;
  }
  if (ruleUrl) {
    text += `**Link:** ${ruleUrl}\n`;
  }

  return text;
}

/**
 * Start the Grafana webhook server
 * @param {Client} client - Discord client
 * @param {Function} getActiveSessions - Optional function to get active sessions count
 */
export function startGrafanaWebhookServer(client, getActiveSessions = null) {
  if (!INCIDENTS_CHANNEL_ID) {
    logger.warn("INCIDENTS_CHANNEL_ID not set – Grafana alerts disabled");
    return;
  }

  const app = express();
  app.use(express.json({ limit: '1mb' })); // Limit payload size

  // Apply webhook secret validation to the alert endpoint
  app.post('/grafana-alert', validateWebhookSecret, async (req, res) => {
    const alertEventId = uuidv4();
    const startTime = Date.now();

    try {
      const payload = req.body;
      const now = new Date();
      const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD

      const thread = await getOrCreateDailyGrafanaThread(client, dateKey);
      const text = formatGrafanaAlertMessage(payload);

      await thread.send(text);

      logger.info("Grafana alert forwarded to Discord", {
        extra: {
          footprint: null,
          batch_uuid: null,
          user_id: null,
          event_id: alertEventId,
          action: "grafana_alert",
          event: "complete",
          duration_ms: calculateDurationMs(startTime)
        }
      });

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error("Failed to handle Grafana alert", {
        extra: {
          footprint: null,
          batch_uuid: null,
          user_id: null,
          event_id: alertEventId,
          action: "grafana_alert",
          event: "error",
          duration_ms: calculateDurationMs(startTime)
        }
      }, err);
      res.status(500).json({ error: 'failed' });
    }
  });

  // Enhanced health endpoint with detailed status
  app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    
    const healthInfo = {
      status: 'ok',
      uptime: process.uptime(),
      uptimeFormatted: formatUptime(process.uptime()),
      serverStartTime: serverStartTime?.toISOString() || null,
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
        rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
        external: Math.round(memUsage.external / 1024 / 1024) + ' MB'
      },
      grafana: {
        enabled: !!INCIDENTS_CHANNEL_ID,
        dailyThreadsTracked: grafanaDailyThreads.size
      },
      timestamp: new Date().toISOString()
    };
    
    // Add active sessions if getter is provided
    if (getActiveSessions) {
      try {
        healthInfo.activeSessions = getActiveSessions().length;
      } catch (e) {
        healthInfo.activeSessions = 'unavailable';
      }
    }
    
    res.json(healthInfo);
  });

  grafanaServer = app.listen(GRAFANA_WEBHOOK_PORT, '0.0.0.0', () => {
    serverStartTime = new Date();
    console.log(`📡 Grafana webhook listening on port ${GRAFANA_WEBHOOK_PORT} (all interfaces)`);
    logger.info("Grafana webhook server started", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "grafana_webhook_start",
        event: "start",
        port: GRAFANA_WEBHOOK_PORT,
        bind_address: '0.0.0.0'
      }
    });
  });

  // Handle server errors gracefully (e.g., port already in use)
  grafanaServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Grafana webhook port ${GRAFANA_WEBHOOK_PORT} is already in use`);
      console.error('   Try: fuser -k ' + GRAFANA_WEBHOOK_PORT + '/tcp');
      logger.error(`Grafana webhook server failed - port ${GRAFANA_WEBHOOK_PORT} in use`, {
        extra: {
          footprint: null,
          batch_uuid: null,
          user_id: null,
          event_id: uuidv4(),
          action: "grafana_webhook_start",
          event: "error",
          error_code: err.code,
          port: GRAFANA_WEBHOOK_PORT
        }
      });
    } else {
      console.error('❌ Grafana webhook server error:', err.message);
      logger.error(`Grafana webhook server error: ${err.message}`, {
        extra: {
          footprint: null,
          batch_uuid: null,
          user_id: null,
          event_id: uuidv4(),
          action: "grafana_webhook_start",
          event: "error",
          error_message: err.message
        }
      });
    }
    // Don't crash the bot - Grafana alerts are optional functionality
    console.log('⚠️ Grafana alerts disabled due to server error');
    grafanaServer = null;
  });
}

/**
 * Stop the Grafana webhook server gracefully
 * @returns {Promise<void>}
 */
export function stopGrafanaWebhookServer() {
  return new Promise((resolve) => {
    if (!grafanaServer) {
      resolve();
      return;
    }
    
    console.log('🔌 Stopping Grafana webhook server...');
    
    grafanaServer.close((err) => {
      if (err) {
        console.error('⚠️ Error closing Grafana server:', err.message);
      } else {
        console.log('✅ Grafana webhook server stopped');
      }
      grafanaServer = null;
      resolve();
    });
    
    // Force close after 5 seconds
    setTimeout(() => {
      if (grafanaServer) {
        console.log('⚠️ Force closing Grafana server');
        grafanaServer = null;
        resolve();
      }
    }, 5000);
  });
}

/**
 * Check if Grafana server is running
 * @returns {boolean}
 */
export function isGrafanaServerRunning() {
  return grafanaServer !== null;
}

/**
 * Format uptime in human-readable format
 * @param {number} seconds - Uptime in seconds
 * @returns {string} Formatted uptime string
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  
  return parts.join(' ');
}
