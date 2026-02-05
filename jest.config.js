/**
 * Jest Configuration for Discord Voice Bot
 * 
 * Uses ES modules and requires Node.js experimental VM modules flag.
 * Run tests with: npm test
 */

export default {
  // Use ES modules
  testEnvironment: 'node',
  
  // Transform files using ES module syntax
  transform: {},
  
  // Test file patterns
  testMatch: [
    '**/test/**/*.test.js',
    '**/test/**/*.spec.js'
  ],
  
  // Module file extensions
  moduleFileExtensions: ['js', 'mjs', 'json'],
  
  // Coverage settings
  collectCoverageFrom: [
    'src/utils/**/*.js',
    'src/services/**/*.js',
    '!src/**/*.test.js'
  ],
  
  // Timeout for async tests
  testTimeout: 10000,
  
  // Verbose output
  verbose: true,
  
  // Force exit after tests complete
  forceExit: true,
  
  // Detect open handles
  detectOpenHandles: true
};

