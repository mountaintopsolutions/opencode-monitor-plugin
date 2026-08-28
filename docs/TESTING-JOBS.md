# Testing jobs / background process handling

Guide for a fresh opencode instance (in any folder) to exercise the job and
background process handling in this plugin. Read this first if you are about to
test the server-plugin job flow and the TUI indicator.

## 1. How the plugin is loaded (global install)

The plugin is installed **globally**, not per-folder, so it loads from any
working directory:

- Config: `~/.config/opencode/opencode.jsonc` (server) + `tui.json` (TUI),
  both referencing the plugin by the file path
  `file:///Users/dale/github/opencode-monitor-plugin`.
- That path is a symlink to the repo, so `dist/index.js` (server) and
  `dist/tui.js` (TUI) are resolved through it. The `dist/` build is already
  present on disk (it is gitignored, so it lives on the filesystem, not git).

Because it is global: **run opencode from the folder where you want to test**.
The job handlers, delivery, and the sidebar indicator all key off that folder.

```bash
cd <the-new-folder>
opencode            # loads the plugin from global config
```

## 2. What the job commands do

Slash commands are templates that tell the model to call the matching tool.
Tool names:

| Slash command | Tool | Behavior |
| --- | --- | --- |
| `/background <command>` | `opencode_monitor_background` | Runs `/bin/sh -c <command>` detached. Returns a `jobID` immediately; the final capped tail is delivered to the session after the process exits (when idle). |
| `/monitor --regex <pat> [--before N] [--after N] [--debounce S] -- <command>` | `opencode_monitor_monitor` | Streams command output; delivers matching windows (with optional before/after context) as it matches. |
| `/loop <interval> <prompt>` | `opencode_monitor_loop` | Repeatedly submits a prompt. Minimum interval 10s. Busy ticks coalesce into one delivery. |
| `/schedule in <duration> <prompt>` / `at <iso>` | `opencode_monitor_schedule` | Submits once at a future time. |
| `/jobs` | `opencode_monitor_jobs` | Lists jobs for the current session. |
| `/cancel <jobID>` | `opencode_monitor_cancel` | Cancels a job owned by the current session. |

## 3. Fast smoke test (monitor) — start here

In an opencode session, paste this prompt so the model calls the monitor tool:

```text
Use opencode_monitor_monitor with raw args:
--regex OPENCODE_MONITOR_SMOKE --before 0 --after 0 --debounce 1 -- sh -c "sleep 2; printf 'OPENCODE_MONITOR_SMOKE ok\n'"
```

Expected:

1. The tool returns `started mon_<id>` immediately.
2. The TUI sidebar shows an active monitor job while the `sleep 2` runs.
3. After the match (~2s) plus the idle gate, a **visible synthetic prompt**
   arrives carrying the matched text.

## 4. Background process handling test

This is the core "runs in the background, delivers on exit" path. Prompt:

```text
Use opencode_monitor_background with command:
sh -c "sleep 2; printf 'STDOUT_LINE\n'; printf 'STDERR_LINE\n' 1>&2"
```

Expected:

1. The tool returns `started bg_<id>` immediately (does not block the turn).
2. Sidebar shows an active job with the `[stdout]`/`[stderr]` tail preview once
   output appears.
3. After exit + idle, delivery shows the tail:
   ```
   background bg_<id> exited with code 0
   [stdout] STDOUT_LINE
   [stderr] STDERR_LINE
   ```

If you want to test exit codes and caps, try a failing command:
```text
Use opencode_monitor_background with command:
sh -c "exit 3"
```
Expected delivery: `... exited with code 3`.

## 5. Loop / schedule tests

Loop interval has a 10s minimum, so these are slower to observe:

```text
Use opencode_monitor_loop with raw args:
10 Use opencode_monitor_jobs and return the tool result.
```

Schedule (fires in ~3s):

```text
Use opencode_monitor_schedule with raw args:
in 3s Use opencode_monitor_jobs and return the tool result.
```

## 6. Verify via the sidebar indicator

- While a job is active the sidebar shows it (spinner + kind counts + elapsed +
  queue depth). In the default `detailed` view it also renders a full job list.
- Compact view is available via a `mode: "compact"` option in `tui.json`
  (plugin id is `opencode-monitor-indicator`).
- The indicator is keyed to the current session; `/jobs` shows only that
  session's jobs.

## 7. Verify via status files (direct, UI-independent)

The server writes job state to disk; the TUI polls these. Inspect them directly
to confirm job handling without relying on the UI:

- Bridge config + health endpoint:
  `$XDG_RUNTIME_DIR/opencode-monitor/bridge.json` (has `url`).
  ```bash
  URL=$(python3 -c "import json;print(json.load(open('$XDG_RUNTIME_DIR/opencode-monitor/bridge.json'))['url'])")
  curl -s "$URL/health"     # expect {"ok":true}
  ```
  `/health` up means the server plugin and its loopback HTTP bridge loaded.

- Job status snapshot:
  `$XDG_RUNTIME_DIR/opencode-monitor/status/<scopeHash>.json`
  Fields: `jobs[]` (`jobID`, `kind`, `status`, `deliveryStatus`, `createdAt`),
  `queueDepth`, `bridgeUp`, `completedCount`, `failedCount`.
- Per-job output tail:
  `$XDG_RUNTIME_DIR/opencode-monitor/tail/<scopeHash>/<jobID>.log`

`<scopeHash>` is a hash of the running folder (cwd/worktree), so **create the
job and read the status in the same folder** — a job made in folder A will not
appear in folder B's status file.

## 8. Delivery semantics to know

- Delivery is gated on **session idle**. When the session is busy/unknown, jobs
  queue (shown as `queueDepth`); they flush once the session becomes idle.
- Visible synthetic prompts carry opencode's injected synthetic-prompt header;
  the plugin does not set the caller/server name itself.
- Output is sanitized (ANSI/control stripped, best-effort secret redaction).

## 9. Troubleshooting

- **Sidebar is empty after creating a job:** create and inspect in the same
  folder — status is keyed to the running folder's scope hash.
- **`/health` fails or `bridge.json` missing:** the server plugin did not load;
  confirm the `file://` entry is in `~/.config/opencode/opencode.jsonc` and
  restart opencode.
- **No delivery arrives:** the session must be idle (the arm-idle fallback
  fires ~1.5s after a tool completes); otherwise the job is correctly queued.
- **Indicator not loading:** confirm the `opencode-monitor-indicator`
  `plugin_enabled` flag in `~/.config/opencode/tui.json`, and restart opencode
  (config loads at startup, not hot-reloaded).
- **Build is stale after source changes:** rebuild the plugin from the repo
  root (`npm run build`) — the global install points at the repo's `dist/`.
