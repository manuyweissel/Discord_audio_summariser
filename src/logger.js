import { createLogger, format, transports } from 'winston';

// ---------- Logging Setup ----------
export const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ level, message, timestamp, extra }) => {
      if (extra) {
        return `${timestamp} [${level.toUpperCase()}] ${message} | ${extra.action}:${extra.event}`;
      }
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({
      filename: 'discord-bot.log',
      format: format.combine(
        format.timestamp(),
        format.json()
      )
    })
  ]
});

export default logger;
