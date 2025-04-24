import 'dotenv/config';
import fs from 'fs';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Make sure you have this set!
});

(async () => {
  try {
    const resp = await openai.audio.transcriptions.create({
      // Change this to the file you want to test
      file: fs.createReadStream('2025-04-24T10-06-13.547Z.wav'),
      model: 'whisper-1',
    });

    console.log('Transcribed text:', resp.text);
  } catch (err) {
    // Log the entire error response
    console.error('Transcription error:', err.response?.data || err.message);
  }
})();
