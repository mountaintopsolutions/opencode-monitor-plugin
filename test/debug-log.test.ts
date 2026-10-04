import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capDebugLog, monitorDebug, monitorDebugLogPath } from '../src/debug-log.js';

// Debug logging is on by default and writes one line per job output line, so the
// file grew without limit. It is dropped once it passes the cap.
describe('debug log cap', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'monitor-debug-log-'));
    vi.stubEnv('OPENCODE_MONITOR_DEBUG_LOG', join(dir, 'debug.log'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('drops the log once it exceeds the cap, and keeps it under it', async () => {
    const file = join(dir, 'debug.log');
    await writeFile(file, 'x'.repeat(200));
    await capDebugLog(file, 100);
    await expect(stat(file)).rejects.toThrow();

    await writeFile(file, 'x'.repeat(50));
    await capDebugLog(file, 100);
    expect((await stat(file)).size).toBe(50);
  });

  it('does nothing when the log does not exist yet', async () => {
    await expect(capDebugLog(join(dir, 'absent.log'), 1)).resolves.toBeUndefined();
  });

  it('monitorDebug keeps working across the cap', async () => {
    const file = monitorDebugLogPath();
    for (let i = 0; i < 5; i += 1) monitorDebug('test.event', { i });
    // The write chain is fire-and-forget; the next tick's append is what proves
    // the file still gets created after a cap-triggered drop.
    await new Promise((resolve) => setTimeout(resolve, 50));
    monitorDebug('test.event', { after: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const contents = await readFile(file, 'utf8');
    expect(contents).toContain('test.event');
  });
});