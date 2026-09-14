# Environment Variables Setup

This document describes the environment variables used by the Python-first Discord summariser bot.

## Required Variables

### `DISCORD_TOKEN`
- Required: yes
- Description: Discord bot token from the Discord Developer Portal.

### `OPENAI_API_KEY`
- Required: yes
- Description: OpenAI API key used for Whisper transcription and summary generation.

## Automatic Meeting Recording

The bot joins the meeting voice channel on a schedule, records, and posts the minutes to a
per-meeting text channel. It waits for a person to be present before joining, so an empty room
is never recorded and a meeting that starts late is still captured from the moment it begins.

### `AUTO_JOIN_ENABLED`
Default `true`. Set to `false` to go back to manual `/join` only.

### `AUTO_JOIN_VOICE_CHANNEL_ID`
Default `1361316314999816252` (`team-meetings`). The voice channel to join.

### `AUTO_JOIN_SCHEDULE`
Windows in local time (`TIMEZONE`), as `<days> <start>-<end> -> <text channel id>`, separated
by `;`. Days accept names (`thu`), ranges (`mon-fri`) and lists (`mon,wed,fri`). The channel id
is where that meeting's minutes are posted. End times are exclusive.

Default:
```
mon-fri 09:00-10:00 -> 1364921683936284734;   # daily-standup
thu 11:00-12:00 -> 1473976066052984967;       # biweekly-research-meeting
thu 15:00-16:00 -> 1438825022377562122        # weekly-meeting
```
(written on one line, without the comments)

### `AUTO_JOIN_POLL_SECONDS`
Default `30`. How often the scheduler re-checks the window and the channel.

### `AUTO_LEAVE_EMPTY_SECONDS`
Default `120`. Once no person is left in the voice channel for this long, the bot stops
recording and posts the minutes — for scheduled and manual `/join` sessions alike (a manual
session posts to the channel `/join` was run in). The delay keeps a dropped connection or a quick
rejoin from splitting one meeting into two sets of minutes. `0` disables it.

### `AUTO_POST_MIN_CHARS`
Default `500`. A session the bot ends on its own (window end or empty channel) is only turned into
minutes when, after filtering, it contains at least this many characters of speech. Across 124 past
transcripts every session under ~320 characters was a test or a drop-in hello, and real meetings
start around 600. Shorter sessions keep their transcript on disk but post nothing. A manual
`/leave` always produces minutes. `0` disables the check.

## Core Optional Variables

### `TIMEZONE`
- Required: no
- Default: `Europe/Berlin`
- Description: Timezone used for timestamps and operational logs.

### `VOICE_CAPTURE_AUDIO_DIR`
- Required: no
- Default: `audios/`
- Description: Directory for persisted WAV segments.

### `TRANSCRIPT_DIR`
- Required: no
- Default: `transcripts/`
- Description: Directory for transcript log files.

### `SUMMARY_DIR`
- Required: no
- Default: `summaries/`
- Description: Directory for generated `.docx` meeting summaries.

### `DATA_DIR`
- Required: no
- Default: `data/`
- Description: Root data directory used for the manifest and spool.

### `VOICE_CAPTURE_SPOOL_DIR`
- Required: no
- Default: `data/voice_capture_spool/`
- Description: Directory for crash-safe pending segment JSON records.

### `MANIFEST_PATH`
- Required: no
- Default: `data/audio_manifest.json`
- Description: Path to the persisted audio/session manifest.

### `VOICE_HELPER_PATH`
- Required: no
- Default: unset
- Description: Python interpreter used to launch `voice_helper.main`. Leave unset when you start the bot from the same virtual environment that has the helper dependencies installed.

### `VOICE_HELPER_STARTUP_TIMEOUT_MS`
- Required: no
- Default: `30000`
- Description: Maximum time to wait for the helper subprocess to announce readiness.

### `VOICE_SEGMENT_SILENCE_MS`
- Required: no
- Default: `2000`
- Description: Silence threshold before a speaker segment is flushed.

### `VOICE_MAX_SEGMENT_MS`
- Required: no
- Default: `30000`
- Description: Maximum duration for a single speaker segment before it is forced to flush.

### `VOICE_PACKET_QUEUE_LIMIT`
- Required: no
- Default: `256`
- Description: Maximum number of RTP frames buffered per SSRC while waiting for speaker mapping or DAVE decryptor readiness.

### `VOICE_MEDIA_PAUSE_MS`
- Required: no
- Default: `750`
- Description: Short backoff window used after DAVE transition/decrypt failures before queued frames are retried.

### `VOICE_STATS_EMIT_INTERVAL_MS`
- Required: no
- Default: `5000`
- Description: Interval for helper session metric snapshots that feed `/health` and leave-session summaries.

### `VOICE_HELPER_DEBUG_TRACE_SESSION_ID`
- Required: no
- Default: unset
- Description: Set to a specific session id, or `*`, to emit verbose helper stats snapshots for live debugging.

### `HEALTH_PORT`
- Required: no
- Default: `3002`
- Description: Port used by the shared aiohttp ops server for both `/health` and `/grafana-alert`.

### `GRAFANA_WEBHOOK_PORT`
- Required: no
- Default: falls back to `3002`
- Description: Backward-compatible alias for `HEALTH_PORT`. The Python runtime listens on one shared port for both `/health` and `/grafana-alert`.

### `GRAFANA_WEBHOOK_SECRET`
- Required: no
- Default: unset
- Description: Shared secret for `POST /grafana-alert`. When set, requests must include `x-webhook-secret` or `x-grafana-secret`.

### `RECOVERY_INTERVAL_MS`
- Required: no
- Default: `1800000`
- Description: Interval between background recovery passes for pending spool and manifest work.

### `STALE_SESSION_HOURS`
- Required: no
- Default: `2`
- Description: Age after which an unfinished session is marked for recovery on restart.

### `CIRCUIT_BREAKER_THRESHOLD`
- Required: no
- Default: `5`
- Description: Number of consecutive summary-generation failures before the circuit breaker opens temporarily.

### `CIRCUIT_BREAKER_TIMEOUT`
- Required: no
- Default: `60000`
- Description: Time in milliseconds before the summary circuit breaker allows requests again.

### `WEEKLY_MEETING_CHANNEL_ID`
- Required: no
- Default: unset
- Description: Discord text-channel ID that receives the Thursday 09:00 weekly prep reminder.

### `INCIDENTS_CHANNEL_ID`
- Required: no
- Default: unset
- Description: Discord text-channel ID where Grafana alert threads are created.

## Deprecated Compatibility Variables

These are still accepted for compatibility with the previous split Node/Python worker rollout:

### `VOICE_WORKER_PYTHON`
- Alias for `VOICE_HELPER_PATH`.

### `VOICE_WORKER_SEGMENT_SILENCE_MS`
- Alias for `VOICE_SEGMENT_SILENCE_MS`.

### `VOICE_WORKER_MAX_SEGMENT_MS`
- Alias for `VOICE_MAX_SEGMENT_MS`.

### `VOICE_BACKEND`
- Ignored by the Python runtime.
- Still used only by the legacy Node implementation in `src/`.

## Legacy Node-Only Variables

These variables belong to the old Node runtime and are not active in the Python-first bot:

- `VOICE_READY_TIMEOUT_MS`
- `VOICE_READY_GRACE_TIMEOUT_MS`
- `VOICE_CONNECT_MAX_ATTEMPTS`
- `VOICE_CONNECT_RETRY_DELAY_MS`
- `VOICE_SIGNAL_RECOVERY_TIMEOUT_MS`
- `DISCORD_SESSION_REFRESH_COOLDOWN_MS`
- `VOICE_CONNECT_FALLBACK_UNMUTE`
- `DISCORD_BOT_SELF_MUTE`
- `STALE_REMOTE_VOICE_RESET_DELAY_MS`

## Setup Instructions

1. Create the dedicated virtual environment:

```bash
python3 -m venv .voice-worker-venv
./.voice-worker-venv/bin/pip install -r requirements.txt
```

2. Create `.env` in the repository root:

```env
DISCORD_TOKEN=your_discord_bot_token_here
OPENAI_API_KEY=sk-your-openai-key-here
TIMEZONE=Europe/Berlin
WEEKLY_MEETING_CHANNEL_ID=1234567890123456789
INCIDENTS_CHANNEL_ID=9876543210987654321
GRAFANA_WEBHOOK_SECRET=your_secure_random_string_here
VOICE_SEGMENT_SILENCE_MS=2000
VOICE_MAX_SEGMENT_MS=30000
HEALTH_PORT=3002
```

3. Start the bot:

```bash
./.voice-worker-venv/bin/python -m summarise_bot
```

## Ops Endpoints

The Python runtime exposes both health and Grafana endpoints:

```bash
curl http://localhost:3002/health
```

```bash
curl -X POST http://localhost:3002/grafana-alert \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: your_secret_here" \
  -d '{"ruleName":"Test rule","state":"firing","message":"Something is wrong"}'
```

## Troubleshooting

### Helper startup fails immediately

- Verify the virtual environment exists.
- Reinstall dependencies with `./.voice-worker-venv/bin/pip install -r requirements.txt`.
- If you use `VOICE_HELPER_PATH`, verify it points to a real Python interpreter.

### `/join` responds but capture does not start

- Check `discord-bot.log` for `voice_join` or `voice_helper` errors.
- Confirm the bot has permission to join the target voice channel.
- Confirm the helper can start standalone:

```bash
printf '%s\n%s\n' '{"requestId":"1","type":"ready_check","payload":{}}' '{"requestId":"2","type":"shutdown","payload":{}}' \
  | ./.voice-worker-venv/bin/python -m voice_helper.main
```
