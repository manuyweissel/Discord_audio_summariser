import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger.js';
import { calculateDurationMs, approximateTokens, chunkTextByTokens } from '../utils/index.js';
import { CIRCUIT_BREAKER_THRESHOLD, CIRCUIT_BREAKER_TIMEOUT } from '../config.js';

const openai = new OpenAI();

// File size threshold for streaming (1MB)
const STREAM_THRESHOLD = 1024 * 1024;

// Circuit breaker state
let circuitBreakerFailures = 0;
let circuitBreakerOpenTime = null;

/**
 * Check if circuit breaker is open (too many failures)
 * @returns {boolean} True if circuit breaker is open
 */
function isCircuitBreakerOpen() {
  if (circuitBreakerOpenTime === null) return false;
  
  // Check if timeout has elapsed
  if (Date.now() - circuitBreakerOpenTime > CIRCUIT_BREAKER_TIMEOUT) {
    // Reset circuit breaker (half-open state)
    circuitBreakerOpenTime = null;
    circuitBreakerFailures = Math.floor(circuitBreakerFailures / 2);
    return false;
  }
  
  return true;
}

/**
 * Record an API failure for circuit breaker
 */
function recordFailure() {
  circuitBreakerFailures++;
  if (circuitBreakerFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreakerOpenTime = Date.now();
    logger.warn("Circuit breaker opened due to repeated API failures", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "circuit_breaker",
        event: "opened",
        failures: circuitBreakerFailures,
        timeout_ms: CIRCUIT_BREAKER_TIMEOUT
      }
    });
  }
}

/**
 * Record an API success for circuit breaker
 */
function recordSuccess() {
  if (circuitBreakerFailures > 0) {
    circuitBreakerFailures = Math.max(0, circuitBreakerFailures - 1);
  }
  if (circuitBreakerOpenTime !== null && circuitBreakerFailures < CIRCUIT_BREAKER_THRESHOLD / 2) {
    circuitBreakerOpenTime = null;
    logger.info("Circuit breaker closed after successful requests", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "circuit_breaker",
        event: "closed"
      }
    });
  }
}

/**
 * Read a large file using streams to prevent blocking the event loop
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} File contents
 */
async function readLargeFile(filePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const readStream = createReadStream(filePath, { encoding: 'utf-8' });
    
    readStream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    readStream.on('end', () => {
      resolve(chunks.join(''));
    });
    
    readStream.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Read transcript file, using streams for large files (>1MB)
 * @param {string} filePath - Path to the transcript file
 * @returns {Promise<string>} File contents
 */
async function readTranscriptFile(filePath) {
  const stats = fs.statSync(filePath);
  
  if (stats.size > STREAM_THRESHOLD) {
    logger.info("Using streamed reading for large transcript file", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "file_read",
        event: "streaming",
        file_size: stats.size,
        threshold: STREAM_THRESHOLD
      }
    });
    return await readLargeFile(filePath);
  }
  
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Summarize a transcript using GPT-4o
 * Uses circuit breaker to prevent repeated failures
 * Uses streamed reading for large files (>1MB)
 * @param {string} guildId - Guild ID
 * @param {string} channelId - Channel ID
 * @param {string} sessionId - Session identifier
 * @param {Map} sessionLogs - Map of session logs
 * @returns {Promise<string|null>} Summary text or null
 */
export async function summarizeTranscript(guildId, channelId, sessionId, sessionLogs) {
  const summarizeEventId = uuidv4();
  const actualSessionId = sessionId || `${guildId}:${channelId}`;
  const startTime = Date.now();

  // Check circuit breaker before attempting API call
  if (isCircuitBreakerOpen()) {
    logger.warn("Circuit breaker open - skipping summarization", {
      extra: {
        footprint: null,
        batch_uuid: actualSessionId,
        user_id: null,
        event_id: summarizeEventId,
        action: "transcript_summarization",
        event: "circuit_breaker_blocked"
      }
    });
    throw new Error('Circuit breaker open - API unavailable');
  }

  logger.debug("Starting transcript summarization", {
    extra: {
      footprint: null,
      batch_uuid: actualSessionId,
      user_id: null,
      event_id: summarizeEventId,
      action: "transcript_summarization",
      event: "start"
    }
  });

  const key = actualSessionId;
  const logFile = sessionLogs.get(key);

  if (!logFile || !fs.existsSync(logFile)) {
    logger.warn("No transcript file found for summarization", {
      extra: {
        footprint: null,
        batch_uuid: actualSessionId,
        user_id: null,
        event_id: summarizeEventId,
        action: "transcript_summarization",
        event: "error",
        duration_ms: calculateDurationMs(startTime)
      }
    });
    return null;
  }

  // Use streamed reading for large files (>1MB) to prevent blocking event loop
  const transcript = await readTranscriptFile(logFile);
  if (!transcript.trim()) {
    logger.warn("Empty transcript found", {
      extra: {
        footprint: null,
        batch_uuid: actualSessionId,
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
      summary = await summarizeShortTranscript(transcript, sessionId);
    } else {
      summary = await summarizeLongTranscript(transcript, sessionId);
    }

    // Record success for circuit breaker
    recordSuccess();

    logger.info("Transcript summarization completed", {
      extra: {
        footprint: null,
        batch_uuid: actualSessionId,
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
    // Record failure for circuit breaker
    recordFailure();
    
    logger.error("Transcript summarization failed", {
      extra: {
        footprint: null,
        batch_uuid: actualSessionId,
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

// Default fallback blueprint template when file is missing
const FALLBACK_BLUEPRINT = `# Meeting Minutes — {{DATE}}

## Meeting Topic
{{TOPIC}}

## Meeting Objective
{{OBJECTIVE}}

## Details
- **Date:** {{DATE}}
- **Participants:** {{PARTICIPANTS}}

---

## Key Points / Resolutions
{{KEY_POINTS}}

## Decisions
{{DECISIONS}}

## Risks & Dependencies
{{RISKS}}

## Action Items
| # | Task | Owner | Due | Status |
|---|------|-------|-----|--------|
{{ACTION_ITEMS}}

## Minutes Prepared By
Automated Meeting Bot — {{TIMESTAMP}}
`;

/**
 * Load the meeting minutes blueprint template
 * Falls back to a built-in template if the file is missing
 * @returns {string} Blueprint template content
 */
function loadBlueprint() {
  const blueprintPath = path.join(process.cwd(), 'meeting_minutes_blueprint.md');
  
  try {
    if (!fs.existsSync(blueprintPath)) {
      logger.warn("Meeting minutes blueprint file not found, using fallback template", {
        extra: {
          footprint: null,
          batch_uuid: null,
          user_id: null,
          event_id: uuidv4(),
          action: "blueprint_load",
          event: "fallback",
          expected_path: blueprintPath
        }
      });
      return FALLBACK_BLUEPRINT;
    }
    
    return fs.readFileSync(blueprintPath, 'utf-8');
  } catch (err) {
    logger.error("Failed to load meeting minutes blueprint, using fallback", {
      extra: {
        footprint: null,
        batch_uuid: null,
        user_id: null,
        event_id: uuidv4(),
        action: "blueprint_load",
        event: "error",
        error_message: err.message
      }
    });
    return FALLBACK_BLUEPRINT;
  }
}

/**
 * Summarize a short transcript (< 6000 tokens)
 */
async function summarizeShortTranscript(transcript, sessionId) {
  const blueprint = loadBlueprint();

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

  return completion.choices[0].message.content.trim();
}

/**
 * Summarize a single chunk of transcript
 * @param {string} chunk - Text chunk to summarize
 * @param {number} index - Chunk index (0-based)
 * @param {number} total - Total number of chunks
 * @param {string} sessionId - Session identifier for logging
 * @returns {Promise<{index: number, summary: string}>} Chunk summary with index
 */
async function summarizeChunk(chunk, index, total, sessionId) {
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
      chunk_index: index + 1,
      total_chunks: total
    }
  });

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

TRANSCRIPT SECTION ${index + 1} of ${total}:
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

  logger.info("Transcript chunk processed", {
    extra: {
      footprint: null,
      batch_uuid: sessionId,
      user_id: null,
      event_id: chunkEventId,
      action: "chunk_summarization",
      event: "complete",
      duration_ms: calculateDurationMs(chunkStartTime),
      chunk_index: index + 1
    }
  });

  return { index, summary: partialSummary };
}

/**
 * Summarize a long transcript (> 6000 tokens) using parallel chunking
 * Uses Promise.all for parallel processing to improve performance
 * @param {string} transcript - Full transcript text
 * @param {string} sessionId - Session identifier for logging
 * @returns {Promise<string>} Consolidated summary
 */
async function summarizeLongTranscript(transcript, sessionId) {
  const parallelEventId = uuidv4();
  const parallelStartTime = Date.now();
  
  logger.info("Transcript requires chunking - using parallel processing", {
    extra: {
      footprint: null,
      batch_uuid: sessionId,
      user_id: null,
      event_id: parallelEventId,
      action: "transcript_summarization",
      event: "parallel_start"
    }
  });

  const textChunks = chunkTextByTokens(transcript, 6000);
  
  // Limit parallel requests to avoid rate limiting (max 3 concurrent)
  const MAX_PARALLEL = 3;
  const partialSummaries = new Array(textChunks.length);
  
  // Process chunks in batches for controlled parallelism
  for (let batchStart = 0; batchStart < textChunks.length; batchStart += MAX_PARALLEL) {
    const batchEnd = Math.min(batchStart + MAX_PARALLEL, textChunks.length);
    const batchChunks = textChunks.slice(batchStart, batchEnd);
    
    logger.debug("Processing chunk batch", {
      extra: {
        footprint: null,
        batch_uuid: sessionId,
        user_id: null,
        event_id: uuidv4(),
        action: "chunk_batch",
        event: "start",
        batch_start: batchStart + 1,
        batch_end: batchEnd,
        total_chunks: textChunks.length
      }
    });
    
    // Process batch in parallel
    const batchPromises = batchChunks.map((chunk, batchIndex) => 
      summarizeChunk(chunk, batchStart + batchIndex, textChunks.length, sessionId)
    );
    
    const batchResults = await Promise.all(batchPromises);
    
    // Store results in correct order
    for (const result of batchResults) {
      partialSummaries[result.index] = result.summary;
    }
    
    // Small delay between batches to respect rate limits
    if (batchEnd < textChunks.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  logger.info("All chunks processed in parallel", {
    extra: {
      footprint: null,
      batch_uuid: sessionId,
      user_id: null,
      event_id: parallelEventId,
      action: "transcript_summarization",
      event: "parallel_complete",
      duration_ms: calculateDurationMs(parallelStartTime),
      total_chunks: textChunks.length
    }
  });

  // Final consolidation
  const blueprint = loadBlueprint();
  const finalInput = partialSummaries.filter(s => s).join('\n\n---\n\n');

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

  return finalCompletion.choices[0].message.content.trim();
}
