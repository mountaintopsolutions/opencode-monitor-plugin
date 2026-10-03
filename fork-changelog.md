# Fork changelog

What this fork changed relative to upstream, and why. Written so the work can
be picked up later — either to port upstream to
[Shodocan/opencode-monitor-plugin](https://github.com/Shodocan/opencode-monitor-plugin),
or to rebase onto a newer upstream after the OpenCode v2 port lands.

This file is a fork-local companion to `CHANGELOG.md`. That file tracks releases
for end users; this one tracks *our* divergence and the reasoning behind it,
including decisions that were reversed.

## Position

| | |
|---|---|
| Fork | `mountaintopsolutions/opencode-monitor-plugin` |
| Branch | `port-vanilla-opencode-tui` |
| Upstream | `Shodocan/opencode-monitor-plugin`, branch `main` |
| Base | rebased onto `origin/main` (`68dfcc1`, tagged `v1.2.3`) |
| Tip | `6f12134` |
| Declared version | `1.2.3` (matches upstream's tag; no version bump) |

Ten commits ahead of `origin/main`: five from the original feature branch,
replayed across the rebase, plus five added during the v2 migration work.

Net diff vs `origin/main`: 16 files, +581 / −91.

## Commits

### Carried over from the feature branch

These predate the v2 work and were only rebased, not rewritten.

| Commit | Summary |
|---|---|
| `d5f0e4f` | feat(tui): port sidebar indicator to vanilla opencode |
| `babea70` | feat: show all scope jobs in TUI sidebar and /jobs |
| `06d9184` | feat: fallback delivery to parent session when subagent is gone |
| `5b27bc7` | feat: deliver startup notification to chat for background/monitor jobs |
| `574c7f7` | feat: toggleable chat notifications with spawn/return icons |

### Added during the v2 migration

| Commit | Summary |
|---|---|
| `b8fac56` | test: reconcile disposal suite with chat startup notifications |
| `cf300d3` | test: make tail cap test shell-independent |
| `bf116d4` | fix: register spawn-time and window deliveries with the disposal tracker |
| `0684baa` | test: fix three timing and ordering assumptions that flake under load |
| `6f12134` | test: assert real delivery behaviour instead of disabling notifications |

## Changes worth upstreaming on their own merits

These are independent of the v2 migration and would be reasonable PRs as-is.

### `cf300d3` — tail cap test was shell-dependent

`test/process-runner.test.ts` built its payload with `echo '0\n1\n…\n249'`.
bash's builtin `echo` does not interpret backslash escapes unless `xpg_echo` is
set, so under `sh -> bash` the command emitted **one** line of literal `\n`
text and the cap assertion saw a single element containing no `'249'`.

macOS `/bin/sh` is bash in POSIX mode, where `xpg_echo` is on by default, so the
test passed upstream and failed on Linux. Now uses `printf`, which interprets
escapes in its format per POSIX. The two sibling tests already avoided this
(one uses `printf`, one a shell loop).

Small, self-contained, and a genuine portability bug in the test. Best
candidate for a standalone upstream PR.

### `bf116d4` — three deliveries were not registered with the disposal tracker

`dispose()` drains exactly two collections: `pending` (via `track`) and `exits`
(via `trackExit`). Three `deliver()` call sites were fired as
`void deliver(...).catch(...)`, landing in neither:

- background spawn notification (`src/index.ts:324`) — from this fork
- monitor spawn notification (`src/index.ts:431`) — from this fork
- monitor match-window delivery (`src/index.ts:415`) — **predates this fork**

Every other delivery was already registered: terminal results via `trackExit`,
loop and schedule handlers via `track(pending, …)`, status and tail writes via
`queueTail`.

**Caveat, stated honestly:** no test distinguishes the fixed from the unfixed
behaviour. Disposal blocks on an operation in `pending` that is coupled to the
delivery either way, so a gated-notify harness reports "blocked" with and
without the change. Three candidate tests were written and discarded as vacuous
rather than committed as false assurance. Treat this as a consistency and
robustness fix, not a demonstrated bug fix. It can only make disposal wait
longer, never shorter.

The match-window site at `:415` is the one genuinely worth upstreaming — it is
not part of this fork's feature work.

### `0684baa` — three timing and ordering assumptions that flake under load

All three passed in isolation, which is what made them easy to dismiss as noise.
Roughly 3 failures per 14 full-suite runs before; 0 in 10 after.

1. **`integration.test.ts`** — two faults.
   - `runner.disposed` is set in the exit chain's `finally`, behind
     `await deliver(...)`, a real HTTP round-trip. The 1s `vi.waitFor` default
     had no headroom under parallel load. Now 3000ms, matching the rest of the
     suite.
   - The real one: the test asserted `delivered[0]` was the spawn notification
     and `delivered[1]` the terminal result. The spawn notification is fired as
     `void deliver(...)`, so **its POST races the terminal result's** and the
     idle queue can hand them to the bridge in either order. Ordering was never
     part of the contract. Now asserts the set of delivered texts.

2. **`process-runner-cancel-ownership.test.ts`** — reaping the group descendant
   is an eventual condition. `cancel()` resolving does not mean the child has
   finished dying, so a one-shot `/proc/<pid>/stat` read could catch it
   mid-teardown in state `R`/`S`. Now polls for the terminal state.

3. **`monitor-disposal-lifecycle.test.ts`** — waited for `promptAsync` to have
   been called exactly once. See the note below; that count is racy.

### `b8fac56` and `6f12134` — a decision, made twice

These two are one change in two forms, kept as two commits on purpose. The first
approach was wrong and the second is the keeper; recording both keeps the
reasoning visible.

Upstream's disposal tests assert pre-feature delivery counts. The spawn
notification adds a second delivery per job, so four inherited tests broke.

`b8fac56` made them pass by constructing the plugin with
`chatNotifications: false`. The original assertions stayed byte-identical.

**Why that was wrong:** it left each test asserting something the product no
longer does, in a configuration nobody runs. Critically,
`expect(notify).not.toHaveBeenCalled()` passed *trivially* — it would have
passed just as well with the delivery path deleted. It could not distinguish
"nothing delivered because the job was cancelled" from "nothing delivered
because the feature was switched off in this test".

`6f12134` reverted the approach: the tests now run the **default**
configuration and state what actually happens. Cancellation suppresses the
terminal result but not the spawn announcement.

## Porting hazards for whoever does the v2 work

These are the non-obvious things. Each cost real investigation.

### Delivery order is not guaranteed

The spawn notification is `void deliver(...)` — fire-and-forget. Its HTTP POST
races the terminal result's. **Never assert delivery order.** This is what made
`integration.test.ts` flaky, and it will bite again on any base where both
deliveries exist.

### `chatNotifications` defaults to on

`src/index.ts` reads `deps.chatNotifications !== false`, so the default is
**enabled**. Any test that constructs the plugin directly inherits a second
delivery per job. This broke four upstream tests on arrival and produced a
fifth, separate flake in the status-write test.

### Assumed delivery counts are the recurring bug

Every flake in `0684baa` traced back to a hardcoded delivery count that the
spawn notification invalidated. When changing anything in the delivery path,
audit `toHaveBeenCalledTimes` / `not.toHaveBeenCalled()` across the suite
first.

### v2 plugin API

The plugin does **not** load under OpenCode v2 — it exports a v1-style async
function, and v2 requires a definition object with an `id` and a `setup`.
No v2-compatible version exists upstream or on npm as of 2026-10-03 (checked
`opencode-monitor-plugin@1.2.3` on npm, `origin/main`, and all upstream
branches; the published tarball's `dist/index.js` still ends
`export default server;`).

Full port notes: `~/.config/opencode/opencode-monitor-plugin-v2-port.md`
(not in this repo — move it under `docs/` if it should travel with the code).

Open question that gates the port design: whether v2's
`ctx.session.synthetic({ sessionID, text })` still carries the per-part
metadata this plugin relies on for job correlation
(`opencodeMcpVisible`, `opencodeMonitorJobID`, `opencodeMonitorKind`).
Verify against `https://opencode.ai/v2/docs/api` before designing around its
absence — it decides whether delivery correlation is a rewiring or a redesign.

The TUI indicator (`src/tui.tsx`) is a **separate** piece of work: v2 removed
the TUI plugin surface, so it becomes a CLI plugin configured in
`~/.config/opencode/cli.json`, not in `opencode.jsonc`.

## Local environment notes

- `node_modules/` was copied from a macOS machine and arrived broken
  (`node_modules/.bin/tsc` pointed at a missing `../lib/tsc.js`). Fix with
  `npm ci --ignore-scripts` — the plain `npm install` fails because the
  `prepare` script runs a build that needs the broken `tsc` first.
- `npm test` = `vitest run`, 342 tests. `npm run typecheck` = `tsc --noEmit`.
- A stray macOS `.DS_Store` is present at the repo root and is not ignored.
- Safety refs kept locally after the rebase: `backup/pre-rebase-v2` (the
  pre-rebase tip `f97fde4`) and `rebased-v2-port`. Neither is pushed; delete
  them once the branch is comfortable upstream.

## Not done

- No `CHANGELOG.md` entry for any of this. There is no `Unreleased` section and
  the version is still `1.2.3`; adding an entry implies a release decision that
  is the maintainer's to make.
- No version bump. The `package.json` conflict during the rebase was resolved by
  keeping `1.2.3` rather than regressing to `1.2.1`.
