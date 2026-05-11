# Discord Voice Summariser Bot

A Python-first Discord bot that joins a voice channel, captures speaker audio through a DAVE-capable helper process, transcribes the captured WAV segments with OpenAI, and produces a German meeting summary as a `.docx` file on `/leave`.

## Architecture

- `summarise_bot/`
  Python control plane for Discord slash commands, transcript writing, manifest/recovery, OpenAI transcription and summary generation, weekly reminders, and the shared ops server for `/health` plus `/grafana-alert`.
- `voice_helper/`
  Dedicated helper subprocess for Discord voice transport, DAVE session handling, Opus decode, speaker segmentation, WAV writing, and crash-safe spool creation.
- `src/`
  Archived Node implementation kept only as reference material while the Python runtime replaces it.

## Core Behavior

- `/join`
  The bot joins the caller's voice channel, opens a Discord voice session, and starts the helper-backed capture pipeline.
- `/leave`
  The bot flushes pending audio, waits for remaining transcriptions, builds a transcript if needed, generates a German meeting summary, and uploads a `.docx`.
- Crash-safe capture
  Each finished audio segment is written to `audios/` and mirrored to `data/voice_capture_spool/` before ingestion, so already-flushed audio survives restarts.
- Operational endpoints
  The Python runtime serves both `GET /health` and `POST /grafana-alert` on the same aiohttp server.
- Weekly reminder
  The bot posts the weekly prep reminder every Thursday at 09:00 in the configured timezone.

## Output Paths

- `audios/`
  Captured WAV segments.
- `transcripts/`
  Session transcript logs in `[ISO_TIMESTAMP] DisplayName: text` format.
- `summaries/`
  Final meeting minutes as `.docx`.
- `data/audio_manifest.json`
  Session and audio-entry state.
- `data/voice_capture_spool/`
  Pending segment records waiting to be ingested.

## Requirements

- Python 3.12 or newer
- A Discord bot token with `applications.commands`, `Connect`, `Speak`, and `View Channels`
- An OpenAI API key with Whisper and chat-model access
- A working Opus runtime on the host

## Setup

1. Create the dedicated virtual environment:

```bash
python3 -m venv .voice-worker-venv
./.voice-worker-venv/bin/pip install -r requirements.txt
```

2. Create `.env` in the project root:

```env
DISCORD_TOKEN=your_discord_bot_token
OPENAI_API_KEY=your_openai_api_key
TIMEZONE=Europe/Berlin
WEEKLY_MEETING_CHANNEL_ID=1234567890123456789
INCIDENTS_CHANNEL_ID=987654321098765432
GRAFANA_WEBHOOK_SECRET=your_shared_secret
```

Optional when you want the bot to launch the helper with another interpreter:

```env
VOICE_HELPER_PATH=/absolute/path/to/python
```

Optional when you need to tune the DAVE receive path during live debugging:

```env
VOICE_PACKET_QUEUE_LIMIT=256
VOICE_MEDIA_PAUSE_MS=750
VOICE_STATS_EMIT_INTERVAL_MS=5000
VOICE_HELPER_DEBUG_TRACE_SESSION_ID=*
```

3. Start the Python runtime:

```bash
./.voice-worker-venv/bin/python -m summarise_bot
```

For convenience, `npm start` now launches the same Python entrypoint:

```bash
npm start
```

## Commands

- `/join`
  Start a meeting capture session in the caller's current voice channel.
- `/leave`
  Stop capture, finish transcription, and post the generated meeting minutes file.

## Testing

Run the Python runtime and helper tests:

```bash
npm test
```

Run only the Python tests:

```bash
./.voice-worker-venv/bin/python -m unittest discover -s tests_python -p 'test_*.py'
```

## Runtime Surface

The Python rewrite now owns:

- Discord login and slash commands
- Voice join/leave orchestration
- DAVE-capable voice helper supervision
- Segment spool/replay recovery
- Whisper transcription
- German summary generation
- DOCX export
- `/health` and `/grafana-alert`
- Weekly reminder scheduling

The old Node runtime is no longer the supported implementation path.
