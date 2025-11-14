# Environment Variables Setup

This document describes all environment variables required for the Discord voice bot.

## Required Variables

### DISCORD_TOKEN
**Required**: Yes  
**Description**: Your Discord bot token from the Discord Developer Portal.  
**Example**: `DISCORD_TOKEN=your_discord_bot_token_here`

### OPENAI_API_KEY
**Required**: Yes  
**Description**: Your OpenAI API key for Whisper transcription and GPT-4 summarization.  
**Example**: `OPENAI_API_KEY=sk-...`

## Optional Variables

### WEEKLY_MEETING_CHANNEL_ID
**Required**: No  
**Description**: Discord channel ID for weekly meeting reminders. The bot will post a reminder every Thursday at 09:00 (Europe/Berlin timezone).  
**How to get**: Right-click on the channel > Copy ID (requires Developer Mode enabled in Discord settings)  
**Example**: `WEEKLY_MEETING_CHANNEL_ID=1234567890123456789`

**Note**: If not set, weekly reminders will be disabled.

### INCIDENTS_CHANNEL_ID
**Required**: No  
**Description**: Discord channel ID for Grafana alerts. The bot will create one thread per day for all alerts.  
**How to get**: Right-click on the channel > Copy ID (requires Developer Mode enabled in Discord settings)  
**Example**: `INCIDENTS_CHANNEL_ID=1234567890123456789`

**Note**: If not set, Grafana alerts will be disabled.

### TIMEZONE
**Required**: No  
**Description**: Timezone for cron scheduling (affects weekly reminder timing).  
**Default**: `Europe/Berlin`  
**Example**: `TIMEZONE=America/New_York`

### GRAFANA_WEBHOOK_PORT
**Required**: No  
**Description**: Port number for the Grafana webhook HTTP server.  
**Default**: `3000`  
**Example**: `GRAFANA_WEBHOOK_PORT=3000`

## Setup Instructions

1. Create a `.env` file in the project root directory
2. Copy the variables you need from the examples above
3. Replace the placeholder values with your actual values
4. Restart the bot

## Example .env File

```env
# Required
DISCORD_TOKEN=your_discord_bot_token_here
OPENAI_API_KEY=sk-your-openai-key-here

# Optional - Weekly Meeting Reminders
WEEKLY_MEETING_CHANNEL_ID=1234567890123456789
TIMEZONE=Europe/Berlin

# Optional - Grafana Integration
INCIDENTS_CHANNEL_ID=9876543210987654321
GRAFANA_WEBHOOK_PORT=3000
```

## Features Enabled by Optional Variables

### Weekly Meeting Reminders
When `WEEKLY_MEETING_CHANNEL_ID` is set, the bot will:
- Post a reminder every Thursday at 09:00 (in the configured timezone)
- Include a link to the shared Google Doc for agenda items
- Log all reminder activities

### Grafana Integration
When `INCIDENTS_CHANNEL_ID` is set, the bot will:
- Start an HTTP server on the configured port (default: 3000)
- Accept webhook POST requests at `/grafana-alert`
- Create one thread per day (named "Grafana alerts – YYYY-MM-DD")
- Post all alerts for that day into the same thread
- Provide a `/health` endpoint for monitoring

## Grafana Configuration

To send alerts from Grafana to Discord:

1. In Grafana, create a **Contact point** of type **Webhook**
2. Set the URL to: `http://your-server:3000/grafana-alert`
3. Attach this contact point to your alerting rules
4. Alerts will automatically appear in the configured Discord channel

## Testing

### Test Weekly Reminder
Temporarily change the cron schedule in the code to test:
```javascript
// Change from '0 9 * * 4' to '* * * * *' (every minute)
cron.schedule('* * * * *', async () => { ... });
```

### Test Grafana Webhook
Send a manual test request:
```bash
curl -X POST http://localhost:3000/grafana-alert \
  -H "Content-Type: application/json" \
  -d '{"ruleName":"Test rule","state":"firing","message":"Something is wrong"}'
```

### Check Health Endpoint
```bash
curl http://localhost:3000/health
```

## Troubleshooting

### Missing Channel IDs
If you see warnings about missing channel IDs:
1. Enable Developer Mode in Discord (User Settings > Advanced > Developer Mode)
2. Right-click on the desired channel
3. Select "Copy ID"
4. Add the ID to your `.env` file

### Grafana Alerts Not Working
1. Check that `INCIDENTS_CHANNEL_ID` is set
2. Verify the webhook URL is accessible from Grafana
3. Check the bot logs for error messages
4. Ensure the bot has permissions to create threads in the channel

### Weekly Reminders Not Working
1. Check that `WEEKLY_MEETING_CHANNEL_ID` is set
2. Verify the timezone is correct
3. Check bot logs for scheduler initialization
4. Test with a more frequent cron schedule

