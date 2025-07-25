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
import { createLogger, format, transports } from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from 'docx';

// ---------- Logging Setup ----------
const logger = createLogger({
  level: 'info', // Changed from debug to reduce verbosity
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ level, message, timestamp, extra }) => {
      // Simplified console format
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

// Helper function to calculate duration
function calculateDurationMs(startTime) {
  return Date.now() - startTime;
}

// Helper function to create professional Word document
async function convertToWordDoc(content, meetingTitle = "Meeting") {
  try {
    const currentDate = new Date().toLocaleDateString('de-DE');
    const timestamp = new Date().toLocaleString('de-DE');
    
    // Parse content to extract structured information
    const lines = content.split('\n');
    const docElements = [];
    
    // Document title
    docElements.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "Meeting Minutes",
            bold: true,
            size: 28,
            color: "1E40AF"
          })
        ],
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.LEFT,
        spacing: { after: 200 }
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: `${meetingTitle} • ${currentDate}`,
            size: 18,
            color: "64748B"
          })
        ],
        alignment: AlignmentType.LEFT,
        spacing: { after: 400 }
      })
    );
    
    // Process content
    let currentSection = "";
    let inTable = false;
    let tableRows = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.startsWith('##')) {
        // Finish any open table
        if (inTable && tableRows.length > 0) {
          docElements.push(createWordTable(tableRows));
          tableRows = [];
          inTable = false;
        }
        
        // Section heading
        const headingText = line.replace(/^##\s*/, '').replace(/\*\*/g, '').replace(/🏢|👥|🎯|📊|📝|🗓️|⚠️|📋/g, '').trim();
        docElements.push(
          new Paragraph({
            children: [
              new TextRun({
                text: headingText,
                bold: true,
                size: 20,
                color: "1E40AF"
              })
            ],
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 300, after: 150 }
          })
        );
      } else if (line.startsWith('###')) {
        // Subsection heading
        const headingText = line.replace(/^###\s*/, '').replace(/\*\*/g, '').replace(/🏢|👥|🎯|📊|📝|🗓️|⚠️|📋/g, '').trim();
        docElements.push(
          new Paragraph({
            children: [
              new TextRun({
                text: headingText,
                bold: true,
                size: 16,
                color: "1E293B"
              })
            ],
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 }
          })
        );
      } else if (line.includes('|') && line.includes('-')) {
        // Table header separator - start table
        inTable = true;
      } else if (line.includes('|') && inTable) {
        // Table row
        const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell);
        if (cells.length > 0) {
          tableRows.push(cells);
        }
      } else if (line.includes('|') && !inTable) {
        // Simple table row (start new table)
        const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell);
        if (cells.length > 0) {
          tableRows = [cells];
          inTable = true;
        }
      } else if (line && !inTable) {
        // Regular paragraph
        if (line.startsWith('- ') || line.startsWith('* ')) {
          // Bullet point
          const bulletText = line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').replace(/🏢|👥|🎯|📊|📝|🗓️|⚠️|📋|✅|❌|🟢|🟡|🔴|⚪|🔥/g, '').trim();
          docElements.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `• ${bulletText}`,
                  size: 20,
                  color: "1E293B"
                })
              ],
              spacing: { after: 80 }
            })
          );
        } else if (line.startsWith('>')) {
          // Quote/Note
          const quoteText = line.replace(/^>\s*/, '').replace(/\*\*/g, '');
          docElements.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: quoteText,
                  italic: true,
                  size: 20,
                  color: "6B7280"
                })
              ],
              spacing: { after: 150 }
            })
          );
        } else if (line.length > 0 && !line.startsWith('<') && !line.includes('<!--')) {
          // Regular text
          const cleanText = line.replace(/\*\*/g, '').replace(/📋|📅|👥|🎯|📊|⚠️|✅|❌|🟢|🟡|🔴|⚪|🔥/g, '').trim();
          if (cleanText.trim()) {
            docElements.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: cleanText,
                    size: 20,
                    color: "1E293B"
                  })
                ],
                spacing: { after: 100 }
              })
            );
          }
        }
      } else if (!line && inTable && tableRows.length > 0) {
        // End of table
        docElements.push(createWordTable(tableRows));
        tableRows = [];
        inTable = false;
      }
    }
    
    // Handle any remaining table
    if (inTable && tableRows.length > 0) {
      docElements.push(createWordTable(tableRows));
    }
    
    // Footer
    docElements.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Generated automatically • ${timestamp}`,
            size: 16,
            color: "64748B",
            italics: true
          })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { before: 400 }
      })
    );
    
    // Create document
    const doc = new Document({
      sections: [{
        children: docElements,
        properties: {
          page: {
            margin: {
              top: 1440,    // 1 inch
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
      }],
    });
    
    return await Packer.toBuffer(doc);
  } catch (error) {
    console.error('Failed to convert to Word:', error);
    return null;
  }
}

// Helper function to create Word table
function createWordTable(rows) {
  if (!rows || rows.length === 0) return new Paragraph({ children: [] });
  
  const tableRows = rows.map((row, index) => {
    const cells = row.map(cellText => {
      const cleanText = cellText.replace(/\*\*/g, '').replace(/🟢|🟡|🔴|⚪|🔥|📋|📅|👥|🎯|📊|⚠️|✅|❌/g, '').trim();
      
      return new TableCell({
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: cleanText,
                bold: index === 0, // Header row
                size: index === 0 ? 18 : 16,
                color: index === 0 ? "FFFFFF" : "1E293B"
              })
            ],
            alignment: AlignmentType.LEFT
          })
        ],
        shading: {
          fill: index === 0 ? "1E40AF" : (index % 2 === 0 ? "F8FAFC" : "FFFFFF")
        },
        margins: {
          top: 200,
          bottom: 200,
          left: 300,
          right: 300,
        }
      });
    });
    
    return new TableRow({
      children: cells
    });
  });
  
  return new Table({
    rows: tableRows,
    width: {
      size: 100,
      type: WidthType.PERCENTAGE,
    },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      left: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      right: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" },
    },
  });
}

// Helper function to wait for all transcriptions to complete
async function waitForPendingTranscriptions(sessionId, maxWaitTime = 45000) {
  const startTime = Date.now();
  const checkInterval = 2000; // Check every 2 seconds
  let lastLogTime = 0;
  const logInterval = 5000; // Log every 5 seconds
  
  while (Date.now() - startTime < maxWaitTime) {
    const pending = pendingTranscriptions.get(sessionId);
    if (!pending || pending.size === 0) {
      console.log('✅ All transcriptions completed');
      return true; // All transcriptions complete
    }
    
    // Only log every few seconds to avoid spam
    const now = Date.now();
    if (now - lastLogTime > logInterval) {
      console.log(`⏳ Waiting for ${pending.size} transcription(s) to complete...`);
      lastLogTime = now;
    }
    
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  // Timeout reached - give extra time for remaining transcriptions
  const remaining = pendingTranscriptions.get(sessionId)?.size || 0;
  if (remaining > 0) {
    console.log(`⚠️ Timeout reached: ${remaining} transcription(s) still pending. Giving extra time...`);
    
    // Give an additional 30 seconds for remaining transcriptions
    const extraWaitTime = 30000;
    const extraStartTime = Date.now();
    
    while (Date.now() - extraStartTime < extraWaitTime) {
      const stillPending = pendingTranscriptions.get(sessionId);
      if (!stillPending || stillPending.size === 0) {
        console.log('✅ All remaining transcriptions completed during extra time');
        return true;
      }
      
      if (Date.now() - lastLogTime > logInterval) {
        console.log(`⏳ Extra time: ${stillPending.size} transcription(s) still processing...`);
        lastLogTime = Date.now();
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    const finalRemaining = pendingTranscriptions.get(sessionId)?.size || 0;
    if (finalRemaining > 0) {
      console.log(`⚠️ Final timeout: ${finalRemaining} transcription(s) could not complete. Proceeding anyway...`);
    }
  }
  return false;
}

// ---------- Environment and API Setup ----------
const openai = new OpenAI(); // uses OPENAI_API_KEY env
const BOT_TOKEN = process.env.DISCORD_TOKEN;

// Log startup configuration
const startupEventId = uuidv4();
logger.info("Bot startup initiated", {
  extra: {
    footprint: null,
    batch_uuid: startupEventId,
    user_id: null,
    event_id: uuidv4(),
    action: "bot_startup",
    event: "start"
  }
});

// Validate environment variables
if (!BOT_TOKEN) {
  logger.error("Missing DISCORD_TOKEN environment variable", {
    extra: {
      footprint: null,
      batch_uuid: startupEventId,
      user_id: null,
      event_id: uuidv4(),
      action: "bot_startup",
      event: "error"
    }
  });
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  logger.error("Missing OPENAI_API_KEY environment variable", {
    extra: {
      footprint: null,
      batch_uuid: startupEventId,
      user_id: null,
      event_id: uuidv4(),
      action: "bot_startup",
      event: "error"
    }
  });
  process.exit(1);
}

// Test OpenAI API key validity at startup
async function validateOpenAIKey() {
  const validationEventId = uuidv4();
  const startTime = Date.now();
  
  logger.debug("Validating OpenAI API key", {
    extra: {
      footprint: null,
      batch_uuid: startupEventId,
      user_id: null,
      event_id: validationEventId,
      action: "openai_validation",
      event: "start"
    }
  });

  try {
    // Test with a minimal API call to check key validity and billing status
    const models = await openai.models.list();
    
    logger.info("OpenAI API key validation successful", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: validationEventId,
        action: "openai_validation",
        event: "complete",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    
    return true;
  } catch (error) {
    logger.error("OpenAI API key validation failed", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: validationEventId,
        action: "openai_validation",
        event: "error",
        duration_ms: calculateDurationMs(startTime),
        error_type: error.constructor.name,
        error_message: error.message,
        error_code: error.code,
        error_status: error.status
      }
    });
    
    // Check for common API key issues
    if (error.status === 401) {
      logger.error("Invalid OpenAI API key - check your OPENAI_API_KEY environment variable", {
        extra: {
          footprint: null,
          batch_uuid: startupEventId,
          user_id: null,
          event_id: uuidv4(),
          action: "openai_validation",
          event: "error"
        }
      });
    } else if (error.status === 429) {
      logger.error("OpenAI API rate limit exceeded or insufficient credits", {
        extra: {
          footprint: null,
          batch_uuid: startupEventId,
          user_id: null,
          event_id: uuidv4(),
          action: "openai_validation",
          event: "error"
        }
      });
    } else if (error.code === 'insufficient_quota') {
      logger.error("OpenAI API quota exceeded - please add credits to your account", {
        extra: {
          footprint: null,
          batch_uuid: startupEventId,
          user_id: null,
          event_id: uuidv4(),
          action: "openai_validation",
          event: "error"
        }
      });
    }
    
    return false;
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- Storage Setup ----------
const AUDIO_DIR = path.join(process.cwd(), 'audios');
const TRANSCRIPT_DIR = path.join(process.cwd(), 'transcripts');
const SUMMARY_DIR = path.join(process.cwd(), 'summaries');

fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
fs.mkdirSync(SUMMARY_DIR, { recursive: true });

function makeLogFileName(guildId, channelId) {
  const ts = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  return path.join(TRANSCRIPT_DIR, `${guildId}-${channelId}-${ts}.log`);
}

const sessionLogs = new Map();
const pendingTranscriptions = new Map(); // Track pending transcriptions by session

function writeTranscript(guildId, channelId, username, text) {
  const key = `${guildId}:${channelId}`;
  if (!sessionLogs.has(key)) {
    sessionLogs.set(key, makeLogFileName(guildId, channelId));
  }
  
  const logFile = sessionLogs.get(key);
  const line = `[${new Date().toISOString()}] ${username}: ${text}\n`;
  
  fs.appendFile(logFile, line, (err) => {
    if (err) {
      logger.error("Failed to write transcript", {
        extra: {
          footprint: null,
          batch_uuid: `${guildId}:${channelId}`,
          user_id: username,
          event_id: uuidv4(),
          action: "transcript_write",
          event: "error"
        }
      });
    }
  });
}

// ---------- Slash Commands Setup ----------
const commands = [
  new SlashCommandBuilder().setName('join')
    .setDescription('Join the caller\'s voice channel & start transcribing'),
  new SlashCommandBuilder().setName('leave')
    .setDescription('Leave the current voice channel'),
];

client.once('ready', async () => {
  const readyEventId = uuidv4();
  const startTime = Date.now();
  
  logger.info("Discord client ready", {
    extra: {
      footprint: null,
      batch_uuid: startupEventId,
      user_id: null,
      event_id: readyEventId,
      action: "discord_ready",
      event: "start"
    }
  });

  // Validate OpenAI API key
  const isApiKeyValid = await validateOpenAIKey();
  if (!isApiKeyValid) {
    logger.error("Bot will continue but OpenAI features may not work", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: uuidv4(),
        action: "discord_ready",
        event: "warning"
      }
    });
  }

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands.map(cmd => cmd.toJSON()) }
    );
    
    logger.info("Slash commands registered successfully", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: readyEventId,
        action: "discord_ready",
        event: "complete",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    
    console.log(`✅ Bot ready: ${client.user.tag}`);
    console.log('✅ Commands registered');
    
  } catch (err) {
    logger.error("Failed to register slash commands", {
      extra: {
        footprint: null,
        batch_uuid: startupEventId,
        user_id: null,
        event_id: readyEventId,
        action: "discord_ready",
        event: "error",
        duration_ms: calculateDurationMs(startTime)
      }
    }, err);
  }
});

// ---------- Audio Capture Function ----------
function captureUserAudio(connection, userId) {
  const captureEventId = uuidv4();
  const sessionId = `${connection.joinConfig.guildId}:${connection.joinConfig.channelId}`;
  const startTime = Date.now();

  // 1) Start receiving Opus
  const opusStream = connection.receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: 2000 }
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

      // 4) Pipe raw PCM into ffmpeg, convert to 16kHz mono with noise reduction
    const ff = spawn(ffmpegPath, ['-y',
    '-loglevel', 'error',
    '-f', 's16le',     // input is raw 16-bit PCM
    '-ar', '48000',    // 48k sampling rate
    '-ac', '2',        // stereo
          '-i', 'pipe:0',    // read from stdin
      // Audio enhancement for better speech recognition
      '-af', 'highpass=f=200,lowpass=f=3000,volume=1.5',
      '-ac', '1',        // convert to mono
          '-ar', '24000',    // 24 kHz (better for Whisper)
      '-acodec', 'pcm_s16le', // 16-bit PCM
      '-f', 'wav',
    wavPath,           // output file
  ]);

  pcmStream.pipe(ff.stdin);

  return new Promise((resolve, reject) => {
    ff.on('close', code => {
      if (code !== 0) {
        logger.error("FFmpeg conversion failed", {
          extra: {
            footprint: null,
            batch_uuid: sessionId,
            user_id: userId,
            event_id: captureEventId,
            action: "audio_capture",
            event: "error",
            duration_ms: calculateDurationMs(startTime),
            ffmpeg_exit_code: code
          }
        });
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
    
    ff.on('error', (error) => {
      logger.error("FFmpeg process error", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: userId,
          event_id: captureEventId,
          action: "audio_capture",
          event: "error",
          duration_ms: calculateDurationMs(startTime)
        }
      }, error);
      reject(error);
    });
  });
}

// ---------- Audio Transcription Function ----------
async function transcribeAudio(wavPath, sessionId, userId) {
  if (!wavPath) return '';

  const transcribeEventId = uuidv4();
  const startTime = Date.now();

  try {
    // Check if file exists and has content
    if (!fs.existsSync(wavPath)) {
      console.error(`❌ Audio file not found: ${wavPath}`);
      return '';
    }
    
    const fileStats = fs.statSync(wavPath);
    if (fileStats.size === 0) {
      console.error(`❌ Audio file is empty: ${wavPath}`);
      return '';
    }
    
    console.log(`🎵 Transcribing audio file: ${fileStats.size} bytes`);
    
    // Add file size validation (Whisper has a 25MB limit)
    if (fileStats.size > 25 * 1024 * 1024) {
      console.error(`❌ Audio file too large: ${fileStats.size} bytes (max 25MB)`);
      return '';
    }
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: 'whisper-1',
      // No language specified = auto-detect (supports German, English, and others)
      response_format: 'text',
      temperature: 0.2 // Lower temperature for more consistent results
    });
    
    const text = typeof transcription === 'string'
      ? transcription
      : transcription.text ?? '';
    
    if (text?.trim()) {
      console.log('📝 Whisper →', text);
      logger.info("Transcription successful", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: userId,
          event_id: transcribeEventId,
          action: "audio_transcription",
          event: "complete"
        }
      });
    }
    
    return text;
    
  } catch (err) {
    logger.error("Audio transcription failed", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: userId,
        event_id: transcribeEventId,
        action: "audio_transcription",
        event: "error",
        duration_ms: calculateDurationMs(startTime),
        error_type: err.constructor.name,
        error_message: err.message,
        error_code: err.code,
        error_status: err.status
      }
    });
    
    // Specific error handling for different OpenAI API issues
    if (err.status === 401) {
      console.error('❌ Whisper failed: Invalid API key - check your OpenAI account');
    } else if (err.status === 429) {
      console.error('❌ Whisper failed: Rate limit exceeded or insufficient credits');
    } else if (err.code === 'insufficient_quota') {
      console.error('❌ Whisper failed: Quota exceeded - please add credits to your OpenAI account');
    } else if (err.status === 400) {
      console.error('❌ Whisper failed: Bad request - check audio format or file size');
    } else if (err.status === 413) {
      console.error('❌ Whisper failed: File too large (max 25MB)');
    } else if (err.message.includes('Connection') || err.message.includes('timeout')) {
      console.error('❌ Whisper failed: Connection error - check your internet connection');
    } else if (err.message.includes('audio_format')) {
      console.error('❌ Whisper failed: Unsupported audio format');
    } else {
      console.error('❌ Whisper failed:', err.message);
      console.error('Full error:', err);
    }
    
    return '';
  }
}

// ---------- Token Estimation Functions ----------
function approximateTokens(str) {
  return Math.ceil(str.length / 4);
}

function chunkTextByTokens(text, maxTokens = 6000) {
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

// ---------- Transcript Summarization Function ----------
async function summarizeTranscript(guildId, channelId) {
  const summarizeEventId = uuidv4();
  const sessionId = `${guildId}:${channelId}`;
  const startTime = Date.now();
  
  logger.debug("Starting transcript summarization", {
    extra: {
      footprint: null,
      batch_uuid: sessionId,
      user_id: null,
      event_id: summarizeEventId,
      action: "transcript_summarization",
      event: "start"
    }
  });

  const key = `${guildId}:${channelId}`;
  const logFile = sessionLogs.get(key);
  
  if (!logFile || !fs.existsSync(logFile)) {
    logger.warning("No transcript file found for summarization", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: summarizeEventId,
        action: "transcript_summarization",
        event: "error",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    return null;
  }

  const transcript = fs.readFileSync(logFile, 'utf-8');
  if (!transcript.trim()) {
    logger.warning("Empty transcript found", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: summarizeEventId,
        action: "transcript_summarization",
        event: "error",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    return null;
  }

  const totalTokens = approximateTokens(transcript);
  
  logger.info("Processing transcript for summarization", {
    extra: {
      footprint: null,
      batch_uuid: sessionId,
      user_id: null,
      event_id: summarizeEventId,
      action: "transcript_summarization",
      event: "validate_input",
      estimated_tokens: totalTokens,
      transcript_length: transcript.length
    }
  });

  try {
    let summary;
    
    if (totalTokens <= 6000) {
      // Load the meeting minutes blueprint
      const blueprintPath = path.join(process.cwd(), 'meeting_minutes_blueprint.md');
      let blueprint = '';
      
      try {
        blueprint = fs.readFileSync(blueprintPath, 'utf-8');
      } catch (err) {
        logger.error("Failed to load meeting minutes blueprint", {
          extra: {
            footprint: null,
            batch_uuid: sessionId,
            user_id: null,
            event_id: uuidv4(),
            action: "blueprint_load",
            event: "error"
          }
        }, err);
        blueprint = 'Standard meeting minutes template not found. Please create a basic summary.';
      }

      // Single summarization for shorter transcripts
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
                          content: 'You are a professional executive assistant specializing in creating clear, well-structured German meeting protocols. You excel at transforming transcripts into polished business documents that meet corporate standards.'
          },
                      {
              role: 'user',
              content: `Create a professional meeting minutes document from the following transcript, adhering to the provided template for consistency and clarity.

TRANSCRIPT:
${transcript}

TEMPLATE (please follow exactly):
${blueprint}

CONTENT REQUIREMENTS:
- Extract clear decisions and resolutions made during the meeting
- Identify specific action items with assigned responsibilities and deadlines
- Focus on measurable outcomes and concrete actions
- Use precise, professional business language in German

FORMATTING GUIDELINES:
- Set today's date: ${new Date().toLocaleDateString('de-DE')}
- Estimate meeting duration based on transcript length
- Mark unknown information with appropriate placeholders
- Present the output as well-structured markdown suitable for business documentation

Please ensure the final document maintains professional standards and executive-level presentation quality.`
            }
        ]
      });

      summary = completion.choices[0].message.content.trim();

    } else {
      // Chunked summarization for longer transcripts
      logger.info("Transcript requires chunking", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: null,
          event_id: uuidv4(),
          action: "transcript_summarization",
          event: "validate_input"
        }
      });
      
      const textChunks = chunkTextByTokens(transcript, 6000);
      const partialSummaries = [];

      // Summarize each chunk
      for (let i = 0; i < textChunks.length; i++) {
        const chunkEventId = uuidv4();
        const chunkStartTime = Date.now();
        
        logger.debug("Processing transcript chunk", {
          extra: {
            footprint: null,
            batch_uuid: sessionId,
            user_id: null,
            event_id: chunkEventId,
            action: "chunk_summarization",
            event: "start",
            chunk_index: i + 1,
            total_chunks: textChunks.length
          }
        });

        const chunk = textChunks[i];
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o', 
          messages: [
            {
              role: 'system',
                              content: 'You are a professional meeting analyst who extracts and structures key information from transcript segments. Focus on actionable items, decisions, and business discussions. Present findings clearly in German.'
            },
                          {
                role: 'user',
                content: `Analyze the following transcript section and extract the most important information in a clear, structured format:

TRANSCRIPT SECTION ${i + 1} of ${textChunks.length}:
${chunk}

Please focus on the following categories:
- **Decisions:** Document all concrete resolutions and agreements made during the meeting
- **Action Items:** List all tasks including responsible parties and agreed deadlines
- **Key Discussions:** Record the most important discussion points addressed in the meeting
- **Deadlines:** Identify all deadlines and milestones that were established
- **Project Planning:** Note any changes or updates to the project plan
- **Risks:** Describe any identified issues or blockers that could affect the project

Format: Present the information as a structured list with bullet points. Ensure concise and clear formulation. The entire output should be written in a professional protocol style suitable for meeting minutes.`
              }
          ]
        });

        const partialSummary = completion.choices[0].message.content.trim();
        partialSummaries.push(partialSummary);
        
        logger.info("Transcript chunk processed", {
          extra: {
            footprint: null,
            batch_uuid: sessionId,
            user_id: null,
            event_id: chunkEventId,
            action: "chunk_summarization",
            event: "complete",
            duration_ms: calculateDurationMs(chunkStartTime),
            chunk_index: i + 1
          }
        });
      }

      // Load the blueprint for final summarization too
      const blueprintPath = path.join(process.cwd(), 'meeting_minutes_blueprint.md');
      let blueprint = '';
      
      try {
        blueprint = fs.readFileSync(blueprintPath, 'utf-8');
      } catch (err) {
        blueprint = 'Standard meeting minutes template not found. Please create a basic summary.';
      }

      // Final summarization
      const finalInput = partialSummaries.join('\n\n---\n\n');
      const finalCompletion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
                          content: 'You are a senior executive assistant who specializes in creating comprehensive German meeting protocols. You excel at consolidating complex information into well-structured, professional documents suitable for executive review.'
          },
                      {
              role: 'user',
              content: `Consolidate the following sections into a comprehensive and professional meeting minutes document.

ANALYZED SECTIONS:
${finalInput}

TEMPLATE (follow exactly):
${blueprint}

CONSOLIDATION REQUIREMENTS:
- Eliminate duplicates between sections
- Group related action items logically
- Prioritize decisions by importance
- Create a coherent timeline from all relevant dates and deadlines

DOCUMENT SPECIFICATIONS:
- Today's date: ${new Date().toLocaleDateString('de-DE')}
- Estimate meeting duration based on transcript scope
- Use professional German business language
- Ensure executive-level quality suitable for immediate presentation

The final protocol should be a polished, comprehensive document that accurately reflects the meeting content while maintaining professional formatting standards.`
            }
        ]
      });

      summary = finalCompletion.choices[0].message.content.trim();
    }

    logger.info("Transcript summarization completed", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: summarizeEventId,
        action: "transcript_summarization",
        event: "complete",
        duration_ms: calculateDurationMs(startTime),
        summary_length: summary.length
      }
    });

    return summary;

  } catch (err) {
    logger.error("Transcript summarization failed", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: summarizeEventId,
        action: "transcript_summarization",
        event: "error",
        duration_ms: calculateDurationMs(startTime),
        error_type: err.constructor.name,
        error_message: err.message,
        error_code: err.code,
        error_status: err.status
      }
    });
    
    throw err;
  }
}

// ---------- Main Bot Logic ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const interactionEventId = uuidv4();
  const startTime = Date.now();

  if (interaction.commandName === 'join') {
    const channel = interaction.member.voice?.channel;
    if (!channel) {
      logger.warning("User not in voice channel", {
        extra: {
          footprint: null,
          batch_uuid: interactionEventId,
          user_id: interaction.user.id,
          event_id: uuidv4(),
          action: "interaction_handling",
          event: "error"
        }
      });
      return interaction.reply({ content: 'Jump into a voice channel first!', ephemeral: true });
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    logger.info("Joined voice channel", {
      extra: {
        footprint: null,
        batch_uuid: interactionEventId,
        user_id: interaction.user.id,
        event_id: uuidv4(),
        action: "voice_join",
        event: "complete",
        channel_name: channel.name,
        channel_id: channel.id
      }
    });

    interaction.reply(`🎙️ **Transkription gestartet** in **${channel.name}**\n📝 Sprechen Sie - ich erstelle automatisch ein Protokoll!`);
    
    connection.receiver.speaking.on('start', async (userId) => {
      const sessionId = `${interaction.guild.id}:${channel.id}`;
      
      // Track this transcription as pending
      if (!pendingTranscriptions.has(sessionId)) {
        pendingTranscriptions.set(sessionId, new Set());
      }
      
      const transcriptionId = uuidv4();
      pendingTranscriptions.get(sessionId).add(transcriptionId);
      
      try {
        // 1) Capture user audio -> WAV
        const wavPath = await captureUserAudio(connection, userId);
        if (!wavPath) {
          // Remove from pending if no audio captured
          const pendingSet = pendingTranscriptions.get(sessionId);
          if (pendingSet) {
            pendingSet.delete(transcriptionId);
          }
          return;
        }

        // 2) Transcribe with retry logic
        let text = '';
        let retries = 2;
        let lastError = null;
        
        while (retries >= 0) {
          try {
            text = await transcribeAudio(wavPath, sessionId, userId);
            break; // Success, exit retry loop
          } catch (transcribeErr) {
            lastError = transcribeErr;
            retries--;
            if (retries >= 0) {
              console.log(`🔄 Retrying transcription (${2 - retries}/3)...`);
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
            }
          }
        }
        
        if (!text && lastError) {
          throw lastError; // Re-throw the last error if all retries failed
        }
        
        if (text?.trim()) {
          const username = await interaction.guild.members
            .fetch(userId)
            .then(u => u.displayName)
            .catch(() => 'Someone');

          // 3) Log transcript
          writeTranscript(interaction.guild.id, channel.id, username, text);
        }
        
        // Mark transcription as complete
        const pendingSet = pendingTranscriptions.get(sessionId);
        if (pendingSet) {
          pendingSet.delete(transcriptionId);
        }
        
      } catch (err) {
        // Remove from pending on error
        const pendingSet = pendingTranscriptions.get(sessionId);
        if (pendingSet) {
          pendingSet.delete(transcriptionId);
        }
        
        logger.error("Voice processing failed", {
          extra: {
            footprint: null,
            batch_uuid: sessionId,
            user_id: userId,
            event_id: uuidv4(),
            action: "voice_processing",
            event: "error"
          }
        }, err);
      }
    });
  }

  if (interaction.commandName === 'leave') {
    // Defer reply for long-running operation
    await interaction.deferReply();
    
    const leaveEventId = uuidv4();
    const leaveStartTime = Date.now();
  
    const conn = getVoiceConnection(interaction.guild.id);
    let sessionId = null;
    
    if (conn) {
      sessionId = `${interaction.guild.id}:${conn.joinConfig.channelId}`;
      conn.destroy();
      console.log('🔌 Voice connection closed');
      
      // Wait for all pending transcriptions to complete
      console.log('📝 Finalizing transcriptions...');
      
      // Update user with status
      await interaction.editReply('📝 Verarbeite noch offene Transkriptionen...');
      
      // Give a small delay for any final audio processing to start
      console.log('⏳ Allowing time for final audio processing...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const allComplete = await waitForPendingTranscriptions(sessionId);
      
      if (allComplete) {
        console.log('✅ All transcriptions completed');
        await interaction.editReply('📝 Erstelle Meeting-Protokoll...');
      } else {
        console.log('⚠️ Some transcriptions may be incomplete');
        await interaction.editReply('⚠️ Erstelle Protokoll (einige Transkriptionen unvollständig)...');
      }
      
      // Clean up the pending transcriptions for this session
      pendingTranscriptions.delete(sessionId);
    }
  
    let summary = null;
    try {
      summary = await summarizeTranscript(interaction.guild.id, conn?.joinConfig.channelId);
    } catch (err) {
      logger.error("Failed to summarize transcript", {
        extra: {
          footprint: null,
          batch_uuid: interactionEventId,
          user_id: interaction.user.id,
          event_id: leaveEventId,
          action: "voice_leave",
          event: "error",
          duration_ms: calculateDurationMs(leaveStartTime)
        }
      }, err);
    }
  
    if (summary) {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hour = String(now.getHours()).padStart(2, '0');
      const minute = String(now.getMinutes()).padStart(2, '0');
      const baseFileName = `Meeting_Minutes_${year}_${month}_${day}__${hour}_${minute}`;
      
      // Extract meeting title from summary for better naming
      const titleMatch = summary.match(/Thema.*?-->(.*?)<!--/);
      const meetingTitle = titleMatch ? titleMatch[1].trim() : "Meeting";
  
      // Generate professional Word document
      const wordFileName = `${baseFileName}.docx`;
      const wordPath = path.join(SUMMARY_DIR, wordFileName);
      let wordBuffer = null;
      
      try {
        wordBuffer = await convertToWordDoc(summary, meetingTitle);
        if (wordBuffer) {
          fs.writeFileSync(wordPath, wordBuffer);
          console.log(`📄 Word document generated: ${wordFileName}`);
        }
      } catch (error) {
        console.error('Failed to generate Word document:', error);
      }
      
      let filesToUpload = [];
      let uploadMessage = '';
      
      // Prepare upload message and files
      if (wordBuffer) {
        fs.writeFileSync(wordPath, wordBuffer);
        const { AttachmentBuilder } = await import('discord.js');
        const attachment = new AttachmentBuilder(wordPath, { name: wordFileName });
      
        await interaction.editReply({
          content: `📝 **Meeting-Protokoll erstellt!** 📄\n\n📄 **Microsoft Word (.docx)** - Professionell editierbar\n\n💼 Das Word-Dokument ist business-ready!`,
          files: [attachment]
        });
      
        console.log(`✅ Uploaded: ${wordFileName}`);
      } else {
        await interaction.editReply(`⚠️ Meeting-Protokoll konnte nicht erstellt werden.`);
      }
      
      logger.info("Summary files created", {
        extra: {
          footprint: null,
          batch_uuid: interactionEventId,
          user_id: interaction.user.id,
          event_id: leaveEventId,
          action: "voice_leave",
          event: "complete",
          duration_ms: calculateDurationMs(leaveStartTime)
        }
      });

      try {
        // Upload both files to Discord
        const { AttachmentBuilder } = await import('discord.js');
        const attachments = filesToUpload.map(file => 
          new AttachmentBuilder(file.path, { name: file.name })
        );
        
        await interaction.editReply({
          content: uploadMessage,
          files: attachments
        });
        
        console.log(`✅ Files uploaded: ${filesToUpload.map(f => f.name).join(', ')}`);
        
      } catch (uploadError) {
        logger.error("Failed to upload summary files", {
          extra: {
            footprint: null,
            batch_uuid: interactionEventId,
            user_id: interaction.user.id,
            event_id: uuidv4(),
            action: "file_upload",
            event: "error"
          }
        }, uploadError);
        
        // Fallback: provide download links
        const fileList = filesToUpload.map(f => `• \`${f.name}\``).join('\n');
        await interaction.editReply(
          `📝 **Meeting-Protokoll** wurde erstellt!\n📁 Dateien gespeichert:\n${fileList}\n\n*Hinweis: Datei-Upload fehlgeschlagen, bitte lokale Dateien verwenden.*`
        );
      }
    } else {
      await interaction.editReply('❌ Verbindung getrennt. Kein Transkript gefunden oder nichts zu erstellen.');
    }
  }
});

// Global error handling
process.on('unhandledRejection', (reason, promise) => {
  logger.error("Unhandled Promise Rejection", {
    extra: {
      footprint: null,
      batch_uuid: null,
      user_id: null,
      event_id: uuidv4(),
      action: "error_handling",
      event: "error",
      error_type: "UnhandledPromiseRejection"
    }
  }, reason);
});

process.on('uncaughtException', (error) => {
  logger.error("Uncaught Exception", {
    extra: {
      footprint: null,
      batch_uuid: null,
      user_id: null,
      event_id: uuidv4(),
      action: "error_handling",
      event: "error",
      error_type: "UncaughtException"
    }
  }, error);
  process.exit(1);
});

client.login(BOT_TOKEN);
