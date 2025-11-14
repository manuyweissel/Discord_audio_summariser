#!/bin/bash

# WAV Files Transcription and Meeting Minutes Generator
# Script to easily run the transcription process

echo "🎙️ WAV Files Transcription & Meeting Minutes Generator"
echo "======================================================"
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️ Warning: .env file not found."
    echo "Please create a .env file with:"
    echo "OPENAI_API_KEY=your_openai_api_key_here"
    echo ""
fi

# Check if OPENAI_API_KEY is set
if [ -z "$OPENAI_API_KEY" ]; then
    echo "⚠️ Warning: OPENAI_API_KEY environment variable not set."
    echo "Please set it or add it to your .env file."
    echo ""
fi

echo "🚀 Starting transcription process..."
echo "📁 Source directory: /home/datanxt/Desktop/Product/Projects/Discord_summarise_bot/discord-voice-bot/18_08"
echo "📂 Output directory: ./batch_transcriptions/"
echo ""

# Run the transcription script
npm run transcribe-wav

echo ""
echo "✅ Transcription process completed!"
echo "Check the batch_transcriptions/ directory for your files."