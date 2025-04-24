# Discord Voice Summarizer Bot 📝🎙️

_A lightweight Discord bot that turns spontaneous voice chats into structured German **Meeting‑Protokolle**._

---

## 📚 Table of Contents
1. [Features](#features)
2. [Requirements](#requirements)
3. [Project Setup](#project-setup)
   1. [Install Dependencies](#install-dependencies)
   2. [Create a .env File](#create-a-env-file)
   3. [Configure OAuth2 & Invite](#configure-oauth2--invite)
   4. [Run the Bot](#run-the-bot)
4. [How It Works](#how-it-works)
   1. [Voice Capture](#voice-capture)
   2. [Transcription](#transcription)
   3. [Storing Transcripts](#storing-transcripts)
   4. [Summary Generation](#summary-generation)
5. [Local Files](#local-files)
6. [Usage](#usage)
   1. [Join a Voice Channel](#join-a-voice-channel)
   2. [Leave](#leave)
7. [FAQ](#faq)
8. [Contributing](#contributing)
9. [License](#license)

---

## ✨ Features

| Capability | Description |
|------------|-------------|
| **Voice→Text** | Captures voice‑channel audio → resamples to **16 kHz mono WAV** with FFmpeg → sends to **OpenAI Whisper** for transcription. |
| **Transcript Logging** | Per‑session log of _who_ said _what_ with timestamps. |
| **Automatic Summaries** | On `/leave`, calls **GPT** to produce a bullet‑point German “Meeting Protokoll” (with timestamps). |
| **Local Storage** | Saves raw audio, transcripts, and summaries to `audios/`, `transcripts/`, and `summaries/`. |

---

## 📦 Requirements

1. **Node.js ≥ 18** (ESM support & modern libs)
2. **FFmpeg**
   * **Windows** – [Download builds](https://ffmpeg.org/download.html)
   * **macOS** – `brew install ffmpeg`
   * **Linux** – `sudo apt install ffmpeg`
3. **Discord Bot Token** (⁠Create in [Developer Portal](https://discord.com/developers/applications) & enable **Message Content** + **Server Members** intents.)
4. **OpenAI API Key** (with Whisper + Chat models access)

> **Tip:** Keep secret keys out of version control — store them in `.env`.

---

## 🚀 Project Setup

### 1️⃣ Install Dependencies
```bash
npm install
```

### 2️⃣ Create a `.env` File
```bash
DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
OPENAI_API_KEY=YOUR_OPENAI_API_KEY
```

### 3️⃣ Configure OAuth2 & Invite
1. In **Developer Portal → OAuth2 → URL Generator**:
   * Scopes → `bot`, `applications.commands`
   * Bot Permissions → `View Channels`, `Send Messages`, `Read Message History`, `Connect`, `Speak`
2. Copy the generated URL ➜ open in browser ➜ choose server ➜ **Authorize**.

### 4️⃣ Run the Bot
```bash
npm start
```
You should see:
```text
Logged in as YourBotName#1234
✅ Slash commands registered
```

---

## ⚙️ How It Works

### Voice Capture
`/join` ➜ bot subscribes to the voice channel and captures raw opus packets.

### Transcription
Audio segments → FFmpeg (16 kHz mono) → **OpenAI Whisper** ➜ text.

### Storing Transcripts
Each user’s speech is appended to `transcripts/<guildId>-<channelId>-<timestamp>.log`.

### Summary Generation
On `/leave`, the bot feeds the full transcript to **Chat Completion** (e.g. `gpt‑4o`) → outputs a concise German bullet‑list with timestamps.

---

## 🗂️ Local Files
```
audios/      # Intermediate 16 kHz WAVs
transcripts/ # Full raw text logs
summaries/   # Final Meeting‑Protokolle
```

---

## 🎮 Usage

### Join a Voice Channel
1. Join the voice channel you want recorded.
2. In any text channel, type `/join`.
3. Bot enters & starts transcribing.

### Leave
1. Type `/leave`.
2. Bot exits, auto‑summarizes, posts the summary, and stores it in `summaries/`.

---

## ❓ FAQ

<details>
<summary>Where do audio & logs go?</summary>
By default: `audios/`, `transcripts/`, `summaries/`.
</details>

<details>
<summary>Why German summaries?</summary>
The default system prompt is German. Tweak it for any language or style.
</details>

<details>
<summary>“Whisper failed” errors?</summary>
Check your OpenAI key, Whisper quota, or rate limits.
</details>

<details>
<summary>Can I use GPT‑3.5 or GPT‑4?</summary>
Absolutely — replace `gpt‑4o` with the model available to you.
</details>

---

## 🤝 Contributing
Pull requests are welcome! For major changes, open an issue first to discuss the proposal.

---

## 📝 License
Released under the **MIT License** — happy hacking!

