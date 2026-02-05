// ---------- Helper Functions ----------

// Lazy-load tiktoken encoder to avoid startup issues with native bindings
let cachedEncoder = null;
let tiktokenModule = null;
let tiktokenLoadAttempted = false;

/**
 * Dynamically load tiktoken module
 * Returns null if tiktoken is not available
 */
async function loadTiktoken() {
  if (tiktokenLoadAttempted) {
    return tiktokenModule;
  }
  
  tiktokenLoadAttempted = true;
  
  try {
    tiktokenModule = await import('tiktoken');
    console.log('✅ tiktoken loaded successfully');
    return tiktokenModule;
  } catch (err) {
    console.warn('⚠️ tiktoken not available, using fallback token estimation');
    console.warn(`   Reason: ${err.message}`);
    return null;
  }
}

/**
 * Get or create the tiktoken encoder
 * Uses gpt-4 encoding which is compatible with GPT-4o
 * @returns {Object|null} Tiktoken encoder instance or null if unavailable
 */
function getEncoder() {
  if (!tiktokenModule) {
    return null;
  }
  
  if (!cachedEncoder) {
    try {
      cachedEncoder = tiktokenModule.encoding_for_model('gpt-4');
    } catch (err) {
      console.warn('⚠️ tiktoken encoder initialization failed, using fallback estimation');
      return null;
    }
  }
  return cachedEncoder;
}

// Initialize tiktoken asynchronously on module load
loadTiktoken();

/**
 * Calculate duration in milliseconds from a start time
 * @param {number} startTime - Start timestamp from Date.now()
 * @returns {number} Duration in milliseconds
 */
export function calculateDurationMs(startTime) {
  return Date.now() - startTime;
}

/**
 * Count tokens in a string using tiktoken for accurate estimation
 * Falls back to heuristic estimation (4 chars per token) if tiktoken unavailable
 * @param {string} str - Input string to count tokens for
 * @returns {number} Estimated token count
 */
export function approximateTokens(str) {
  if (!str) return 0;
  
  const encoder = getEncoder();
  if (encoder) {
    try {
      const tokens = encoder.encode(str);
      return tokens.length;
    } catch (err) {
      // Fall back to heuristic if encoding fails
      console.warn('⚠️ tiktoken encoding failed, using fallback');
    }
  }
  
  // Fallback heuristic: roughly 4 characters per token for English text
  // Adjusted to be slightly conservative for safety
  return Math.ceil(str.length / 3.5);
}

/**
 * Find a good break point in text (sentence or paragraph boundary)
 * @param {string} text - Text to find break point in
 * @param {number} targetPosition - Target position to break near
 * @param {number} searchWindow - How far to search from target position
 * @returns {number} Position of best break point
 */
function findBreakPoint(text, targetPosition, searchWindow = 500) {
  const searchStart = Math.max(0, targetPosition - searchWindow);
  const searchEnd = Math.min(text.length, targetPosition + searchWindow);
  const searchText = text.slice(searchStart, searchEnd);
  
  // Priority 1: Paragraph break (double newline)
  const paragraphBreaks = [...searchText.matchAll(/\n\n/g)];
  if (paragraphBreaks.length > 0) {
    // Find the break closest to the target
    let bestBreak = paragraphBreaks[0];
    let bestDistance = Math.abs(searchStart + bestBreak.index - targetPosition);
    
    for (const match of paragraphBreaks) {
      const distance = Math.abs(searchStart + match.index - targetPosition);
      if (distance < bestDistance) {
        bestBreak = match;
        bestDistance = distance;
      }
    }
    return searchStart + bestBreak.index + 2; // +2 to include both newlines
  }
  
  // Priority 2: Sentence ending (., !, ?)
  const sentenceEnds = [...searchText.matchAll(/[.!?]\s+/g)];
  if (sentenceEnds.length > 0) {
    let bestBreak = sentenceEnds[0];
    let bestDistance = Math.abs(searchStart + bestBreak.index - targetPosition);
    
    for (const match of sentenceEnds) {
      const distance = Math.abs(searchStart + match.index - targetPosition);
      if (distance < bestDistance) {
        bestBreak = match;
        bestDistance = distance;
      }
    }
    return searchStart + bestBreak.index + bestBreak[0].length;
  }
  
  // Priority 3: Single newline
  const newlines = [...searchText.matchAll(/\n/g)];
  if (newlines.length > 0) {
    let bestBreak = newlines[0];
    let bestDistance = Math.abs(searchStart + bestBreak.index - targetPosition);
    
    for (const match of newlines) {
      const distance = Math.abs(searchStart + match.index - targetPosition);
      if (distance < bestDistance) {
        bestBreak = match;
        bestDistance = distance;
      }
    }
    return searchStart + bestBreak.index + 1;
  }
  
  // Priority 4: Space between words
  const spaces = [...searchText.matchAll(/\s+/g)];
  if (spaces.length > 0) {
    let bestBreak = spaces[0];
    let bestDistance = Math.abs(searchStart + bestBreak.index - targetPosition);
    
    for (const match of spaces) {
      const distance = Math.abs(searchStart + match.index - targetPosition);
      if (distance < bestDistance) {
        bestBreak = match;
        bestDistance = distance;
      }
    }
    return searchStart + bestBreak.index + bestBreak[0].length;
  }
  
  // Fallback: use target position directly
  return targetPosition;
}

/**
 * Chunk text into segments based on token count while respecting sentence/paragraph boundaries
 * Uses smart chunking to avoid breaking in the middle of sentences
 * @param {string} text - Input text to chunk
 * @param {number} maxTokens - Maximum tokens per chunk (default: 6000)
 * @returns {string[]} Array of text chunks
 */
export function chunkTextByTokens(text, maxTokens = 6000) {
  if (!text || text.trim().length === 0) {
    return [];
  }
  
  const chunks = [];
  const encoder = getEncoder();
  
  // If we can use tiktoken, use accurate token counting
  if (encoder) {
    let remaining = text;
    
    while (remaining.length > 0) {
      // Start with an estimate based on character count
      let estimatedChars = maxTokens * 3.5; // Conservative estimate
      let chunk = remaining.slice(0, Math.min(estimatedChars, remaining.length));
      
      // Adjust chunk size to fit within token limit
      let tokens = encoder.encode(chunk);
      
      // If too many tokens, reduce chunk size
      while (tokens.length > maxTokens && chunk.length > 100) {
        chunk = chunk.slice(0, Math.floor(chunk.length * 0.9));
        tokens = encoder.encode(chunk);
      }
      
      // If still within limit, try to extend to a natural break point
      if (chunk.length < remaining.length) {
        const breakPoint = findBreakPoint(remaining, chunk.length);
        
        // Verify the break point doesn't exceed token limit
        const extendedChunk = remaining.slice(0, breakPoint);
        const extendedTokens = encoder.encode(extendedChunk);
        
        if (extendedTokens.length <= maxTokens) {
          chunk = extendedChunk;
        } else {
          // Find a break point before the current position
          const shorterBreak = findBreakPoint(remaining, Math.floor(chunk.length * 0.8));
          const shorterChunk = remaining.slice(0, shorterBreak);
          const shorterTokens = encoder.encode(shorterChunk);
          
          if (shorterTokens.length <= maxTokens) {
            chunk = shorterChunk;
          }
        }
      }
      
      chunks.push(chunk.trim());
      remaining = remaining.slice(chunk.length).trim();
    }
  } else {
    // Fallback: use character-based chunking with smart breaks
    const maxChars = maxTokens * 3.5;
    let remaining = text;
    
    while (remaining.length > 0) {
      if (remaining.length <= maxChars) {
        chunks.push(remaining.trim());
        break;
      }
      
      // Find a good break point near the max chars limit
      const breakPoint = findBreakPoint(remaining, maxChars);
      const chunk = remaining.slice(0, breakPoint);
      
      chunks.push(chunk.trim());
      remaining = remaining.slice(breakPoint).trim();
    }
  }
  
  return chunks.filter(chunk => chunk.length > 0);
}

/**
 * Free the tiktoken encoder resources when shutting down
 * Should be called during graceful shutdown
 */
export function cleanupTokenizer() {
  if (cachedEncoder) {
    try {
      cachedEncoder.free();
      cachedEncoder = null;
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}
