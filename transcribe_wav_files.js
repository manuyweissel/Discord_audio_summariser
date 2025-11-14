#!/usr/bin/env node

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { createLogger, format, transports } from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from 'docx';

// ---------- Logging Setup (Following DataNXT Standards) ----------
const SERVICE_NAME = 'wav-transcription-service';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FILE_PATH = 'wav-transcription.log';

const logger = createLogger({
  level: LOG_LEVEL,
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
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
      filename: LOG_FILE_PATH,
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

// ---------- Environment Setup ----------
const openai = new OpenAI(); // uses OPENAI_API_KEY env
const AUDIO_DIR = '/home/datanxt/Desktop/Product/Projects/Discord_summarise_bot/discord-voice-bot/18_08';
const OUTPUT_DIR = path.join(process.cwd(), 'batch_transcriptions');

// Create output directory
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Main processing UUID for tracking this batch
const batchUuid = uuidv4();

// ---------- Validation Functions ----------
async function validateEnvironment() {
  const validationEventId = uuidv4();
  const startTime = Date.now();
  
  logger.debug("Validating environment setup", {
    extra: {
      footprint: null,
      batch_uuid: batchUuid,
      user_id: null,
      event_id: validationEventId,
      action: "environment_validation",
      event: "start"
    }
  });

  // Check OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    logger.error("Missing OPENAI_API_KEY environment variable", {
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: validationEventId,
        action: "environment_validation",
        event: "error",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  // Test OpenAI API key validity
  try {
    const models = await openai.models.list();
    logger.info("OpenAI API key validation successful", {
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: validationEventId,
        action: "environment_validation",
        event: "complete",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    return true;
  } catch (error) {
    logger.error("OpenAI API key validation failed", {
      exc_info: true,
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: validationEventId,
        action: "environment_validation",
        event: "error",
        duration_ms: calculateDurationMs(startTime),
        error_type: error.constructor.name,
        error_message: error.message,
        error_code: error.code,
        error_status: error.status
      }
    });
    throw error;
  }
}

// ---------- File Discovery ----------
function discoverWavFiles() {
  const discoveryEventId = uuidv4();
  const startTime = Date.now();
  
  logger.debug("Discovering WAV files", {
    extra: {
      footprint: null,
      batch_uuid: batchUuid,
      user_id: null,
      event_id: discoveryEventId,
      action: "file_discovery",
      event: "start",
      audio_directory: AUDIO_DIR
    }
  });

  try {
    if (!fs.existsSync(AUDIO_DIR)) {
      throw new Error(`Audio directory does not exist: ${AUDIO_DIR}`);
    }

    const files = fs.readdirSync(AUDIO_DIR)
      .filter(file => file.toLowerCase().endsWith('.wav'))
      .map(file => ({
        name: file,
        path: path.join(AUDIO_DIR, file),
        size: fs.statSync(path.join(AUDIO_DIR, file)).size
      }))
      .sort((a, b) => a.name.localeCompare(b.name)); // Sort chronologically

    logger.info("WAV files discovered", {
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: discoveryEventId,
        action: "file_discovery",
        event: "complete",
        duration_ms: calculateDurationMs(startTime),
        files_found: files.length,
        total_size_mb: Math.round(files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024))
      }
    });

    return files;
  } catch (error) {
    logger.error("File discovery failed", {
      exc_info: true,
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: discoveryEventId,
        action: "file_discovery",
        event: "error",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    throw error;
  }
}

// ---------- Audio Transcription ----------
async function transcribeAudioFile(filePath, fileName) {
  const transcribeEventId = uuidv4();
  const startTime = Date.now();
  
  logger.debug("Starting audio transcription", {
    extra: {
      footprint: null,
      batch_uuid: batchUuid,
      user_id: null,
      event_id: transcribeEventId,
      action: "audio_transcription",
      event: "start",
      file_name: fileName
    }
  });

  try {
    // Validate file exists and has content
    if (!fs.existsSync(filePath)) {
      throw new Error(`Audio file not found: ${filePath}`);
    }
    
    const fileStats = fs.statSync(filePath);
    if (fileStats.size === 0) {
      throw new Error(`Audio file is empty: ${filePath}`);
    }
    
    // Check file size limit (Whisper has a 25MB limit)
    if (fileStats.size > 25 * 1024 * 1024) {
      throw new Error(`Audio file too large: ${fileStats.size} bytes (max 25MB)`);
    }

    logger.info("Transcribing audio file", {
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: transcribeEventId,
        action: "audio_transcription",
        event: "validate_input",
        file_size_bytes: fileStats.size,
        file_name: fileName
      }
    });

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      response_format: 'text',
      temperature: 0.2 // Lower temperature for more consistent results
    });
    
    const text = typeof transcription === 'string'
      ? transcription
      : transcription.text ?? '';
    
    if (text?.trim()) {
      logger.info("Audio transcription successful", {
        extra: {
          footprint: null,
          batch_uuid: batchUuid,
          user_id: null,
          event_id: transcribeEventId,
          action: "audio_transcription",
          event: "complete",
          duration_ms: calculateDurationMs(startTime),
          transcript_length: text.length
        }
      });
    } else {
      logger.warning("Empty transcription result", {
        extra: {
          footprint: null,
          batch_uuid: batchUuid,
          user_id: null,
          event_id: transcribeEventId,
          action: "audio_transcription",
          event: "warning",
          duration_ms: calculateDurationMs(startTime)
        }
      });
    }
    
    return text;
    
  } catch (error) {
    logger.error("Audio transcription failed", {
      exc_info: true,
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: transcribeEventId,
        action: "audio_transcription",
        event: "error",
        duration_ms: calculateDurationMs(startTime),
        file_name: fileName,
        error_type: error.constructor.name,
        error_message: error.message,
        error_code: error.code,
        error_status: error.status
      }
    });
    throw error;
  }
}

// ---------- Token Estimation ----------
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

// ---------- Meeting Minutes Generation ----------
async function generateMeetingMinutes(fullTranscript) {
  const summaryEventId = uuidv4();
  const startTime = Date.now();
  
  logger.debug("Starting meeting minutes generation", {
    extra: {
      footprint: null,
      batch_uuid: batchUuid,
      user_id: null,
      event_id: summaryEventId,
      action: "meeting_minutes_generation",
      event: "start"
    }
  });

  if (!fullTranscript.trim()) {
    logger.warning("Empty transcript provided", {
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: summaryEventId,
        action: "meeting_minutes_generation",
        event: "error",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    return null;
  }

  const totalTokens = approximateTokens(fullTranscript);
  
  logger.info("Processing transcript for meeting minutes", {
    extra: {
      footprint: null,
      batch_uuid: batchUuid,
      user_id: null,
      event_id: summaryEventId,
      action: "meeting_minutes_generation",
      event: "validate_input",
      estimated_tokens: totalTokens,
      transcript_length: fullTranscript.length
    }
  });

  try {
    // Load the meeting minutes blueprint
    const blueprintPath = path.join(process.cwd(), 'meeting_minutes_blueprint.md');
    let blueprint = '';
    
    try {
      blueprint = fs.readFileSync(blueprintPath, 'utf-8');
    } catch (err) {
      logger.error("Failed to load meeting minutes blueprint", {
        exc_info: true,
        extra: {
          footprint: null,
          batch_uuid: batchUuid,
          user_id: null,
          event_id: uuidv4(),
          action: "blueprint_load",
          event: "error"
        }
      });
      blueprint = 'Standard meeting minutes template not found. Please create a basic summary.';
    }

    let summary;
    
    if (totalTokens <= 6000) {
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
${fullTranscript}

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
          batch_uuid: batchUuid,
          user_id: null,
          event_id: uuidv4(),
          action: "meeting_minutes_generation",
          event: "chunking_required"
        }
      });
      
      const textChunks = chunkTextByTokens(fullTranscript, 6000);
      const partialSummaries = [];

      // Summarize each chunk
      for (let i = 0; i < textChunks.length; i++) {
        const chunkEventId = uuidv4();
        const chunkStartTime = Date.now();
        
        logger.debug("Processing transcript chunk", {
          extra: {
            footprint: null,
            batch_uuid: batchUuid,
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
            batch_uuid: batchUuid,
            user_id: null,
            event_id: chunkEventId,
            action: "chunk_summarization",
            event: "complete",
            duration_ms: calculateDurationMs(chunkStartTime),
            chunk_index: i + 1
          }
        });
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

    logger.info("Meeting minutes generation completed", {
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: summaryEventId,
        action: "meeting_minutes_generation",
        event: "complete",
        duration_ms: calculateDurationMs(startTime),
        summary_length: summary.length
      }
    });

    return summary;

  } catch (error) {
    logger.error("Meeting minutes generation failed", {
      exc_info: true,
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: summaryEventId,
        action: "meeting_minutes_generation",
        event: "error",
        duration_ms: calculateDurationMs(startTime),
        error_type: error.constructor.name,
        error_message: error.message,
        error_code: error.code,
        error_status: error.status
      }
    });
    throw error;
  }
}

// ---------- Word Document Generation ----------
async function convertToWordDoc(content, meetingTitle = "Meeting") {
  const docGenEventId = uuidv4();
  const startTime = Date.now();
  
  logger.debug("Starting Word document generation", {
    extra: {
      footprint: null,
      batch_uuid: batchUuid,
      user_id: null,
      event_id: docGenEventId,
      action: "word_document_generation",
      event: "start"
    }
  });

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
    
    // Process content (simplified version of the complex logic from the bot)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.startsWith('##')) {
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
      } else if (line && (line.startsWith('- ') || line.startsWith('* '))) {
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
    
    const buffer = await Packer.toBuffer(doc);
    
    logger.info("Word document generation completed", {
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: docGenEventId,
        action: "word_document_generation",
        event: "complete",
        duration_ms: calculateDurationMs(startTime),
        buffer_size_bytes: buffer.length
      }
    });
    
    return buffer;
    
  } catch (error) {
    logger.error("Word document generation failed", {
      exc_info: true,
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: docGenEventId,
        action: "word_document_generation",
        event: "error",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    return null;
  }
}

// ---------- Main Processing Function ----------
async function main() {
  const mainEventId = uuidv4();
  const startTime = Date.now();
  
  logger.info("Starting WAV transcription and meeting minutes generation", {
    extra: {
      footprint: null,
      batch_uuid: batchUuid,
      user_id: null,
      event_id: mainEventId,
      action: "main_processing",
      event: "start"
    }
  });

  try {
    // Step 1: Validate environment
    await validateEnvironment();

    // Step 2: Discover WAV files
    const wavFiles = discoverWavFiles();
    
    if (wavFiles.length === 0) {
      logger.warning("No WAV files found", {
        extra: {
          footprint: null,
          batch_uuid: batchUuid,
          user_id: null,
          event_id: mainEventId,
          action: "main_processing",
          event: "warning",
          duration_ms: calculateDurationMs(startTime)
        }
      });
      console.log('No WAV files found in the directory.');
      return;
    }

    console.log(`Found ${wavFiles.length} WAV files to process...`);

    // Step 3: Transcribe all files
    const transcriptions = [];
    for (let i = 0; i < wavFiles.length; i++) {
      const file = wavFiles[i];
      const fileEventId = uuidv4();
      const fileStartTime = Date.now();
      
      console.log(`Processing ${i + 1}/${wavFiles.length}: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
      
      logger.info("Processing WAV file", {
        extra: {
          footprint: null,
          batch_uuid: batchUuid,
          user_id: null,
          event_id: fileEventId,
          action: "file_processing",
          event: "start",
          file_index: i + 1,
          total_files: wavFiles.length,
          file_name: file.name
        }
      });

      try {
        const transcription = await transcribeAudioFile(file.path, file.name);
        if (transcription && transcription.trim()) {
          transcriptions.push({
            fileName: file.name,
            timestamp: file.name, // Use filename as timestamp since it contains timestamp
            text: transcription.trim()
          });
          console.log(`✅ Transcribed: ${file.name}`);
        } else {
          console.log(`⚠️ Empty transcription: ${file.name}`);
        }
        
        logger.info("WAV file processed", {
          extra: {
            footprint: null,
            batch_uuid: batchUuid,
            user_id: null,
            event_id: fileEventId,
            action: "file_processing",
            event: "complete",
            duration_ms: calculateDurationMs(fileStartTime),
            file_index: i + 1
          }
        });
        
      } catch (error) {
        logger.error("WAV file processing failed", {
          exc_info: true,
          extra: {
            footprint: null,
            batch_uuid: batchUuid,
            user_id: null,
            event_id: fileEventId,
            action: "file_processing",
            event: "error",
            duration_ms: calculateDurationMs(fileStartTime),
            file_index: i + 1,
            file_name: file.name
          }
        });
        console.log(`❌ Failed to transcribe: ${file.name} - ${error.message}`);
        // Continue with other files
      }
    }

    if (transcriptions.length === 0) {
      logger.warning("No successful transcriptions", {
        extra: {
          footprint: null,
          batch_uuid: batchUuid,
          user_id: null,
          event_id: mainEventId,
          action: "main_processing",
          event: "warning",
          duration_ms: calculateDurationMs(startTime)
        }
      });
      console.log('No successful transcriptions were generated.');
      return;
    }

    console.log(`\nSuccessfully transcribed ${transcriptions.length} files.`);

    // Step 4: Combine all transcriptions into a single transcript
    const fullTranscript = transcriptions
      .map(t => `[${t.timestamp}]\n${t.text}`)
      .join('\n\n---\n\n');

    // Save the full transcript
    const transcriptPath = path.join(OUTPUT_DIR, `full_transcript_${Date.now()}.txt`);
    fs.writeFileSync(transcriptPath, fullTranscript, 'utf-8');
    console.log(`📝 Full transcript saved: ${transcriptPath}`);

    // Step 5: Generate meeting minutes
    console.log('\n🤖 Generating meeting minutes...');
    const meetingMinutes = await generateMeetingMinutes(fullTranscript);

    if (meetingMinutes) {
      // Save meeting minutes as markdown
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hour = String(now.getHours()).padStart(2, '0');
      const minute = String(now.getMinutes()).padStart(2, '0');
      const baseFileName = `Meeting_Minutes_${year}_${month}_${day}__${hour}_${minute}`;

      // Save as markdown
      const markdownPath = path.join(OUTPUT_DIR, `${baseFileName}.md`);
      fs.writeFileSync(markdownPath, meetingMinutes, 'utf-8');
      console.log(`📄 Meeting minutes saved: ${markdownPath}`);

      // Generate Word document
      console.log('📄 Generating Word document...');
      const wordBuffer = await convertToWordDoc(meetingMinutes, "Meeting from WAV Files");
      
      if (wordBuffer) {
        const wordPath = path.join(OUTPUT_DIR, `${baseFileName}.docx`);
        fs.writeFileSync(wordPath, wordBuffer);
        console.log(`📄 Word document saved: ${wordPath}`);
      }

      logger.info("WAV transcription and meeting minutes generation completed", {
        extra: {
          footprint: null,
          batch_uuid: batchUuid,
          user_id: null,
          event_id: mainEventId,
          action: "main_processing",
          event: "complete",
          duration_ms: calculateDurationMs(startTime),
          files_processed: transcriptions.length,
          total_files_found: wavFiles.length
        }
      });

      console.log('\n✅ Processing complete!');
      console.log(`📊 Statistics:`);
      console.log(`   - Files found: ${wavFiles.length}`);
      console.log(`   - Files transcribed: ${transcriptions.length}`);
      console.log(`   - Total processing time: ${Math.round(calculateDurationMs(startTime) / 1000)}s`);
      console.log(`   - Output directory: ${OUTPUT_DIR}`);

    } else {
      console.log('❌ Failed to generate meeting minutes.');
    }

  } catch (error) {
    logger.error("Main processing failed", {
      exc_info: true,
      extra: {
        footprint: null,
        batch_uuid: batchUuid,
        user_id: null,
        event_id: mainEventId,
        action: "main_processing",
        event: "error",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    console.error('❌ Processing failed:', error.message);
    process.exit(1);
  }
}

// ---------- Error Handling ----------
process.on('unhandledRejection', (reason, promise) => {
  logger.error("Unhandled Promise Rejection", {
    exc_info: true,
    extra: {
      footprint: null,
      batch_uuid: batchUuid,
      user_id: null,
      event_id: uuidv4(),
      action: "error_handling",
      event: "error",
      error_type: "UnhandledPromiseRejection"
    }
  });
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error("Uncaught Exception", {
    exc_info: true,
    extra: {
      footprint: null,
      batch_uuid: batchUuid,
      user_id: null,
      event_id: uuidv4(),
      action: "error_handling",
      event: "error",
      error_type: "UncaughtException"
    }
  });
  console.error('Uncaught exception:', error);
  process.exit(1);
});

// ---------- Script Execution ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Script execution failed:', error);
    process.exit(1);
  });
}