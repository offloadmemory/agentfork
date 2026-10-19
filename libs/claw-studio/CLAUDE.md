# libs/claw-studio

Claw's brain and services. Claw is **one persistent autonomous teammate per Studio** — distinct from
Agent Studio, where you build many agent workflow graphs.

> Agent Studio = you *build* many workflow graphs.
> Claw Studio = you *operate* one persistent teammate.

Operated from `apps/mission-control` (port 3010), which has its **own** NextAuth Credentials login
(Studio ID + password) and its own `NEXTAUTH_SECRET` — `apps/mission-control/middleware.ts` is
explicit that it does not trust web-ui's session. Session ids live under `session.studio`, not
`session.user`.

Heavy deps (`@langchain/*`, LangGraph, `deepagents`) stay in this lib and mission-control only — never
web-ui, whose Nx `run-commands` + `serverExternalPackages` build is known-fragile.

## Commands

```bash
cd libs/claw-studio && bunx vitest run        # tests — MUST run with this cwd (include: src/**/*.test.ts)
nx test claw-studio                           # same thing via Nx
cd libs/claw-studio && bunx tsc --noEmit -p tsconfig.lib.json   # NOT tsconfig.json — see Gotchas
```

Many tests are **integration-style against the real local Postgres** (`persistence.test.ts`,
`memory-tools.test.ts`, `claw-runtime.test.ts`). `vi.mock` does not reliably intercept relative-module
imports in this package — a verified pre-existing environment issue. Follow the existing pattern
rather than fighting it.

## Migrations: never use `prisma migrate dev`

It wants to **reset the database**. One source of drift was fixed (see below); one is permanent and
by design:

- ~~`checkpoint_*` tables created at runtime by `@langchain/langgraph-checkpoint-postgres`~~ — **fixed**.
  `CheckpointMigration`/`Checkpoint`/`CheckpointBlob`/`CheckpointWrite` in `schema.prisma` now model
  these 4 tables (mapped to `checkpoint_migrations`/`checkpoints`/`checkpoint_blobs`/`checkpoint_writes`),
  and `prisma/migrations/20261017120000_add_checkpoint_tables/migration.sql` creates them with the exact
  `CREATE TABLE IF NOT EXISTS` DDL `PostgresSaver.setup()` itself runs — so an existing deployment where
  `.setup()` already created them gets a no-op, and a fresh database gets them up front. `prisma migrate
  dev` no longer reports these as drift.
- The `embedding` indexes are still pgvector HNSW indexes Prisma cannot represent — there is no
  `Unsupported()` (or anything else) for an index, only for a column type, so this half is permanent.

For this remaining half, hand-author the migration SQL under
`prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` with a round timestamp (matching the recent
claw migrations) and apply with `bunx prisma migrate deploy`, which ignores drift and is what `bun run
setup` and container start already use.

## The agent loop

Claw's task path used to be a hand-written LangGraph `StateGraph` (`claw-graph.ts`, `claw-agent.ts`,
`executor-state.ts` — all deleted). It is now one `createDeepAgent` loop from the `deepagents` package,
composed by `agent/claw-deep-agent.ts`'s `createClawDeepAgent` and assembled with real dependencies
(model, tools, checkpointer, memory store) by `agent/claw-runtime.ts`'s `resolveClawRuntime`. There is
no planner/generate/evaluator/reflect/revise/final node topology any more — no reflect/revise cycle at
all. The loop iterates on its own (model call → tool calls → model call → ...) until it produces a final
answer or is bounded out.

| File | Responsibility |
|---|---|
| `agent/claw-deep-agent.ts` | Composition root: builds `interruptOn`, `permissions`, `stateSchema`, middleware array, then calls `createDeepAgent` |
| `agent/claw-runtime.ts` | Wires real deps (DB-backed model config, tools, checkpointer, memory store, workspace) and calls `createClawDeepAgent` |
| `agent/workspace-backend.ts` | `ClawWorkspaceBackend implements BackendProtocolV2` — the six workspace files as a deepagents filesystem |
| `memory/memory-middleware.ts` | `createClawMemoryMiddleware` — pgvector recall/save as `AgentMiddleware` hooks, wrapping the existing `memory-nodes.ts` node factories unchanged |

**Memory activity reaches the timeline via `memoryStats`, not tool calls.** Recall and save are
middleware *hooks*, so they emit no `ToolMessage` and `deriveNodeEvents` has nothing to derive from —
memory did a full embedding + 3 pgvector queries + an LLM relevance filter every turn and none of it
was visible, which read as "memory is switched off". Both hooks now return the `memoryStats` object
`memory-nodes.ts` already computed (it was being discarded), `memoryStats` is declared on the
middleware's **own** `stateSchema` (see the `derivePrivateState` gotcha below — without that the hooks
cannot write it at all), and `deriveNodeEvents` renders it as a `memory_recall`/`memory_save`
**call+result pair**. A pair, not a lone result: `agent-steps.tsx`'s `buildSteps` closes a
`tool_result` against a still-running `tool_call` of the same name and silently drops one that matches
none. The names deliberately differ from the real `search_memory`/`save_memory` tools the model can
also call, since that matching is by name alone.
| `gateway/execute-run.ts` | Drives `runtime.graph.stream()`, derives timeline events from each chunk, reads interrupts for approvals |

**Planning is a tool, not a node.** `write_todos` is added explicitly via `todoListMiddleware()` in
`createClawDeepAgent`, because `createDeepAgent` only auto-wires it in for the Codex harness profile —
Anthropic/Bedrock models get no `write_todos` tool by default. Without this line the old graph's
mandatory planner node would be traded for nothing at all.

**The run is bounded to end, not throw.** `createDeepAgent` has no construction-time model-call-count
bound of its own — the closest built-in, `recursionLimit`, is a per-`invoke()` option that throws
(`GraphRecursionError`), losing the whole turn. `modelCallLimitMiddleware({ runLimit: modelCallLimit,
exitBehavior: 'end' })` is pushed into the middleware array instead, so a run that hits its iteration
budget finishes with whatever answer it has instead of erroring out mid-turn.

**Approvals** run through `humanInTheLoopMiddleware` via the `interruptOn` map `buildInterruptOn`
constructs (see "Self-authoring" below for the live-grant mechanics). `execute-run.ts`'s
`approvalRequestFrom` reads the paused tool names/args straight off the interrupt payload
(`actionRequests`), and `deriveNodeEvents`/`recordRunEvents` turn each `graph.stream()` chunk into the
run's timeline events — tool calls, tool results, and the model's own text.

### Gotchas from this migration

- **`tsconfig.json` is solution-style** (`include: []`, `files: []`, only a `references` pointer to
  `tsconfig.lib.json`). `bunx tsc --noEmit -p tsconfig.json` checks **zero files** and exits 0 no matter
  what is broken — it silently rubber-stamped six tasks during this migration. The real command is
  `-p tsconfig.lib.json` (~102 files); see Commands above.
- **deepagents forces `FilesystemMiddleware` and `SubAgentMiddleware` on**, unconditionally, via its own
  internal `REQUIRED_MIDDLEWARE_NAMES` set — there is no opt-out via `middleware`. `FilesystemMiddleware`
  defaults to an in-memory `StateBackend` when no `backend` is passed to `createDeepAgent`, so omitting
  `backend` makes every `read_file`/`write_file` call silently route to a per-run, checkpoint-serialized
  in-memory store instead of `claw_workspace_files` — no error anywhere, just a workspace that quietly
  stops persisting. `claw-runtime.ts` always passes `backend: new ClawWorkspaceBackend(...)`.
- **LangGraph scopes each middleware hook's visible input state to that middleware's own
  `stateSchema`** (`derivePrivateState`) — a middleware with no `stateSchema` sees only the built-in
  `messages`/`structuredResponse` channels as hook *input*, regardless of what the top-level composition
  root declares. Hook *output* merges back unrestricted. A middleware that reads a custom field off
  state (like `memory-middleware.ts` reading `memoryContext`) needs its own `stateSchema` declaring that
  field, or the read comes back `undefined` even though the value is really there on state.
- **`createDeepAgent` already installs `createSummarizationMiddleware({ backend })`** by default, and the
  middleware stack merges **by name** — adding a second summarization middleware in `claw-runtime.ts`'s
  `middleware` array would *replace* the built-in one with a copy carrying no `backend`, silently
  unwiring it rather than stacking. Do not add one there.
- **Token streaming via LangGraph's `custom` stream mode is dead.** Nothing calls `getWriter()`/emits a
  custom event any more — the node functions that used to (`claw-graph.ts`'s `respond`/`final`) are
  deleted — so `apps/mission-control/app/api/chat/route.ts`'s `'custom'` branch never receives a payload
  and chat always falls back to sending the whole answer as one lump "token" event instead of real
  per-token deltas. LangGraph's `messages` stream mode does deliver real per-token deltas but has not
  been enabled, pending verification against the actual provider streaming behavior.

## Workspace Files (soul & identity)

Claw's persona lives in six DB-backed files — `identity`, `soul`, `agents`, `user`, `tools`,
`heartbeat` — modelled on OpenClaw's `SOUL.md` / `AGENTS.md` / etc. Rows, not files: this is a hosted
multi-tenant app with no per-tenant volume, and rows give versioning and rollback for free.

| File | Responsibility |
|---|---|
| `workspace/types.ts` | slugs, per-file char caps, UI labels, `isWorkspaceSlug` |
| `workspace/templates.ts` | seed content, written to be edited rather than admired |
| `workspace/workspace-file-service.ts` | CRUD, idempotent seeding, revisions, restore |
| `agent/prompt-composer.ts` | pure: file map + surface → prompt string |

**Surfaces** decide which files reach the composed system prompt (`agent/prompt-composer.ts`), passed
into `createClawDeepAgent` as `promptSurface`:

- `speaking` — identity, soul, agents, user
- `acting` (default) — the above plus `tools`
- `scheduled` — the above plus `heartbeat`

There is no separate internal-classifier surface any more — the deepagents loop has no evaluator/reflect
nodes to withhold persona from (see "The agent loop" below).

**Caps.** Per-file caps live in `SLUG_CHAR_CAPS`; `CLAW_WORKSPACE_MAX_CHARS` (default 16000) bounds
their sum. Over-cap content is truncated with a visible `<!-- truncated: … -->` marker, never
silently — a quietly cut soul is a debugging trap.

**Persona edits do not prompt any more, and the prompt must not mention approval.**
Under `CLAW_SELF_AUTHORING=all`, `file-tools.ts` pre-grants `write_workspace_file`/
`edit_workspace_file` for identity/soul/agents, so a persona edit the user asked for lands
immediately. Two things drove that:

- The gate only ever fired on the case that is never a surprise — "call yourself X" — and a
  prompt the user missed left the file unchanged while the reply implied otherwise.
- Worse, *describing* the gate in the system prompt caused the refusal it was meant to
  guard. The wording "edits to these three pause automatically for the person's approval"
  led an 8B model (`llm-powerhouse-qwen-3-8`) to answer "I can't alter my own identity
  files directly — that's something you'd do in Mission Control", with
  `deniedWritePaths: []` and all 102 tools present. `selfAuthoringSection` now mentions
  neither approval nor permission, and `prompt-templates.test.ts` asserts their absence.

What still bounds it: `MAX_WRITES_PER_RUN` (5) per turn, an append-only `ClawFileRevision`
per write carrying Claw's stated reason, and one-click restore in `/agent`. Restricted modes
are unaffected — `canClawWrite` still denies these slugs under `user`/`off`.

**First run: Claw asks who it should be.** A tenant whose `identity` AND `soul` are both still
blank or byte-identical to their templates has no persona of its own, so `prompt-templates.ts`'s
`onboardingSection()` is appended to the system prompt and Claw runs a short setup interview —
name, creature, vibe, emoji, tone — then writes the answers with `write_workspace_file`.

The trigger is `workspace/onboarding.ts`'s `isPersonaUnconfigured(files)`, read from the FILES, not
from "is this the first turn". A first-message flag fires once and is gone: a user who ignored the
questions, or closed the tab mid-answer, would keep the stock template forever with nothing left to
prompt it. Reading the files means the offer stands until setup actually happens, and stops on the
write that fills them — including a human edit in Mission Control, which no conversation-scoped flag
would notice. The exact-match half is only sound because `reseedUnedited()` keeps version-1 rows
equal to the current template; if that ever stops being true, every existing tenant reads as
"already configured" and the setup silently never runs.

Requires BOTH persona files untouched — the anti-nag rule. Someone who wrote a soul and deliberately
left the identity form blank has made a choice, and `agents` is excluded entirely because its
template is real, usable operating procedure rather than a form.

**Setup writes skip the gate, and only while there is nothing to protect.** `onboardingWriteGrants()`
returns the slug-scoped grant keys for the three gated slugs, which `claw-runtime.ts` adds to
`fileTools.grantedWrites`; without them, finishing a welcome flow costs three approval modals for
content the user dictated seconds earlier. It cannot outlive the setup, because it is derived per run
from the live file state rather than stored — the write that fills the files revokes it. Seeded in
`claw-runtime.ts` rather than `claw-deep-agent.ts`, which must never mutate the caller's Set (it holds
it by reference for live mid-run grants).

**Both halves are gated on `CLAW_SELF_AUTHORING=all`,** read from the same resolved mode that builds
the `buildWorkspacePermissions` deny rule. Under `user`/`off` those slugs are denied at the backend, so
an introduction promising to save the answers would only ever produce a failed tool call mid-setup.

**A request comes before the questionnaire.** If the user's first message is real work, Claw answers it
and asks afterwards; only a bare greeting triggers the interview up front. Pinned by
`claw-deep-agent.test.ts` — the seeded `identity` file is a blank form that reaches the model verbatim,
so the pull to resolve it before doing anything else is strong.

**Restore is append-only.** `restore(slug, version)` writes the old content back as a *new* version
rather than rewinding the counter, so "we restored v2" stays visible in history.

**Non-regression guarantee.** A tenant with no files composes to `''`, and `buildBaseIdentity` falls
back to `DEFAULT_IDENTITY` — the exact pre-feature string. Pinned by tests in `prompt-composer.test.ts`
and `prompt-templates.test.ts`. **Do not edit `DEFAULT_IDENTITY`.**

**Historical note — a bug worth not reintroducing.** `deps.systemPrompt` used to be destructured in
`createClawGraph` (now deleted) and then shadowed by a local `const systemPrompt = new
SystemMessage(...)` in every node, so `Claw.systemPrompt` and the Playground's system-prompt override
were both silently discarded. It survived because the test that claimed to cover it had no `expect` at
all. It is now consumed as the composer's `agentsOverride` inside `claw-deep-agent.ts`'s
`createClawDeepAgent`, which builds it once into the `systemPrompt` string passed to `createDeepAgent`.
`claw-deep-agent.test.ts` asserts on the prompt the model actually receives, but not by monkey-patching
`model.invoke` the way the old `recordingModel` did — deepagents' forced `FilesystemMiddleware` means
`tools.length > 0` is always true, so the model is always rebound via `model.bindTools(tools)` before
each call, and `FakeListChatModel.bindTools()` returns a brand-new instance rather than `this`, silently
bypassing an override on the original. The current test instead overrides `bindTools()` on a
`RecordingFakeModel` subclass to return `this`, so the recording survives the rebind.

### Self-authoring

Claw edits its own workspace files through four tools in `agent/file-tools.ts`:
`list_workspace_files`, `read_workspace_file`, `write_workspace_file`, `edit_workspace_file`.

**Policy** (`workspace/self-authoring-policy.ts`):

- Free: `user`, `tools`, `heartbeat` — Claw recording what it learns about you must not nag.
- Persona: `identity`, `soul`, `agents` — denied outright under `user`/`off`. Under `all` they
  are writable AND pre-granted, so they no longer prompt; see "Persona edits do not prompt".
- `CLAW_SELF_AUTHORING` = `off` | `user` | `all` (**default `all`**).
- `MAX_WRITES_PER_RUN` = 5, so a reflection loop cannot churn the soul.

**`CLAW_SELF_AUTHORING` defaults to `all`**, so Claw may propose edits to every slug. That widens
what it can *propose*, never what it can change unasked — persona slugs are still gated per slug.
`prompt-templates.ts`'s `selfAuthoringSection(mode)` is what actually makes Claw use these tools: they
had existed since self-authoring shipped, but nothing in the prompt mentioned them, so the model never
reached for them and the files only ever changed when a human edited them in Mission Control. The
section is built from the same resolved mode as `buildWorkspacePermissions`, so the prompt can never
advertise a write the backend will refuse.

**Grants are keyed `<toolName>:<slug>`, and seeded at construction.** Both halves are load-bearing,
and both were wrong before:

- A bare tool name leaked across slugs. `buildInterruptOn`'s `when` asked `granted.has(toolCall.name)`,
  but the slug is an *argument* — so one write to `user` put `write_workspace_file` in the set and
  every later call to that same tool skipped the gate, whatever slug it targeted. Under
  `CLAW_SELF_AUTHORING=user` the backend deny rule masked this; under `all` that deny list is empty
  and nothing else stood in the way, so Claw could have rewritten its own soul off the back of a
  routine note-to-self. `claw-deep-agent.ts`'s `isGranted` checks the composite key, falling back to
  the bare name for tools that carry no slug.
- Granting only *after* a successful write meant the FIRST free write always prompted — the exact
  nagging the free-write set exists to prevent — and `edit_workspace_file`, which was never added at
  all, prompted every single time.

**How free writes skip the gate.** `createFileTools` returns a live `grantedWrites` Set that
`claw-runtime.ts` passes to `createClawDeepAgent` as `grantedTools`. `claw-deep-agent.ts`'s
`buildInterruptOn` builds a per-tool `interruptOn` map for `humanInTheLoopMiddleware`: a mutative tool
(per `classifyTool`) gets `{ allowedDecisions: [...], when: (request) => !granted.has(request.toolCall.name) }`
rather than a boolean. `when` is evaluated by the middleware on **every call**, not once at
construction, so `granted` is held **by reference** and consulted live — a grant added mid-run (after
the agent was built) is honored on the very next call to that tool, not just on the next run built after
the grant existed.

deepagents' own forced `write_file`/`edit_file` tools (installed unconditionally by its
`FilesystemMiddleware`, outside `deps.tools`) get the same `classifyTool`-driven `interruptOn` verdict
via stand-in `{ name }` entries in `FORCED_GATE_CANDIDATES`. On top of that, `buildWorkspacePermissions`
expresses the free-vs-gated slug split as a `FilesystemPermission` **deny** rule covering the GATED
slugs (identity/soul/agents), passed to `createDeepAgent` as `permissions` — so a write to a gated slug
is blocked at the backend/tool layer regardless of interrupt/approval state, not bypassable by
`autoApprove` or a stale grant. Independently, `ClawWorkspaceBackend.write()` enforces
`MAX_WRITES_PER_RUN` (5) as a per-instance counter, so free-write slugs (`user`/`tools`/`heartbeat`)
still can't be churned an unbounded number of times per run through the forced tools, which have no
visibility into `file-tools.ts`'s own write counter.

**Tools never throw.** A thrown LangChain tool error aborts the whole run, so every failure path
returns a recoverable string. Same convention as the integration tools.

**Audit.** Every write inserts a `ClawFileRevision` with Claw's stated `reason` and the `sourceRunId`.
The `/agent` history dialog badges Claw's edits and offers one-click restore.

## Browsing: the session outlives the request, on purpose

| File | Responsibility |
|---|---|
| `agent/browser-session.ts` | One Playwright browser + page, serialised behind a promise queue; idle/hold/budget timers |
| `agent/browser-session-registry.ts` | **Owns session lifetime**, one live session per `tenantId:threadId`, across requests |
| `agent/browser-tools.ts` | The ten `browser_*` tools over that session. Returns tools only — no teardown of its own |

**Never construct a `BrowserSession` per request.** `resolveClawRuntime()` runs once per
incoming HTTP request, but a browsing turn spans *several* of them: `browser_open_url`,
`browser_click`, `browser_type`, `browser_select` and `browser_upload_file` all classify as
mutative (`tool-classifier.ts`), so every interaction with a page pauses the turn for
approval and resumes in a later request. A per-request session (what this used to do) was
torn down by `runtime.cleanup()` on the way out of the request that *ended at the approval
gate* — so the approved click executed against a brand-new `about:blank`, reported success,
and the model concluded the browser infrastructure was unstable and gave up. Sessions come
from `acquireBrowserSession(key, opts)` and are released only by the registry.

**`cleanup({ keepBrowser: true })` on the interrupt path, and only there.** All three drivers
(`chat/route.ts`, `playground/route.ts`, `gateway/execute-run.ts`) pass it when the pass ended
with `interrupts.length > 0`, which parks the page via `session.hold()` instead of closing it.
Any other exit — completed, clarify, error, cancel — must close, or a Chromium stays alive
until `CLAW_BROWSER_HOLD_MS` elapses.

**Human pause is not model time.** `hold()` suspends the idle timer (`CLAW_BROWSER_IDLE_MS`,
60s — shorter than any real approval round trip) and held time is subtracted from the
`CLAW_BROWSER_SESSION_MAX_MS` budget, because charging deliberation to that budget made a
three-approval form fill exhaust five minutes before the model had done anything. The hold is
still bounded by `CLAW_BROWSER_HOLD_MS` so an approval nobody answers cannot pin a browser.

**A lost page is never silently replaced.** `close({ pageLost: true })` (idle, hold expiry,
budget, registry eviction) makes the next non-navigation tool call return an explicit "call
`browser_open_url` again" error instead of letting `ensurePage()` hand back a fresh
`about:blank`. A plain `close()` — `browser_close`, or the run's own cleanup — is the caller's
own doing and sets no flag.

**Process-local, and that is a real deployment constraint.** The Chromium lives in whichever
container resolved the run, so an approval must return to that same process.
`CLAW_BROWSER_MAX_SESSIONS` (3) still caps concurrent browsers *including held ones*. More than
one mission-control replica needs sticky routing on the chat session; without it the resumed
turn finds no live page — which now surfaces as the recoverable tool error above rather than a
silent blank page.

## Tool classification — a fixed footgun

`agent/tool-classifier.ts` decides which tool calls need approval. Its patterns are `\b`-bounded, and
**`_` is a regex word character** — so `\bsend\b` never matched `gmail_send_message`. Every
snake_case integration tool therefore classified as read-only and the mutative approval gate never
fired for any of them: sending mail, creating Jira issues, deleting calendar events.

`tokenizeName()` now maps `_`/`-` to spaces before pattern matching, which fixes snake_case while
leaving hyphenated and spaced forms (`create-resource`, `aws ec2 terminate-instances`) exactly as
before. `edit` and `add` were also missing from the verb list, leaving `edit_workspace_file` and
`jira_add_comment` ungated.

`tool-classifier.test.ts` now pins the real tool names on both sides — add new tools to those lists.
Do not reintroduce raw-name matching.

Separately, and now **fixed**: the old `interruptBefore` pause happened *before* `mutative_approval_gate`
ran, so `pendingToolApprovals` was still empty at the moment of the first pause. `humanInTheLoopMiddleware`'s
`interruptOn` (see "Self-authoring" above) carries the paused tool's name and args in the interrupt
payload itself (`actionRequests`), so `execute-run.ts`'s `approvalRequestFrom` never reads an empty
list — pinned by `execute-run.test.ts`'s `'never returns an empty tool list when an interrupt is present'`.

## Scheduled Tasks (cron)

Ported from nucleus `lib/agent-ops/scheduled-task-service.ts`,
`lib/agent-ops/scheduled-notifier.ts` and `apps/workers/src/jobs/agent-ops-scheduler/`.

| File | Responsibility |
|---|---|
| `scheduler/select-due-tasks.ts` | Pure: which tasks are due at `nowMs`. No DB, no queue, no clock |
| `scheduler/scheduled-task-service.ts` | CRUD, schedule validation, guards, lock, anchor advance |
| `scheduler/run-scheduled-task.ts` | Tick → lock → `ClawRun` → `executeRun` → finalize |
| `scheduler/scheduled-notifier.ts` | status → outcome, delivery through the connector registry |
| `scheduler/schedule-tools.ts` | Lets Claw create/list/update/delete its own tasks from chat |
| `scheduler/grant-from-run.ts` | "Always allow for this task" — persists the grant |
| `apps/workers/src/jobs/claw-scheduler/` | pg-boss wiring only: sweep timer + tick handler |

**One sweeper, not per-task schedules.** `pgboss.schedule` is keyed by queue name, so
per-task cron forces one queue *and one `work()` poller* per task — N indexed SELECTs a
second doing nothing, plus a consumer leak on delete. Nucleus hit that and replaced it
with an in-app sweep multiplexing every tenant onto one tick queue. Do not "simplify"
this back to `boss.schedule`.

**`previousRuns(1, ref)`, not `previousRun(ref)`.** The latter reports when a *live
scheduled* job last fired and returns `null` for an unscheduled `Cron` instance like
ours. This cost an hour; the tests pin it.

**`executeRun` is source-agnostic and must stay that way.** A scheduled run is just a
`ClawRun` with `source: 'scheduled'`, which is why the run timeline, HIL approvals,
cancel and dashboard alerts all work for scheduled runs with no extra code. Scheduled
runs therefore appear in the global `/runs` list as well as on their task's page.

**`retryLimit: 0`** on the tick enqueue, matching `enqueueGatewayRun`: a run that
failed halfway may already have sent mail or mutated external state, so replaying it
could duplicate side effects. Failures surface on the run record and bump
`failureStreak`, which auto-pauses the task at 3.

**Least privilege.** `approvalMode` is `ask` (default) | `allowlist` | `all`, with
`allowedTools`. Blanket auto-approve for an unattended run would also auto-approve
`delete_event` and every mutative MCP tool the run happens to reach. `autoApprove:
true` still maps to `mode: 'all'` so existing callers are unaffected — pinned by
regression tests.

**Guards:** `CLAW_MIN_INTERVAL_MINUTES` (15, applied to cron *effective frequency* as
well as intervals — nucleus only checked intervals, so `* * * * *` passed there),
`CLAW_MAX_ACTIVE_TASKS_PER_TENANT` (25), `FAILURE_STREAK_LIMIT` (3),
`CLAW_SCHEDULER_SWEEP_MS` (30000).

**No worker→HTTP hop.** Nucleus's sweeper POSTs to a web-ui trigger endpoint because
its agent code lives in web-ui. Ours imports `libs/claw-studio` directly, dropping a
network hop, the `INTERNAL_API_KEY` shared secret, and a class of 401-misconfig
failures that silently dropped scheduled runs.

## Standards

Inherited root standards apply without exception: Zod at every boundary, all env through T3 Env
(`src/env.ts`) and never `process.env`, shadcn/ui only in the UI, try/catch everywhere with Pino
structured context (`{ tenantId, clawId, slug }`), and no plaintext credentials.

## Outstanding

The fuller module documentation called for in
`docs/superpowers/specs/2026-07-15-claw-studio-design.md` §9 (full agent-loop walkthrough, memory
subsystem, skills synthesis, MCP, connectors, reuse provenance table) is still to be written.
