/**
 * Unit tests for utility functions
 * Run with: npm test
 */

import { jest } from '@jest/globals';

// Mock tiktoken before importing helpers
jest.unstable_mockModule('tiktoken', () => ({
  encoding_for_model: jest.fn(() => ({
    encode: jest.fn((str) => {
      // Simple mock: return array with length ~1/4 of string length
      const tokens = [];
      for (let i = 0; i < Math.ceil(str.length / 4); i++) {
        tokens.push(i);
      }
      return tokens;
    }),
    free: jest.fn()
  }))
}));

// Import after mocking
const { approximateTokens, chunkTextByTokens, calculateDurationMs, cleanupTokenizer } = 
  await import('../src/utils/helpers.js');

describe('calculateDurationMs', () => {
  test('should calculate correct duration', () => {
    const start = Date.now() - 1000;
    const duration = calculateDurationMs(start);
    expect(duration).toBeGreaterThanOrEqual(1000);
    expect(duration).toBeLessThan(1100); // Allow small margin
  });

  test('should return 0 for current time', () => {
    const duration = calculateDurationMs(Date.now());
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(10);
  });
});

describe('approximateTokens', () => {
  test('should return 0 for empty string', () => {
    expect(approximateTokens('')).toBe(0);
  });

  test('should return 0 for null/undefined', () => {
    expect(approximateTokens(null)).toBe(0);
    expect(approximateTokens(undefined)).toBe(0);
  });

  test('should estimate tokens for text', () => {
    const text = 'This is a test sentence with some words.';
    const tokens = approximateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length); // Should be fewer tokens than characters
  });

  test('should handle long text', () => {
    const longText = 'Lorem ipsum dolor sit amet. '.repeat(1000);
    const tokens = approximateTokens(longText);
    expect(tokens).toBeGreaterThan(1000);
    expect(tokens).toBeLessThan(longText.length);
  });
});

describe('chunkTextByTokens', () => {
  test('should return empty array for empty input', () => {
    expect(chunkTextByTokens('')).toEqual([]);
    expect(chunkTextByTokens('   ')).toEqual([]);
  });

  test('should return single chunk for short text', () => {
    const shortText = 'This is a short sentence.';
    const chunks = chunkTextByTokens(shortText, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(shortText);
  });

  test('should split long text into multiple chunks', () => {
    const longText = 'This is a test sentence. '.repeat(500);
    const chunks = chunkTextByTokens(longText, 100);
    expect(chunks.length).toBeGreaterThan(1);
    
    // Verify all content is preserved
    const joined = chunks.join(' ');
    expect(joined.replace(/\s+/g, ' ')).toContain('This is a test sentence');
  });

  test('should respect sentence boundaries when possible', () => {
    const text = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.';
    const chunks = chunkTextByTokens(text, 10);
    
    // Each chunk should ideally end with a sentence boundary
    for (const chunk of chunks) {
      if (chunk.length > 0) {
        // Chunk should contain complete words
        expect(chunk).not.toMatch(/\b\w$/); // Should not end mid-word
      }
    }
  });

  test('should handle text with paragraph breaks', () => {
    const text = 'First paragraph with content.\n\nSecond paragraph with more content.\n\nThird paragraph.';
    const chunks = chunkTextByTokens(text, 15);
    
    expect(chunks.length).toBeGreaterThan(0);
    // Content should be preserved
    const joined = chunks.join('\n\n');
    expect(joined).toContain('First paragraph');
    expect(joined).toContain('Second paragraph');
  });

  test('should not produce empty chunks', () => {
    const text = 'Test content. '.repeat(100);
    const chunks = chunkTextByTokens(text, 50);
    
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('cleanupTokenizer', () => {
  test('should not throw when called', () => {
    expect(() => cleanupTokenizer()).not.toThrow();
  });
});

