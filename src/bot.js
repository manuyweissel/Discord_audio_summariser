import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';
import {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection
} from '@discordjs/voice';
import prism from 'prism-media';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const openai = new OpenAI(); // uses OPENAI_API_KEY env
const BOT_TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- raw-audio storage ----------
const AUDIO_DIR = path.join(process.cwd(), 'audios');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ---------- simple file logger ----------
const TRANSCRIPT_DIR = path.join(process.cwd(), 'transcripts');
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });

// ---------- summary storage ----------
const SUMMARY_DIR = path.join(process.cwd(), 'summaries');
fs.mkdirSync(SUMMARY_DIR, { recursive: true });

function makeLogFileName(guildId, channelId) {
  // e.g. 2025-04-27T18-45-12
  const ts = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  return path.join(TRANSCRIPT_DIR, `${guildId}-${channelId}-${ts}.log`);
}
const sessionLogs = new Map();

function writeTranscript(guildId, channelId, username, text) {
  const key = `${guildId}:${channelId}`;
  if (!sessionLogs.has(key)) {
    sessionLogs.set(key, makeLogFileName(guildId, channelId));
  }
  const logFile = sessionLogs.get(key);
  const line = `[${new Date().toISOString()}] ${username}: ${text}\n`;
  fs.appendFile(logFile, line, (err) => {
    if (err) console.error('❌ Failed to write transcript:', err);
  });
}

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder().setName('join')
    .setDescription('Join the caller’s voice channel & start transcribing'),
  new SlashCommandBuilder().setName('leave')
    .setDescription('Leave the current voice channel'),
];

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands.map(cmd => cmd.toJSON()) }
    );
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err);
  }
});

// ---------- single-step captureUserAudio ----------
function captureUserAudio(connection, userId) {
  // 1) Start receiving Opus
  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 }
  });

  // 2) Decode to raw 48kHz stereo PCM
  const pcmStream = opusStream.pipe(
    new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960
    })
  );

  // 3) Generate a unique filename
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const wavPath = path.join(AUDIO_DIR, `${ts}-mono.wav`);

  // 4) Pipe raw PCM into ffmpeg, convert to 16kHz mono
  const ff = spawn(ffmpegPath, ['-y',
    '-loglevel', 'error',
    '-f', 's16le',     // input is raw 16-bit PCM
    '-ar', '48000',    // 48k sampling rate
    '-ac', '2',        // stereo
    '-i', 'pipe:0',    // read from stdin

    '-ac', '1',        // convert to mono
    '-ar', '16000',    // 16 kHz
    '-f', 'wav',
    wavPath,           // output file
  ]);

  pcmStream.pipe(ff.stdin);

  return new Promise((resolve, reject) => {
    ff.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exit code ${code}`));
      } else {
        // We have a valid 16 kHz mono WAV at wavPath
        const bytes = fs.existsSync(wavPath)
          ? fs.statSync(wavPath).size
          : 0;
        if (bytes < 16_000) {
          // Less than ~0.2 seconds, skip
          fs.unlinkSync(wavPath);
          resolve(null);
        } else {
          console.log(`📁 saved ${path.basename(wavPath)} (${(bytes/1024).toFixed(1)} kB)`);
          resolve(wavPath);
        }
      }
    });
    ff.on('error', reject);
  });
}

// ---------- simpler transcribeAudio ----------
async function transcribeAudio(wavPath) {
  if (!wavPath) return '';

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: 'whisper-1',
    });
    const text =
      typeof transcription === 'string'
        ? transcription
        : transcription.text ?? '';
    console.log('📝 Whisper →', text || '[empty]');
    return text;
  } catch (err) {
    console.error('❌ Whisper failed:', err.message);
    return '';
  }
}

// ---------- helper to approximate token count ----------
function approximateTokens(str) {
  // Rough approximation: 1 token ~ 4 characters in English
  // (For German or multi-lingual content, still approximate.)
  return Math.ceil(str.length / 4);
}

// ---------- helper to chunk text if it’s too large ----------
function chunkTextByTokens(text, maxTokens = 6000) {
  // We'll chunk by characters, ensuring each chunk ~ maxTokens * 4 characters
  const maxChars = maxTokens * 4;
  const chunks = [];

  let start = 0;
  while (start < text.length) {
    const end = start + maxChars;
    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks;
}

// ---------- summarize Transcript (with chunking if needed) ----------
async function summarizeTranscript(guildId, channelId) {
  const key = `${guildId}:${channelId}`;
  const logFile = sessionLogs.get(key);
  if (!logFile || !fs.existsSync(logFile)) return null;

  const transcript = fs.readFileSync(logFile, 'utf-8');
  if (!transcript.trim()) return null;

  const totalTokens = approximateTokens(transcript);
  console.log(`Transcript is ~${totalTokens} tokens`);

  // If the transcript is short enough, just do a single summarization
  if (totalTokens <= 6000) {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',  // changed to gpt-4o
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that turns raw meeting transcripts into concise "Meeting Protokoll" in German, with timestamps and bullet points.'
        },
        {
          role: 'user',
          content: `Bitte fasse dieses Transkript in ein Meeting-Protokoll zusammen:\n\n${transcript}`
        }
      ]
    });

    return completion.choices[0].message.content.trim();

  } else {
    // Otherwise we chunk the transcript, summarize each chunk, then do a final summary
    console.log('Transcript is too large; chunking...');
    const textChunks = chunkTextByTokens(transcript, 6000);
    const partialSummaries = [];

    // Summarize each chunk
    for (let i = 0; i < textChunks.length; i++) {
      const chunk = textChunks[i];
      console.log(`Summarizing chunk ${i + 1} of ${textChunks.length}...`);

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o', 
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that turns raw meeting transcripts into concise "Meeting Protokoll" in German, with timestamps and bullet points.'
          },
          {
            role: 'user',
            content: `Hier ist ein Teil des Transkripts. Bitte fasse diesen Abschnitt zusammen:\n\n${chunk}`
          }
        ]
      });

      const partialSummary = completion.choices[0].message.content.trim();
      partialSummaries.push(partialSummary);
    }

    // Now do a final summarization of the partial summaries
    console.log('Performing a final summary of all partial summaries...');
    const finalInput = partialSummaries.join('\n\n---\n\n');

    const finalCompletion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that combines partial meeting transcripts into one concise final "Meeting Protokoll" in German, with timestamps and bullet points.'
        },
        {
          role: 'user',
          content: `Bitte fasse alle diese Teil-Zusammenfassungen nun in ein einzelnes Meeting-Protokoll zusammen:\n\n${finalInput}`
        }
      ]
    });

    return finalCompletion.choices[0].message.content.trim();
  }
}

// ---------- main logic ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'join') {
    const channel = interaction.member.voice?.channel;
    if (!channel) {
      return interaction.reply({ content: 'Jump into a voice channel first!', ephemeral: true });
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    interaction.reply(`🎙️ Transcriber online in **${channel.name}**. Speak and I’ll type!`);
    
    connection.receiver.speaking.on('start', async (userId) => {
      try {
        // 1) Capture user audio -> 16kHz WAV
        const wavPath = await captureUserAudio(connection, userId);
        if (!wavPath) return;

        // 2) Transcribe
        const text = await transcribeAudio(wavPath);
        if (text?.trim()) {
          const username = await interaction.guild.members
            .fetch(userId)
            .then(u => u.displayName)
            .catch(() => 'Someone');

          // 3) Post log
          writeTranscript(interaction.guild.id, channel.id, username, text);
        }
      } catch (err) {
        console.error(err);
      }
    });
  }

  if (interaction.commandName === 'leave') {
    // 1) Grab and destroy the voice connection
    const conn = getVoiceConnection(interaction.guild.id);
    if (!conn) {
      return interaction.reply({ content: 'I’m not in a voice channel right now.', ephemeral: true });
    }
    const voiceChannelId = conn.joinConfig.channelId;
    conn.destroy();
  
    // 2) Summarize the transcript file for that voice channel
    let summary = null;
    try {
      summary = await summarizeTranscript(interaction.guild.id, voiceChannelId);
    } catch (err) {
      console.error('❌ Failed to summarise transcript:', err);
    }
  
    // 3) Clear that log entry so a future /join starts fresh
    sessionLogs.delete(`${interaction.guild.id}:${voiceChannelId}`);
  
    // 4) If we have a summary, save it and reply; otherwise fallback
    if (summary) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('-');
      const fname = `${interaction.guild.id}-${voiceChannelId}-${ts}.txt`;
      const outPath = path.join(SUMMARY_DIR, fname);
  
      fs.writeFileSync(outPath, summary, 'utf-8');
      console.log(`🗄️ saved summary to ${outPath}`);
  
      await interaction.reply({
        content: `📝 **Meeting Protokoll** saved to \`summary/${fname}\`:\n\n${summary}`
      });
    } else {
      await interaction.reply('Disconnected. No transcript found or nothing to summarise.');
    }
  }
});

client.login(BOT_TOKEN);
