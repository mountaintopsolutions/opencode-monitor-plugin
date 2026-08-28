# Session Context — opencode-monitor-plugin (2026-08-26)

Working notes for porting the plugin's TUI indicator to **vanilla opencode**
(`anomalyco/opencode`), beyond the custom `och` build.

## What the plugin does
- Server plugin (`dist/index.js`): slash commands + AI-callable tools
  (`background`, `monitor`, `loop`, `schedule`, `jobs`, `cancel`). Jobs run in
  memory; delivery goes through a loopback **bridge** that waits for idle/busy
  session status, then delivers synthetic prompts via `session.promptAsync`
  or the HTTP `/session/:id/prompt_async` endpoint.
- TUI plugin (`dist/tui.js`): reads a status JSON file the server writes and
  renders a `sidebar_content` indicator.

## Key finding: OpenTUI is baked into opencode
- opencode's TUI is built on **OpenTUI** (`@opentui/core`, `@opentui/solid`,
  `@opentui/keymap`, pinned at 0.4.5). It injects a shared runtime into plugins
  via Bun `runtime-modules`: `ensureRuntimePluginSupport(...)` in
  `packages/opencode/src/plugin/tui/runtime.ts`.
- Consequence: the TUI plugin must `import '@opentui/solid'` / `solid-js`
  **externally** (resolved to opencode's shared instance). **Do NOT bundle**
  `@opentui/*` into `dist/tui.js` — bundling a second Solid instance breaks the
  shared `<spinner>` catalogue + rendering, and `@opentui/core` can't be
  bundled anyway (dynamic `import(..., { with: { type: "file" } })` for
  wasm/scm assets). `dist/tui.js` is a Babel Solid-universal transform, not a
  bundler output.
- The `och` custom-contract MCP notifications (prompt/synthetic, toast, etc.)
  are the server side, not the TUI rendering.

## Changes made
- `src/tui.tsx:sidebar_content` renders a **single** view, toggled by config:
  - `Detail` (default, full job list + counts)
  - `Compact` (one-liner: spinner + kind×count badges + elapsed + queue depth)
  - Previously both were rendered together, causing "jobs idle" to appear
    **twice**. Now one or the other.
- Config option: read from the TUI plugin `options` (`Record<string, unknown>`
  from the `tui.json` plugin tuple). `options.mode` or `options.display`
  == `"compact"` → compact view; anything else → detailed. Default detailed.
  Implemented in `readDisplayMode()`.
- `package.json`: `@opentui/core`, `@opentui/solid`, `solid-js` moved from
  `dependencies`/`peerDependencies` → `devDependencies` (build-time only; the
  server plugin still needs `@opencode-ai/plugin`, `@modelcontextprotocol/sdk`,
  `zod` at runtime). `description` updated to reflect OpenTUI reuse.

## Local opencode registration (gitignored, in `.opencode/`)
- `.opencode/opencode.json`: `"plugin": ["<abs>/dist/index.js"]` (server) + the
  `rm -rf node_modules` bash allow rule.
- `.opencode/tui.json`: `"plugin": ["<abs>/dist/tui.js"]`,
  `plugin_enabled: { "opencode-monitor-indicator": true }`.
- Absolute paths used (opencode resolves file specs). Restart opencode to load.

## Test status
- `npm test` → 320/320. `test/tui-build.test.ts` asserts the solid-compiled
  `dist/tui.js` loads and exposes `default.tui` / `tui`.
- `test/redos-worker.test.ts` (worker-pool timeout tests) is **flaky** under
  load — the failing set rotates across runs and is unrelated to these changes.

## Known / open items
- Startup latency: the server plugin starts the bridge HTTP listener on launch
  (`bridge.start()`), which the user reported as slower opencode start.
  Not yet addressed (would need lazy bridge start).
- TUI indicator is `detail` by default; compact is available via
  `{ "mode": "compact" }` in the tui.json plugin tuple (requires restart).
