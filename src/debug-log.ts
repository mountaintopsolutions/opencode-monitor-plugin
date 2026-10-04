import { appendFile, chmod, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REDACT_KEY = /token|secret|password|authorization|credential/i;
const MAX_STRING = 500;

/**
 * Cap on the debug log. Debug logging is on by default (it is the only window
 * into job output and delivery), and one line is written per output line, so an
 * unattended server grew the file without limit — 37 MB after one debugging
 * session. The log is diagnostic output, so it is dropped rather than rotated:
 * the oldest lines are the least useful and keeping N generations costs disk for
 * no benefit.
 */
const MAX_DEBUG_LOG_BYTES = 8 * 1024 * 1024;

/** Remove the log once it grows past `maxBytes`. No-op if it is missing. */
export async function capDebugLog(file: string, maxBytes = MAX_DEBUG_LOG_BYTES): Promise<void> {
  const info = await stat(file).catch(() => undefined);
  if (info && info.size > maxBytes) await rm(file, { force: true });
}

export function monitorDebugLogPath(): string {
  return process.env.OPENCODE_MONITOR_DEBUG_LOG
    || join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'opencode-monitor', 'debug.log');
}

function safeValue(value: unknown, key = ''): unknown {
  if (REDACT_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated:${value.length}]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[k] = safeValue(v, k);
    }
    return out;
  }
  return String(value);
}

export function monitorDebug(event: string, data: Record<string, unknown> = {}): void {
  if (process.env.OPENCODE_MONITOR_DEBUG === '0') return;
  const file = monitorDebugLogPath();
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...safeValue(data) as Record<string, unknown>,
  })}\n`;
  void mkdir(dirname(file), { recursive: true, mode: 0o700 })
    .then(() => capDebugLog(file))
    .then(() => appendFile(file, line, { mode: 0o600 }))
    .then(() => chmod(file, 0o600).catch(() => {}))
    .catch(() => {});
}
