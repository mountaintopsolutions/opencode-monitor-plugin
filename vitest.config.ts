import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests used to append to the same debug log the running plugin writes to, so
// every `vitest run` left its fixtures (job ids like `shared_job`, output lines
// like `ordinary-fixture`) in the user's live log — 80 KB per test file, which
// is where most of a 37 MB file came from. One shared test log rather than one
// per run, so this does not trade the leak for a litter of /tmp files;
// capDebugLog keeps it bounded.
const testLog = join(tmpdir(), 'opencode-monitor-test-debug.log');

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: {
      OPENCODE_MONITOR_DEBUG_LOG: testLog,
    },
  },
});