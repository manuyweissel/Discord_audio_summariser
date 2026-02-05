/**
 * Unit tests for concurrency management
 * Run with: npm test
 */

import { jest } from '@jest/globals';

const { 
  withSessionConcurrency, 
  clearSessionConcurrency,
  getSessionConcurrencyState,
  getAllConcurrencySessions
} = await import('../src/utils/concurrency.js');

describe('withSessionConcurrency', () => {
  beforeEach(() => {
    // Clear all sessions before each test
    for (const sessionId of getAllConcurrencySessions()) {
      clearSessionConcurrency(sessionId);
    }
  });

  test('should execute function immediately when under limit', async () => {
    const mockFn = jest.fn().mockResolvedValue('result');
    
    const result = await withSessionConcurrency('session1', mockFn, 2);
    
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(result).toBe('result');
  });

  test('should queue operations when at limit', async () => {
    const executionOrder = [];
    
    const slowFn = (id) => async () => {
      executionOrder.push(`start-${id}`);
      await new Promise(resolve => setTimeout(resolve, 50));
      executionOrder.push(`end-${id}`);
      return id;
    };
    
    // Start 3 operations with limit of 2
    const p1 = withSessionConcurrency('session1', slowFn(1), 2);
    const p2 = withSessionConcurrency('session1', slowFn(2), 2);
    const p3 = withSessionConcurrency('session1', slowFn(3), 2);
    
    // First two should start immediately
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(executionOrder).toContain('start-1');
    expect(executionOrder).toContain('start-2');
    expect(executionOrder).not.toContain('start-3');
    
    // Wait for all to complete
    await Promise.all([p1, p2, p3]);
    
    // Third should have started after one of the first two finished
    expect(executionOrder).toContain('start-3');
    expect(executionOrder).toContain('end-3');
  });

  test('should handle errors without blocking queue', async () => {
    const errorFn = async () => {
      throw new Error('Test error');
    };
    
    const successFn = jest.fn().mockResolvedValue('success');
    
    // First call throws error
    const p1 = withSessionConcurrency('session1', errorFn, 1);
    const p2 = withSessionConcurrency('session1', successFn, 1);
    
    await expect(p1).rejects.toThrow('Test error');
    
    // Second call should still execute
    const result = await p2;
    expect(result).toBe('success');
    expect(successFn).toHaveBeenCalled();
  });

  test('should maintain separate limits per session', async () => {
    const session1Order = [];
    const session2Order = [];
    
    const fn1 = async () => {
      session1Order.push('start');
      await new Promise(resolve => setTimeout(resolve, 50));
      session1Order.push('end');
    };
    
    const fn2 = async () => {
      session2Order.push('start');
      await new Promise(resolve => setTimeout(resolve, 50));
      session2Order.push('end');
    };
    
    // Both sessions should run their first operation immediately
    const p1 = withSessionConcurrency('session1', fn1, 1);
    const p2 = withSessionConcurrency('session2', fn2, 1);
    
    await new Promise(resolve => setTimeout(resolve, 10));
    
    expect(session1Order).toContain('start');
    expect(session2Order).toContain('start');
    
    await Promise.all([p1, p2]);
  });
});

describe('clearSessionConcurrency', () => {
  test('should return true when clearing existing session', async () => {
    // Create session state
    await withSessionConcurrency('session1', async () => 'test', 2);
    
    const result = clearSessionConcurrency('session1');
    expect(result).toBe(true);
  });

  test('should return false when no session exists', () => {
    const result = clearSessionConcurrency('nonexistent');
    expect(result).toBe(false);
  });
});

describe('getSessionConcurrencyState', () => {
  beforeEach(() => {
    for (const sessionId of getAllConcurrencySessions()) {
      clearSessionConcurrency(sessionId);
    }
  });

  test('should return null for unknown session', () => {
    const state = getSessionConcurrencyState('unknown');
    expect(state).toBeNull();
  });

  test('should return state for active session', async () => {
    let resolvePromise;
    const pendingPromise = new Promise(resolve => {
      resolvePromise = resolve;
    });
    
    const p = withSessionConcurrency('session1', async () => {
      await pendingPromise;
      return 'done';
    }, 2);
    
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const state = getSessionConcurrencyState('session1');
    expect(state).not.toBeNull();
    expect(state.active).toBe(1);
    
    resolvePromise();
    await p;
  });
});

describe('getAllConcurrencySessions', () => {
  beforeEach(() => {
    for (const sessionId of getAllConcurrencySessions()) {
      clearSessionConcurrency(sessionId);
    }
  });

  test('should return empty array when no sessions exist', () => {
    const sessions = getAllConcurrencySessions();
    expect(sessions).toEqual([]);
  });

  test('should return all session IDs', async () => {
    await withSessionConcurrency('session1', async () => 'a', 2);
    await withSessionConcurrency('session2', async () => 'b', 2);
    
    const sessions = getAllConcurrencySessions();
    expect(sessions).toContain('session1');
    expect(sessions).toContain('session2');
    expect(sessions).toHaveLength(2);
  });
});

