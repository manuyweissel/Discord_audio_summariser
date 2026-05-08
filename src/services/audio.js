import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import prism from 'prism-media';
import { EndBehaviorType } from '@discordjs/voice';
import { v4 as uuidv4 } from 'uuid';
import { AUDIO_DIR } from '../config.js';
import logger from '../logger.js';
import { calculateDurationMs } from '../utils/index.js';
import {
  addAudioEntry,
  markSkipped,
  getOrCreateSession
} from './manifest.js';

// Minimum file size for transcription (~1 second at 24kHz mono 16-bit)
// 24000 samples/sec * 2 bytes/sample = 48000 bytes/sec + 44 byte WAV header
const MIN_TRANSCRIPTION_SIZE = 48000;

// Maximum audio file size for Whisper (25MB)
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;

/**
 * Audio capture result
 * @typedef {Object} AudioCaptureResult
 * @property {string|null} wavPath - Path to the WAV file
 * @property {string|null} entryId - Manifest entry ID
 * @property {number} fileSize - File size in bytes
 * @property {boolean} tooSmall - Whether file was too small for transcription
 */

/**
 * Capture audio from a user in a voice channel
 * @param {VoiceConnection} connection - Discord voice connection
 * @param {string} userId - User ID to capture audio from
 * @param {string} username - Username for manifest tracking
 * @returns {Promise<AudioCaptureResult>} Capture result with file info
 */
export async function captureUserAudio(connection, userId, username = 'Unknown') {
  const captureEventId = uuidv4();
  const sessionId = `${connection.joinConfig.guildId}:${connection.joinConfig.channelId}`;
  const startTime = Date.now();

  console.log(`🔊 Creating audio subscription for ${username}`);

  // Ensure session exists in manifest
  const [guildId, channelId] = sessionId.split(':');
  getOrCreateSession(sessionId, guildId, channelId);

  // 1) Start receiving Opus (silence-based batching)
  // Increased silence duration to 2.5s to better handle noisy connections
  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 2500 }
  });
  // Avoid listener leak warnings on bursty sessions
  opusStream.setMaxListeners(25);

  // 2) Decode to raw 48kHz stereo PCM
  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960
  });
  
  // Track audio data stats
  let receivedAnyData = false;
  let opusPacketCount = 0;
  let decodeErrorCount = 0;
  
  // Handle opus stream errors (e.g., user disconnects mid-speech)
  opusStream.on('error', (err) => {
    console.warn(`⚠️ Opus stream error for ${username}: ${err.message}`);
  });
  
  // Track data reception and packet count
  // Each Opus packet is ~20ms of audio, so 50 packets ≈ 1 second
  opusStream.on('data', () => {
    receivedAnyData = true;
    opusPacketCount++;
  });
  
  // Handle decoder errors (e.g., corrupted packets)
  decoder.on('error', (err) => {
    decodeErrorCount++;
    // Only log first few errors to avoid spam
    if (decodeErrorCount <= 3) {
      console.warn(`⚠️ Decoder error for ${username}: ${err.message}`);
    }
  });
  
  const pcmStream = opusStream.pipe(decoder);

  // 3) Generate a unique filename with session info
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const wavPath = path.join(AUDIO_DIR, `${guildId}-${channelId}-${ts}-${userId}.wav`);

  // 4) Pipe raw PCM into ffmpeg, convert to 24kHz mono with noise reduction
  const ff = spawn(ffmpegPath, [
    '-y',
    '-loglevel', 'error',
    '-f', 's16le',     // input is raw 16-bit PCM
    '-ar', '48000',    // 48k sampling rate
    '-ac', '2',        // stereo
    '-i', 'pipe:0',    // read from stdin
    // Audio enhancement for better speech recognition
    '-af', 'loudnorm=I=-23:TP=-2:LRA=7,highpass=f=120,lowpass=f=3800,volume=1.2',
    '-ac', '1',        // convert to mono
    '-ar', '24000',    // 24 kHz (better for Whisper)
    '-acodec', 'pcm_s16le', // 16-bit PCM
    '-f', 'wav',
    wavPath,           // output file
  ]);

  pcmStream.pipe(ff.stdin);

  return new Promise((resolve, reject) => {
    let resolved = false;
    let finalizing = false;
    let finalizeForceKillTimeout = null;
    
    /**
     * Cleanup function to properly release all resources
     * Ensures ffmpeg is killed and streams are cleaned up
     */
    const cleanup = () => {
      try {
        opusStream.removeAllListeners();
        decoder.removeAllListeners();
        opusStream.destroy();
        decoder.destroy();
      } catch (e) {
        // Ignore cleanup errors
      }
    };
    
    /**
     * Safe resolve that prevents double resolution
     */
    const safeResolve = (result) => {
      if (resolved) return;
      resolved = true;
      if (finalizeForceKillTimeout) {
        clearTimeout(finalizeForceKillTimeout);
        finalizeForceKillTimeout = null;
      }
      cleanup();
      resolve(result);
    };

    /**
     * Gracefully stop capture and let ffmpeg flush whatever audio has already arrived.
     * This preserves partial recordings instead of discarding them on timeout/stream issues.
     */
    const finalizePartialCapture = (reason) => {
      if (resolved || finalizing) return;
      finalizing = true;

      console.log(`🛑 Finalizing partial capture for ${username} (${reason})`);

      try {
        opusStream.unpipe(decoder);
      } catch (e) {
        // Ignore unpipe errors
      }

      try {
        decoder.unpipe(ff.stdin);
      } catch (e) {
        // Ignore unpipe errors
      }

      try {
        opusStream.destroy();
      } catch (e) {
        // Ignore stream shutdown errors
      }

      try {
        decoder.end();
      } catch (e) {
        // Ignore decoder shutdown errors
      }

      try {
        ff.stdin.end();
      } catch (e) {
        // Ignore stdin close errors
      }

      finalizeForceKillTimeout = setTimeout(() => {
        if (resolved) return;

        try {
          ff.kill('SIGTERM');
        } catch (e) {
          // Ignore kill errors
        }

        safeResolve({
          wavPath: null,
          entryId: null,
          fileSize: 0,
          tooSmall: false,
          error: `Capture finalization timeout (${reason})`
        });
      }, 5000);
    };

    // Handle stream errors - ensure ff.kill() is called
    pcmStream.on('error', (error) => {
      logger.error("PCM stream error during audio capture", {
        extra: {
          footprint: null,
          batch_uuid: sessionId,
          user_id: userId,
          event_id: captureEventId,
          action: "audio_capture",
          event: "error",
          duration_ms: calculateDurationMs(startTime),
          error_message: error.message
        }
      });

      if (receivedAnyData || opusPacketCount > 0) {
        finalizePartialCapture(`stream error: ${error.message}`);
        return;
      }

      // Kill ffmpeg process on stream error when there is nothing to salvage
      try {
        ff.kill('SIGTERM');
      } catch (e) {
        // Ignore kill errors
      }

      safeResolve({
        wavPath: null,
        entryId: null,
        fileSize: 0,
        tooSmall: false,
        error: `Stream error: ${error.message}`
      });
    });

    ff.on('close', code => {
      if (resolved) return;
      
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
        safeResolve({
          wavPath: null,
          entryId: null,
          fileSize: 0,
          tooSmall: false,
          error: `ffmpeg exit code ${code}`
        });
        return;
      }

      // We have a valid WAV at wavPath
      const fileSize = fs.existsSync(wavPath) ? fs.statSync(wavPath).size : 0;
      console.log(`📊 Audio file ${path.basename(wavPath)} - ${username}: ${fileSize} bytes`);

      if (fileSize === 0) {
        // No audio captured at all
        if (fs.existsSync(wavPath)) {
          fs.unlinkSync(wavPath);
        }
        safeResolve({
          wavPath: null,
          entryId: null,
          fileSize: 0,
          tooSmall: true,
          error: 'No audio captured'
        });
        return;
      }

      // Check if file exceeds Whisper's 25MB limit
      if (fileSize > MAX_AUDIO_FILE_SIZE) {
        logger.warn("Audio file exceeds Whisper limit", {
          extra: {
            footprint: null,
            batch_uuid: sessionId,
            user_id: userId,
            event_id: captureEventId,
            action: "audio_capture",
            event: "warning",
            file_size: fileSize,
            max_size: MAX_AUDIO_FILE_SIZE
          }
        });
        console.log(`⚠️ Audio file ${path.basename(wavPath)} exceeds 25MB limit (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
        
        // Still save to manifest but mark for splitting
        const entry = addAudioEntry(sessionId, wavPath, userId, username, fileSize);
        markSkipped(entry.id, `File too large: ${(fileSize / 1024 / 1024).toFixed(2)} MB > 25MB limit`);
        
        safeResolve({
          wavPath,
          entryId: entry.id,
          fileSize,
          tooSmall: false,
          tooLarge: true,
          error: 'File exceeds 25MB Whisper limit'
        });
        return;
      }

      // Always save the file and add to manifest
      const entry = addAudioEntry(sessionId, wavPath, userId, username, fileSize);

      if (fileSize < MIN_TRANSCRIPTION_SIZE) {
        // Audio too short for transcription (< 1 sec), this is normal for brief sounds
        const durationSec = (fileSize / 48000).toFixed(1);
        console.log(`⏱️ ${username}: Short audio (${durationSec}s) - skipping transcription`);
        markSkipped(entry.id, `File too small: ${fileSize} bytes`);

        safeResolve({
          wavPath,
          entryId: entry.id,
          fileSize,
          tooSmall: true,
          error: null
        });
      } else {
        console.log(`📁 Saved ${path.basename(wavPath)} (${(fileSize / 1024).toFixed(1)} kB) - Entry: ${entry.id.substr(0, 8)}...`);

        safeResolve({
          wavPath,
          entryId: entry.id,
          fileSize,
          tooSmall: false,
          error: null
        });
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
          duration_ms: calculateDurationMs(startTime),
          error_message: error.message
        }
      }, error);

      // Ensure ffmpeg is killed on error
      try {
        ff.kill('SIGTERM');
      } catch (e) {
        // Ignore kill errors
      }

      safeResolve({
        wavPath: null,
        entryId: null,
        fileSize: 0,
        tooSmall: false,
        error: error.message
      });
    });

    // Early timeout: fail fast if truly no audio data after 10 seconds
    // This catches broken clients, but allows short sounds to complete naturally
    const noDataTimeout = setTimeout(() => {
      if (!resolved && !receivedAnyData) {
        // Truly no data at all - likely a client issue
        // Common causes:
        // 1. User muted at system/Discord level (VAD still triggers on noise)
        // 2. Push-to-Talk enabled but key not pressed
        // 3. Mobile app audio routing issues
        // 4. Privacy settings blocking audio to bots
        // 5. Network packet loss
        console.log(`⚡ ${username}: No audio packets received (VAD triggered but mic may be muted/PTT not held)`);
        
        try {
          ff.kill('SIGTERM');
        } catch (e) {
          // Ignore kill errors
        }
        
        safeResolve({
          wavPath: null,
          entryId: null,
          fileSize: 0,
          tooSmall: false,
          error: 'No audio packets (muted/PTT/client issue)'
        });
      }
    }, 10000);

    // Set a timeout to prevent hanging captures
    const captureTimeout = setTimeout(() => {
      if (!resolved) {
        logger.warn("Audio capture timeout", {
          extra: {
            footprint: null,
            batch_uuid: sessionId,
            user_id: userId,
            event_id: captureEventId,
            action: "audio_capture",
            event: "timeout",
            duration_ms: calculateDurationMs(startTime),
            received_any_data: receivedAnyData,
            opus_packet_count: opusPacketCount,
            decode_error_count: decodeErrorCount
          }
        });

        if (receivedAnyData || opusPacketCount > 0) {
          finalizePartialCapture('capture timeout');
          return;
        }

        try {
          ff.kill('SIGTERM');
        } catch (e) {
          // Ignore kill errors
        }

        safeResolve({
          wavPath: null,
          entryId: null,
          fileSize: 0,
          tooSmall: false,
          error: 'Capture timeout'
        });
      }
    }, 45000); // 45 second timeout - prevents stuck captures while allowing longer speeches

    // Clear timeouts when resolved
    const clearAllTimeouts = () => {
      clearTimeout(noDataTimeout);
      clearTimeout(captureTimeout);
    };
    ff.on('close', clearAllTimeouts);
    ff.on('error', clearAllTimeouts);
  });
}
