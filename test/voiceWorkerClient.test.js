import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { jest } from '@jest/globals';

function createFakeProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter();

  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = jest.fn();
  proc.stdin = {
    writes: [],
    write: jest.fn((chunk) => {
      proc.stdin.writes.push(chunk);
      return true;
    })
  };

  return proc;
}

describe('voiceWorkerClient', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.VOICE_BACKEND = 'python';
    process.env.VOICE_WORKER_PYTHON = '/usr/bin/python3';
  });

  afterEach(async () => {
    const mod = await import('../src/services/voiceWorkerClient.js');
    await mod.shutdownVoiceWorker().catch(() => null);
  });

  test('starts the worker and correlates request/response messages', async () => {
    const fakeProcess = createFakeProcess();

    jest.unstable_mockModule('node:child_process', () => ({
      spawn: jest.fn(() => fakeProcess)
    }));

    const {
      startVoiceWorker,
      ensureVoiceWorkerReady,
      shutdownVoiceWorker
    } = await import('../src/services/voiceWorkerClient.js');

    const startPromise = startVoiceWorker();
    setTimeout(() => {
      fakeProcess.stdout.write(`${JSON.stringify({ type: 'ready', payload: { ok: true } })}\n`);
    }, 0);
    await expect(startPromise).resolves.toBe(true);

    const readyPromise = ensureVoiceWorkerReady();
    const requestLine = fakeProcess.stdin.writes.at(-1);
    const request = JSON.parse(requestLine);
    setTimeout(() => {
      fakeProcess.stdout.write(`${JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        success: true,
        payload: { ready: true }
      })}\n`);
    }, 0);

    await expect(readyPromise).resolves.toBe(true);
    await shutdownVoiceWorker();
  }, 20000);
});
