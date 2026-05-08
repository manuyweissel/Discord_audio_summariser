import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

describe('voiceCaptureSpool', () => {
  const originalCwd = process.cwd();
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-spool-test-'));
    process.chdir(tempDir);
    jest.resetModules();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('lists, reads, and deletes spool records', async () => {
    const { getVoiceCaptureSpoolDir, listVoiceCaptureSpoolFiles, readVoiceCaptureSpoolRecord, deleteVoiceCaptureSpoolRecord } =
      await import('../src/services/voiceCaptureSpool.js');

    const spoolDir = getVoiceCaptureSpoolDir();
    await fs.mkdir(spoolDir, { recursive: true });

    const payload = { eventId: 'event-1', sessionId: 'guild:channel' };
    const filePath = path.join(spoolDir, 'event-1.json');
    await fs.writeFile(filePath, JSON.stringify(payload), 'utf-8');

    const files = await listVoiceCaptureSpoolFiles();
    expect(files).toEqual([filePath]);

    const record = await readVoiceCaptureSpoolRecord(filePath);
    expect(record).toEqual(payload);

    await deleteVoiceCaptureSpoolRecord(filePath);
    expect(await listVoiceCaptureSpoolFiles()).toEqual([]);
  });
});
