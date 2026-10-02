# Fugue v1 design

Fugue is a Pi 1.0 extension that sits on top of `pi-subagents` (0.74.0) and gives the conductor (the owner's Pi
session) named voices, a live Score with a node diagram, durable completion notices, and gates. pi-subagents keeps
launching and running children. Fugue never spawns `pi` itself and never patches pi-subagents.

Shared types: `src/types.ts`. Read it before coding.

Verified against pi-subagents 0.74.0 and Pi 1.0 (2026-10-02):
- RPC `spawn` from another extension works once a turn has run (at `session_start` it answers
  `no_active_session`). Params `{agent, task, model, lane:{version:1,key,mode}}` produce a `mode:"single"` run whose
  `status.json` keeps `lane.key` at top level and in `steps[0].lane`. That is how a voice keeps its name on disk.
- `subagent:async-started` carries `id`, `completionOwnerId`, `sessionId` (the parent session file path), `mode`,
  `agent`. `subagent:async-complete` carries the same identity.
- A background child on `claude-bridge/claude-haiku-4-5` runs and answers. Background children load ambient
  extensions, so Fugue itself loads inside them: `src/index.ts` must return immediately when
  `process.env.PI_SUBAGENT_CHILD === "1"`.

## Vocabulary

User- and model-facing name: **riff** (tools `riff_spawn`, `riff_tell`, `riff_stop`, `riff_status`; renamed from
"voice" on 2026-10-02). The code keeps the internal type `Voice` and the session entry `fugue.voice` so saved
sessions stay readable; read "voice" in code as "riff".

Conductor = the owner's session. Voice = one child (one pi-subagents run). Score = Fugue's UI. Role = the
pi-subagents agent (scout, worker, reviewer, oracle, researcher, delegate, ...). Name = short unique handle given by
the conductor.

## Module map and owners

| Module | Owner | Purpose |
|---|---|---|
| `src/types.ts` | conductor (fixed) | shared contract |
| `src/index.ts` | core | wiring, child guard, lifecycle |
| `src/bridge.ts` | core | typed client for `subagents:rpc:v1:*` with timeout, readiness, `no_active_session` retry |
| `src/status-files.ts` | core | read `status.json` / `events.jsonl` tail / `output-<n>.log` tail; map to `Voice` |
| `src/store.ts` | core | the roster: implements `ScoreSource` + `ScoreActions`; event-driven; persistence via session entries |
| `src/names.ts` | core | validation, uniqueness, fallback names |
| `src/tools.ts` | core | model-facing tools `voice_spawn`, `voice_tell`, `voice_stop`, `voice_status` |
| `src/commands.ts` | core | `/fugue` (open Score panel), `/fugue doctor` |
| `src/notices.ts` | durable | exactly-once delivery of completions pi-subagents lost |
| `src/gates.ts` | durable | `fugue_gate` tool and `.pi/fugue.json` checks |
| `src/ui/*.ts` | ui | format helpers, Score line, graph panel, voice view overlay, input handling |

Modules talk only through `src/types.ts` interfaces plus the functions each module exports. The UI never imports
engine modules; it receives a `ScoreSource` and `ScoreActions`.

## 1. Names

- Valid name: `^[a-z][a-z0-9-]{0,19}$`. Lowercase the input, replace spaces/underscores with `-`, then validate;
  reject with a clear error otherwise.
- Unique among every voice of the session (live or settled), so references never become ambiguous. On collision
  append `-2`, `-3`, ... (disler #1) and report the final name in the tool result.
- Missing name (only possible for raw `subagent` runs Fugue observes): `lane.key` if present, else the role, then
  the same suffix rule. Voices spawned through `voice_spawn` must have a name (the parameter is required).
- Persist the identity at spawn with `pi.appendEntry("fugue.voice", {runId, name, role, model, task, parent,
  origin, startedAt})`. On `session_start` rebuild the roster from `ctx.sessionManager.getBranch()` entries of
  that type, then refresh each from its `status.json`. Raw runs seen through `subagent:async-started` are persisted
  the same way, with `origin:"subagent"`.

## 2. Engine

### Bridge
`request(method, params, {timeoutMs=15000})` returns `data` or throws `BridgeError{code,message}`. Track readiness
with `subagents:rpc:v1:ready` and a `ping` on first use. A `no_active_session` reply means pi-subagents has not
bound a context yet; the tools run inside a turn, so it is bound there. Methods used: `spawn`, `steer`, `stop`,
`resume`, `interrupt`, `status`.

### Spawning (`voice_spawn`)
For each requested voice: `spawn` with `{agent: role, task, model?, cwd?, lane:{version:1, key: name,
mode: laneMode(role)}}`, where `laneMode` maps worker/delegate to `mutation`, reviewer/evidence-auditor to
`review`, scout/researcher to `scout`, and omits `mode` for anything else. Never send `async:false`. Take `runId` and
`asyncDir` from `data.details`. Register the voice in the store before returning, so the Score shows it at once.

### Live state
- Events (all on `pi.events`): `subagent:async-started` (register or confirm, record `completionOwnerId` in the
  process-global owner set, see Notices), `subagent:async-complete` (settle), `subagent:child-status`,
  `subagent:control-event` (`reason:"supervisor_request"` means blocked with a question; capture the message),
  `subagent:process-terminal`.
- Polling: while at least one voice is non-terminal, every 1000 ms `stat` each active voice's `status.json` and
  re-read only when `mtimeMs` changed. A blocked voice also re-checks its open supervisor request, which pi-subagents
  deletes as soon as it is answered on any channel: no request means no question, so the voice is not blocked.
  Stop the timer when nothing is active (zero idle CPU). `timer.unref()`.
- Mapping from `status.json`: state `queued`->queued, `running`->running, `paused`->paused, `complete`->done,
  `failed|partial|rejected`->failed, `stopped`->stopped. `steps[0]`: `model`, `thinking`, `tokens`,
  `totalCost.costUsd`, `startedAt`, `endedAt`, `currentTool`, `currentPath`, `currentToolArgs`, `error`.
- Activity from `currentTool`: read/ls/cat -> reading; grep/find/glob/rg -> searching; edit/write/apply_patch ->
  writing; bash -> running (detail = first 40 chars of the command); subagent/voice_spawn -> delegating; none while
  running -> thinking. Detail for reading/writing = path relative to the run cwd.
- Message edges: a supervisor request adds `{from: voice, to: "conductor", kind:"asked"}`; the answer to it adds
  `{from: "conductor", to: voice, kind:"answered"}`; `voice_tell` adds `{from:"conductor", to: voice,
  kind: "steered"|"told"}`. Keep the last 50 edges.
- Liveness: if a voice is `running` but the runner `pid` from `status.json` is gone (`process.kill(pid, 0)` throws
  `ESRCH`) and no terminal state was written within 10 s, mark it `failed` with error "runner exited".

### Tools (model-facing; keep descriptions short and precise)
- `voice_spawn({voices:[{name, role, task, model?, cwd?}]})`, 1 to 8 voices per call. Result: one line per voice
  `auth  worker  opencode-go/deepseek-v4.1-flash  started  run 1a2b3c4d`. promptGuidelines (keep them to these):
  give every voice a short name that says its job; the owner chooses models, pass `model` exactly as the owner
  named it and never invent a default; parallel voices may read, only one voice writes a given area; results arrive
  as notifications, do not poll; answer a blocked voice's question or escalate real product decisions to the owner.
- `voice_tell({name, message, mode?: "steer"|"follow_up"})`: running -> RPC `steer`; settled -> RPC `resume`
  (continues the same session). Records an edge.
- `voice_stop({name})`: RPC `stop`.
- `voice_status({name?})`: roster lines, or one voice in detail (state, activity, tokens, cost, task, summary).
- Each tool's `renderCall`/`renderResult` is one line (quiet chat): `voice_spawn auth worker · db scout` and
  `3 voices started`.

### Commands
- `/fugue`: open the Score panel as an overlay (same component as the arrow-down panel).
- `/fugue doctor`: pi-subagents version and RPC ping, `fleetView` setting (warn if true: two compact lines),
  temp root path, voices in session, poll timer state, owner-id set size.

## 3. Durable notices (`src/notices.ts`)

Problem: when the conductor's Pi process ends while a background voice runs, the voice finishes and writes
`<resultsDir>/<runId>.json`, but the next Pi process never delivers it (owner id mismatch, see
pi-subagents' `docs/extension-api.md`, "Host session lifetime").

- Results dir: `${PI_SUBAGENTS_TEMP_ROOT ?? os.tmpdir()/pi-subagents-<uid>}/async-subagent-results`.
- Owner ids observed in this process live in `globalThis[Symbol.for("fugue.owner-ids.v1")]` (a `Set`), so they
  survive `/reload` and `/resume` inside one process.
- Candidate result file: `sessionId === (sessionManager.getSessionFile() ?? sessionManager.getSessionId())`, no
  `notificationDeliveredAt`, `completionOwnerId` not in the owner set, file age at least 5 s.
- Delivered set: runIds found in the branch in `fugue.notice` messages (`details.runIds`). That message is the
  ledger: one `sendMessage` both informs the conductor and records delivery.
- Scan at `session_start` (after a 5 s grace) and then every 5 s while the session has a non-terminal voice whose
  owner id is not in the owner set (orphaned runs). Re-read each file immediately before delivering.
- Delivery: one message per scan batch, `pi.sendMessage({customType:"fugue.notice", display:true, content,
  details:{runIds, voices:[{name, role, state, durationMs}]}}, {triggerTurn})`. `content` (for the model) names
  each voice, its state, its duration, its summary, and its output path. `triggerTurn` is false for the backlog
  found at `session_start`, true for completions found later in the session. Register a one-line message renderer:
  `while away: auth done 4m12s · db failed 2m40s`.
- After the send, set `notificationDeliveredAt` on the result payload with an atomic write (tmp + rename). Never
  delete pi-subagents files.
- A crash between send and mark is safe: the branch already holds the message, so the next scan skips the run and
  only writes the mark.

## 4. Gates (`src/gates.ts`)

- Config `.pi/fugue.json` in the project: `{"gates":[{"name":"build","run":"npm run build","timeoutMs":600000}]}`.
  Missing file: the tool explains how to add it.
- Tool `fugue_gate({cwd?, only?: string[]})` runs the checks in order with `bash -lc` in `cwd` (default the session
  cwd), records every check pass or fail with exit code, duration and the last 40 output lines (disler #8), never
  stops at the first failure, and returns the report as text plus `details: GateReport`. The store keeps the last
  report for the Score.
- promptGuidelines: run gates after a writer voice settles and before accepting its work; then spawn a fresh
  `reviewer` voice on the diff whose last line must be `VERDICT: PASS` or `VERDICT: FAIL` (disler #28); on FAIL
  `voice_tell` the writer with the findings; at most 3 rounds, then ask the owner.

## 5. Score UI (`src/ui/`)

Aesthetic rules: English, no emojis, theme tokens only (`accent`, `muted`, `dim`, `text`, `success`, `warning`,
`error`, `thinking*`, `border*` if present), `dim(" │ ")` separators, every emitted line passed through
`truncateToWidth(line, width)`. Visual reference: a Pi footer built the same way (layouts from
richest to most compact; first that fits wins). Model labels use footer's `modelLabel` rule
(`claude-opus-5-5` -> `Opus 5.5`; `opencode-go/deepseek-v4.1-flash` -> `deepseek-v4.1-flash`).

State glyphs (single cell, no emoji): queued `○` dim, running `●` accent, blocked `?` warning, paused `‖` muted,
done `✓` success, failed `✗` error, stopped `■` muted. Activity words: thinking, reading, writing, running,
searching, delegating.

### 5.1 Compact line (widget `fugue-score`, `belowEditor`)
Visible while any voice is non-terminal, or any voice settled in the last 60 s, or a question is pending. One line.
Order: blocked, failed (recent), running, queued, done. Layouts, first that fits:

```
fugue │ ? db asks: Postgres or SQLite? │ ● auth worker writing 4m12s │ ● review reviewer reading 1m03s │ ✓ scout 48s │ ↓
fugue │ ? db asks │ ● auth writing 4m12s │ ● review reading 1m03s │ ✓ scout │ ↓
fugue │ ? db │ ● auth 4m │ ● review 1m │ ✓ scout │ ↓
fugue │ 1 asks · 2 running · 1 done │ ↓
fugue 4
```
`fugue` in accent, names in `text` bold, roles `muted`, times `dim`. The `↓` hint is dim.

### 5.2 Graph panel (arrow-down)
`ctx.ui.onTerminalInput`: when the editor has focus, its text is empty, the line is visible and the key is `down`,
consume it and expand the widget in place into the graph panel (same gesture as pi-subagents FleetView; copy its
editor-focus probe in `src/tui/fleet-status.js`). Never use `registerShortcut` for arrows.

The panel is a node diagram: the conductor box on top, voice cards below joined by box-drawing connectors; nested
voices hang under their parent card. Example at 100 columns:

```
                         ┌─ conductor ── Opus 5.5 medium ─┐
                         └───────────────┬────────────────┘
          ┌──────────────────────┬───────┴──────────────┬──────────────────────┐
┌─────────┴─────────┐  ┌─────────┴─────────┐  ┌─────────┴─────────┐  ┌─────────┴─────────┐
│ ● auth     worker │  │ ? db        scout │  │ ● review reviewer │  │ ✓ scout     scout │
│ deepseek-v4.1-fl… │  │ deepseek-v4.1-fl… │  │ Opus 5.5          │  │ Haiku 4.5         │
│ writing   4m12s   │  │ asks      2m40s   │  │ reading   1m03s   │  │ done        48s   │
│ 21k · $0.03       │  │ 12k · $0.01       │  │ 9k · $0.05        │  │ 3k · $0.00        │
└─────────┬─────────┘  └───────────────────┘  └───────────────────┘  └───────────────────┘
┌─────────┴─────────┐
│ ● auth-tests  rev │
│ ...               │
└───────────────────┘
 db → conductor  "Postgres or SQLite?"  2m ago
 ←→↑↓ select · enter open · esc close
```

- Card width 20 to 30 columns, as many per row as fit with a 2-column gap; extra voices wrap into further rows, each
  row joined to the conductor's trunk. Selected card border in `accent`, others `dim`; blocked cards border
  `warning`, failed `error`.
- Below the cards: the last 3 message edges (`from → to  "text"  age`), then the key hint line.
- Height cap: 60% of terminal rows. If the cards do not fit, show the rows around the selection with `↑ N more` /
  `↓ N more` markers.
- Narrow fallback (fewer than 2 cards per row, about < 46 columns): a tree list
  `├─● auth  worker  writing 4m12s`, `│ └─● auth-tests ...`.
- Keys: arrows move selection (up from the top row collapses), `enter` opens the voice view, `esc` collapses.
- Render cost: cache the rendered lines by `(snapshot.version, width, selection, second-of-elapsed)`; the only
  timer is a 1 s tick that runs while a running voice is visible, and it calls `requestRender` only.

### 5.3 Voice view (overlay)
`ctx.ui.custom(component, {overlay:true, overlayOptions:{anchor:"center", width:"90%", minWidth:60,
maxHeight:"85%", margin:1}})`. Shows: header `● auth  worker  deepseek-v4.1-flash  writing  4m12s  21k  $0.03`, the
task (wrapped, max 4 lines), the pending question if any, the activity, recent message edges for this voice, and
the live output tail (`ScoreActions.readOutput`, refreshed every 1 s while open). Keys (messages typed via
`ctx.ui.input`): `s` steer a running voice, `t` tell (follow_up while running, resume once settled), `x` stop
(confirm with `ctx.ui.confirm`), `esc` close.

## 6. Testing (every module ships with tests; nothing is "done" without output you saw)

- Unit tests: `node --test test/*.test.ts` (Node 22 strips types; relative imports use `.ts` extensions; Pi
  packages resolve through `scripts/link-pi.sh` symlinks). `npm run typecheck` must pass.
- UI: render fixtures with 1, 5 and 15 voices at widths 40, 60, 100, 160 with a real dark `Theme` (see
  `test/helpers.ts`), assert every line fits, and write plain-text snapshots to `test/snapshots/` for
  the conductor to review. Also run the real host through `test/e2e/headless-score.mjs`.
- Engine E2E (real Pi, real deepseek child, cheap): `pi -p ... -e ./src/index.ts < /dev/null` drives a turn that
  calls `voice_spawn`; assert the voice's `status.json` has the lane key and that `voice_status` shows the name.
- Durable E2E: start a conductor in a real session, spawn a voice that takes about 30 s, `kill -9` the conductor,
  wait for the voice to finish, resume the same session (`pi -p --session <file> ...`), assert exactly one
  `fugue.notice` names the voice; resume again, assert no second notice.

Models: workers use `opencode-go/deepseek-v4.1-flash`. Children in E2E tests use
`opencode-go/deepseek-v4.1-flash:low` to stay cheap.

## 7. Integration seams (exact signatures; each owner implements its side)

```ts
// src/ui/index.ts            (ui)
export interface ScoreHandle { openPanel(): Promise<void>; dispose(): void }
export function mountScore(pi: ExtensionAPI, ctx: ExtensionContext, source: ScoreSource,
  actions: ScoreActions): ScoreHandle;            // no-op handle when ctx.mode !== "tui"

// src/notices.ts             (durable)
export function startNotices(pi: ExtensionAPI, ctx: ExtensionContext, roster: RosterView): { dispose(): void };
export function registerNoticeRenderer(pi: ExtensionAPI): void;

// src/gates.ts               (durable)
export function registerGates(pi: ExtensionAPI, onReport: (report: GateReport) => void): void;

// src/store.ts               (core)
export class Store implements RosterView, ScoreActions { /* ... */ setGate(report: GateReport): void }

// src/owners.ts              (fixed) ownerIds(), recordOwner(id)  — core records, notices reads
```

`src/index.ts` (core) order: child guard; register tools, gates, notice renderer, commands at factory time; on
`session_start` build the `Store` for the session, `mountScore(...)`, `startNotices(...)`; on `session_shutdown`
dispose all three. Until the ui and durable branches land, core uses local stubs with these exact signatures in
`src/ui/index.ts`, `src/notices.ts` and `src/gates.ts`; the real modules replace the stubs at merge.
