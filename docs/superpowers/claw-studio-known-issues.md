# Claw Studio — Known Issues Register

Bugs and limitations found **outside** the scope of the work that surfaced them. Each entry says what
is wrong, how it was verified, the blast radius, and the fix — so none of it has to be re-diagnosed.

Living document: append as things are found, and strike entries when fixed.

**Legend** — 🔴 correctness/security · 🟠 breaks a workflow · 🟡 limitation or papercut

---

## ✅ 1. FIXED (2026-08-03) — `bash`-named tools always classify read-only, skipping command inspection

**Where:** `libs/claw-studio/src/agent/tool-classifier.ts` — `READ_ONLY_ALLOWLIST` contains the literal
string `'bash'`.

**Problem:** the allowlist check short-circuits before the bash/shell command-inspection branch. A tool
named exactly `bash` therefore classifies read-only **whatever command it is given** —
`classifyTool('bash', { command: 'rm -rf /' })` returns `isMutative: false`. Only `shell`,
`run_command`, and `execute_command` ever reach the command inspection.

**Verified:** asserted as current behaviour by `tool-classifier.test.ts` ("a literal \"bash\" name
always classifies read-only regardless of command"), and documented inline as an inherited quirk of the
nucleus port.

**Blast radius:** currently none — nothing binds a tool named `bash`. It becomes a live remote-code
path the moment an MCP server exposes one, which is common.

**Fix:** remove `'bash'` from `READ_ONLY_ALLOWLIST` and let the existing bash branch inspect the
command. Update the test that pins the quirk. ~3 lines.

**Fixed:** `'bash'` removed from `READ_ONLY_ALLOWLIST`; `tool-classifier.test.ts`'s pinned test now
asserts the opposite (a `bash` tool with a mutative command classifies as mutative, same as
`shell`/`run_command`/`execute_command`).

---

## ✅ 2. FIXED (2026-07-30) — tool-approval prompts reached channels naming no tools

**Where:** `libs/claw-studio/src/gateway/execute-run.ts` — `approvalRequestFrom()`, and
`mutativeApprovalGateNode` in `agent/claw-graph.ts`.

**Problem:** the graph compiles with `interruptBefore: ['approval_gate', 'mutative_approval_gate']`.
`interruptBefore` pauses **before** the node body executes, so `pendingToolApprovals` — which the gate
node sets — is still empty at the moment of the pause. `approvalRequestFrom` reads it exactly there, so
a tool-approval request is built with `pendingTools: []` and the Slack/Telegram/Discord message says
"Approval needed to run:" with nothing after it.

**Verified:** proven while writing `claw-graph.test.ts`'s granted-tools coverage — asserting
`pendingToolApprovals` after the first pause yields `[]`, and only becomes populated after a resume
(`graph.invoke(null, config)`).

**Blast radius:** every mutative tool approval on every channel. Previously masked by issue #3 (the gate
never fired at all); now that snake_case tools classify correctly, this is user-visible.

**Fixed:** `approvalRequestFrom` now derives the list from the paused state's last AI message —
`filterMutativeToolCalls(lastMessage.tool_calls)` — and falls back to `pendingToolApprovals` for a
state captured after a resume.

**Residual limitation:** the graph's granted-tool set lives in the `createClawGraph` closure, not in
graph state, so a batch mixing a granted and an ungranted tool will name both in the message. The
*gating* decision is still correct — only the prompt text over-reports. Fixing properly means putting
the grant set into `ClawExecutorState`.

---

## ✅ 3. FIXED (2026-07-30) — snake_case tool names never classified as mutative

Recorded because it explains why #2 went unnoticed and why approval behaviour changes.

`MUTATIVE_PATTERNS` are `\b`-bounded and `_` is a regex word character, so `\bsend\b` could not match
`gmail_send_message`. **All 30 snake_case integration tools classified read-only**, so the mutative
approval gate never fired for sending mail, creating issues, or deleting events. `edit` and `add` were
also absent from the verb list.

Fixed by `tokenizeName()` (maps `_`/`-` to spaces before matching) plus the two missing verbs.
`tool-classifier.test.ts` now pins 17 mutative and 25 read-only real tool names.

---

## 🔴 11. Channel approval buttons are not authorized to a user

**Where:** `libs/claw-studio/src/gateway/gateway-service.ts` — the resume handler; and each
adapter's `parseInbound` for interactive payloads.

**Problem:** the resume path validates the channel signature, that the run exists, that it belongs to
the tenant the signature resolved to, and that the run's status matches the action. It captures the
clicker's platform user id (`message.userId`) and **never checks it against anything**. Any member of
the connected Slack workspace who can see an approval message can press Approve, Reject, or
"Always allow for this task".

**Verified:** traced the full resume path — no allowlist, no role check, no comparison of
`message.userId` against any stored value. `SlackConnectorConfig` has no allowlist field.
`ClawConnectorConfigService` stores none.

**Blast radius:** pre-existing for Approve/Reject, which grant a **one-time** action. `approve_always`
(added 2026-07-31) grants a **standing permission** on the task, so a single click by any workspace
member can let a scheduled task send mail or create issues unattended indefinitely. The feature did
not create this gap but it materially raises its consequence.

**Fix, roughly in order of value:**
1. Add an approver allowlist to each channel's connector config (platform user ids), checked in the
   resume handler before enqueueing. A `whatsapp-contact-allowlist` design already exists in this
   repo to follow.
2. Until then, consider gating `approve_always` to the Mission Control UI only (where the session is a
   real authenticated studio login) and dropping the Slack button.
3. Record the approver on the run's `approval_decision` event so the action is at least attributable.

---

## ✅ 12. FIXED (2026-08-03) — granted tools carry no provenance

**Where:** `ClawScheduledTask.allowedTools` — a bare `String[]`.

**Problem:** there is no record of who granted a tool, when, or from which run. "Why can this task
send email?" is answerable only from Pino logs, which rotate.

**Blast radius:** low operationally, but it is a permission list with no audit trail, which is the
kind of thing a security review asks about.

**Fix:** either store `allowedTools` as JSON objects (`{ name, grantedBy, grantedAt, sourceRunId }`)
or write an audit row on each grant in `ScheduledTaskService.grantTool`. The latter is
non-breaking — `AuditService` is already used by the dashboard action route.

**Fixed:** `ScheduledTaskService.grantTool` now takes an optional `sourceRunId` and writes an
`AuditService.logSystemEvent` row (`schedule.tool_granted`) on every grant; `grantPendingToolsForRun`
passes the triggering `runId` through. `allowedTools` itself stays a bare `String[]` — the provenance
lives in the audit log, not the column.

---

## ✅ 4. FIXED (2026-08-03) — `whatsapp:test` has one failing test, so `bun run test` exits 1

**Where:** `libs/whatsapp/src/session/session-manager.test.ts` — "expires session if window has passed".

**Problem:** commit `a6ba999` added a `$transaction([... whatsAppSession.deleteMany ...])` call to
`session-manager.ts:27`, but the test's hand-written `mockPrisma` still only provides `findFirst`,
`create`, `update`. Fails with `TypeError: this.prisma.whatsAppSession.deleteMany is not a function`.

**Verified:** reproduced in isolation; `libs/whatsapp` and `libs/shared` were byte-identical to `HEAD`
at the time.

**Blast radius:** the whole-repo `bun run test` is red, which masks real regressions.

**Fix:** add `deleteMany: vi.fn()` and `$transaction: vi.fn(async (ops) => Promise.all(ops))` to the
mock. ~2 lines.

**Fixed:** both added to `mockPrisma` exactly as scoped; `bun run test` / `nx test whatsapp` is green.

---

## 🟡 5. PARTIALLY FIXED (2026-10-17) — `prisma migrate dev` wants to drop the database

**Where:** repo-wide Prisma workflow.

**Problem:** `migrate dev` reports drift and offers only a reset. Two independent sources of drift:
the `checkpoint_*` tables, created at runtime by `@langchain/langgraph-checkpoint-postgres` and
previously absent from `schema.prisma`; and the `embedding` indexes, pgvector indexes Prisma cannot
represent (`Unsupported("vector(1024)")`).

**Verified:** `migrate dev` output listed exactly those tables/indexes as drift and demanded a reset.

**Blast radius:** anyone reaching for the documented command can lose their local database.

**Fix / workaround (in use):** hand-author `prisma/migrations/<ts>_<name>/migration.sql` and apply with
`prisma migrate deploy`, which ignores drift and is what `bun run setup` and container start already
use. Documented in `libs/claw-studio/CLAUDE.md`.

**Partially fixed (2026-10-17):** the checkpoint-table half is genuinely fixable and now fixed — all 4
tables (`checkpoint_migrations`, `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`) use only
standard Postgres types (TEXT, JSONB, BYTEA, INTEGER) with composite primary keys, fully expressible in
Prisma's schema language with no `Unsupported` needed. Added `CheckpointMigration`/`Checkpoint`/
`CheckpointBlob`/`CheckpointWrite` models to `schema.prisma` (mapped via `@@map` to the exact table
names `PostgresSaver` uses) and a hand-authored `prisma/migrations/20261017120000_add_checkpoint_tables/
migration.sql` that creates them with the identical `CREATE TABLE IF NOT EXISTS` DDL
`PostgresSaver.setup()` runs at runtime — so this is a no-op on every existing deployment (where
`.setup()` already created the tables) and provisions them up front on a fresh database. Verified
end-to-end against a disposable Postgres: deployed all migrations from scratch, ran `.setup()`
(idempotent, no error), then confirmed via `prisma migrate diff --from-url ... --to-schema-datamodel`
that the checkpoint tables are no longer reported as drift at all — only the two pgvector HNSW indexes
remain. `libs/claw-studio`'s `persistence.test.ts` (real Postgres) still passes unchanged.

**Still open:** the pgvector HNSW index half is a genuine, permanent Prisma limitation — there is no
`Unsupported()` (or anything else) for an index, only for a column type, so `prisma migrate dev` will
always report `claw_memories_embedding_hnsw` and `idx_document_chunks_embedding` as drift. The existing
`migrate deploy` + hand-authored-migration workflow remains required for those two indexes.

---

## ✅ 6. FIXED (2026-08-03) — workspace per-file caps can exceed the total budget

**Where:** `libs/claw-studio/src/workspace/types.ts` (`SLUG_CHAR_CAPS`) vs
`CLAW_WORKSPACE_MAX_CHARS` (default 16000).

**Problem:** the per-file caps sum to 22000 (2000 + 4000 + 8000 + 4000 + 2000 + 2000). A tenant who
fills every file hits the total cap and the composed identity is truncated — with a visible marker, but
`heartbeat` (composed last) is what gets cut.

**Blast radius:** low today; the seeds are small. Would bite a heavy user silently apart from the
marker.

**Fix:** either raise `CLAW_WORKSPACE_MAX_CHARS` to ≥22000, or compose in priority order so
`heartbeat`/`tools` are dropped before `soul`/`agents`, or surface remaining budget in the `/agent` UI.

**Fixed:** raised the default to 24000. Also found and fixed a second, bigger bug while doing this —
`CLAW_WORKSPACE_MAX_CHARS` was declared in `env.ts` but never actually read anywhere: `composeIdentity`
takes an optional `totalCap` that falls back to a separately hardcoded `DEFAULT_TOTAL_CAP = 16_000` in
`prompt-composer.ts`, and its one caller, `claw-graph.ts`, never passed `totalCap` at all. So the env var
did nothing regardless of its value. `claw-graph.ts` now imports `env` and passes
`totalCap: env.CLAW_WORKSPACE_MAX_CHARS` to both `composeIdentity` calls; `prompt-composer.ts` stays
env-free per its own "pure" design note, since the caller supplies the real value now.

---

## ✅ 7. FIXED (2026-08-03) — `.xlsx` files in Google Drive return binary

**Where:** `libs/claw-studio/src/integrations/google-drive.ts` — `google_drive_read_file`.

**Problem:** Google-native files (Docs/Sheets/Slides) are exported as `text/plain` and read fine. A real
`.xlsx` goes through `alt=media` and returns raw binary, which is useless to the model.

**Blast radius:** any "read my spreadsheet" request against an uploaded Excel file — a plausible ask
given the chief-of-staff scenario.

**Fix:** detect the xlsx mime type and either convert via Drive (`?mimeType=text/csv` after a copy to a
Google Sheet) or parse it server-side. Also note `google_drive_create_file` only ever creates
`text/plain`.

**Fixed:** parsed server-side rather than via a Drive copy — `xlsx` (SheetJS) was already a root
dependency, unused in this file. `google_drive_read_file` now detects
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and legacy
`application/vnd.ms-excel`, fetches via `alt=media` as an `ArrayBuffer`, and returns the first
sheet/tab as CSV via `XLSX.utils.sheet_to_csv` — same "first sheet only" limitation already accepted
for native Google Sheets export, so behavior stays consistent. `google_drive_create_file` still only
creates `text/plain`, unchanged — out of scope here.

---

## 🟡 8. `save_memory` classifies read-only

**Where:** `agent/tool-classifier.ts` + `agent/memory-tools.ts`.

**Problem:** `save_memory` writes durable state but `save` is not in `MUTATIVE_PATTERNS`, so it is never
gated. Pinned as intended by `tool-classifier.test.ts`.

**Blast radius:** arguably correct — memory writes are frequent and benign, and gating them would prompt
on nearly every turn. Recorded so the choice is explicit rather than accidental.

**Fix:** none proposed. If it ever should gate, add it to `FREE_WRITE_SLUGS`-style grants rather than to
the mutative patterns.

---

## 🟡 9. e2e harness cannot reach Mission Control

**Where:** `apps/web-ui-e2e/playwright.config.ts`.

**Problem:** one `baseURL` on port 3005 (web-ui), one `chromium` project, one `webServer`. Mission
Control runs on 3010 with its **own** NextAuth Credentials login and its own `NEXTAUTH_SECRET` —
`apps/mission-control/middleware.ts` states it does not trust web-ui's session. So no Mission Control
journey is testable at all.

**Blast radius:** `/agent`, `/cron`, chat, runs, connectors — none covered by e2e.

**Fix:** plan `d5-e2e-coverage` — a second Playwright project with its own baseURL and a studio-session
minting setup, plus `testIgnore` on the existing project.

---

## 🟡 13. Mission Control has no individual users — one shared credential per studio

**Decision to make, not a bug.** Recorded so the choice is explicit before real users are onboarded.

**Where:** `apps/mission-control/lib/auth.ts` (Credentials provider `id: 'studio'`), `StudioService.authenticate`,
and the `ClawStudio` model in `prisma/schema.prisma`.

**Problem:** Mission Control authenticates a **studio**, not a person — `studioId` + `password` against
one `ClawStudio` row. Multi-tenancy itself is fine: the row carries `tenantId`, the JWT carries it, and
`middleware.ts` injects `x-tenant-id` exactly as web-ui does. But there is no per-person identity inside
a studio. Three consequences:

1. **No attribution.** Everyone sharing the credential is the same identity. `ClawRun.userId` is
   explicitly a *platform-native* actor id (Slack/Telegram), not a Mission Control operator, and is null
   for UI-initiated runs.
2. **No revocation granularity.** Removing one teammate's access means rotating the password for
   everyone using that studio.
3. **Audit rows record `'unknown'`.** `connectors/[channel]/route.ts:123` sets
   `actor: session.user?.email ?? session.user?.id ?? 'unknown'`, but `StudioAuthResult` is
   `{ studioRecordId, studioId, tenantId, clawId }` — no email — and the session callback populates
   `session.studio`, never `session.user`. So both branches miss and every
   `AuditService.logUserAction` call from Mission Control lands as `'unknown'`.

**Verified:** by inspection of the provider, `StudioAuthResult`, the session/jwt callbacks, and
`types/next-auth.d.ts` (which declares `Session.studio` and no `Session.user` augmentation). Consequence 3
is a code-reading result and has not been confirmed against a live audit row.

**Blast radius:** compounds issue #11. That entry notes any Slack workspace member can press
`approve_always`; this one means that even when approval is moved into the Mission Control UI —
suggestion #2 there — the resulting audit trail still cannot say *which human* granted a standing
permission. The two together mean a standing tool grant is currently unattributable end to end.

Also note `studioId` is `@unique` globally, not per tenant — one flat namespace, so two tenants cannot
both have a studio named `support`.

**Options, cheapest first:**
1. **Keep shared credentials, fix attribution** — set `actor` from `session.studio.studioId` so audit
   rows at least name the studio. ~1 line, removes the `'unknown'` bug regardless of what is decided
   below.
2. **Named operators inside a studio** — a `ClawStudioUser` table (studio + email + passwordHash), login
   becomes studio + user + password. Gives real revocation and attribution. Medium: new model, migration,
   login form, session shape.
3. **Federate to web-ui's user auth** — drop the separate login and authorize existing `AuthUser`s
   against a studio via RBAC. Best UX and reuses existing users, but directly contradicts the current
   design (`middleware.ts:4-5` says Mission Control deliberately does not trust web-ui's session), so it
   is a real architectural reversal, not a tweak.

Option 1 is worth doing now whichever way 2/3 goes.

**Partially fixed (2026-08-03):** option 1 done — all 5 route files using
`session.user?.email ?? session.user?.id ?? 'unknown'` (`connectors/[channel]/route.ts`,
`integrations/[integration]/route.ts`, `integrations/[integration]/oauth/callback/route.ts`,
`integrations/[integration]/accounts/[accountId]/route.ts`, `runs/[runId]/action/route.ts`) now set
`actor: session.studio.studioId` (no `?? 'unknown'` fallback — `studioId` is a required, non-optional
`string` on `Session.studio`, confirmed in `types/next-auth.d.ts`, so the fallback was dead code).
Audit rows now name the studio. Options 2/3 — per-operator identity — remain an open product decision,
not attempted here.

---

## 🟡 14. REVERTED (2026-08-03) — "Claw Studio" names three different levels of the hierarchy

**Naming/IA decision, not a bug.** Surfaced while deciding Mission Control's URL structure.

**Where:** `apps/web-ui/components/layout/app-sidebar.tsx:78`,
`apps/mission-control/components/console-sidebar.tsx:57,61,69-71,115,132`, and
`apps/mission-control/lib/nav-config.tsx` (`clawStudioNav`).

**Problem:** the same label is used at three nested scopes, one inside the other:

1. **The product**, in web-ui's sidebar — `{ name: 'Claw Studio', href: '/claw-studio' }`. That page
   provisions the studio, shows its ID/password, and opens Mission Control in a new tab.
2. **The tenant's studio identity**, as the subtitle under the studio id in Mission Control's profile
   menu (`console-sidebar.tsx:115,132`).
3. **A three-item collapsible group** inside Mission Control's own sidebar (`console-sidebar.tsx:69-71`)
   containing only LLM Providers, Playground and Runs.

The nesting inside Mission Control is layered further: a `SidebarGroupLabel` of **"Claw"** (line 61)
wraps a collapsible called **"Claw Studio"** (line 71), which sits *next to* Chat with Claw, Agent and
Scheduled Tasks — items that are equally "Claw" but are not in the group. So "Claw Studio" is
simultaneously the whole product, the tenant's instance of it, and 3 of its 14 pages.

**Verified:** read directly from the two sidebar components and `nav-config.tsx`. `clawStudioNav`
contains exactly `/llm-providers`, `/playground`, `/runs`.

**Blast radius:** no functional impact. It is a comprehension cost — a user told "go to Claw Studio"
cannot tell whether that means the web-ui page, the Mission Control app, or the collapsible group. It
also made the URL question genuinely ambiguous (see below).

**Explicitly decided (2026-08-02): URLs stay flat** — `/mission-control/runs`, not
`/mission-control/claw-studio/runs`. URL structure should follow resource hierarchy, not sidebar
grouping: the three grouped pages share no parent resource (LLM Providers is tenant config, Runs are
execution records), the segment would carry no information since there is one Claw per studio and the
studio comes from the session, and sidebar groupings get reorganised while URLs are a contract —
bookmarks, history, and the OAuth redirect URIs built from `NEXT_PUBLIC_MISSION_CONTROL_URL`. The
`/mission-control` prefix is kept because it separates two genuinely distinct applications on one
origin.

**Fix:** rename, don't re-route. The innermost group is the wrong one to call "Claw Studio" — something
like "Engine", "Execution" or "Runtime" describes LLM Providers + Playground + Runs without colliding
with the product name. Label-only change in `console-sidebar.tsx`; no routes move.

**Tried, then reverted (2026-08-03):** renamed the innermost collapsible group to "Engine" — the
`CollapsibleTrigger`'s `tooltip` and visible `<span>` in `console-sidebar.tsx`, plus two `// Claw Studio`
comments in `nav-config.ts`. **Explicitly rejected by the product owner** — the label should stay "Claw
Studio" despite the three-level ambiguity documented above. Reverted the same day; both files are back to
"Claw Studio". Do not re-attempt this rename — the ambiguity is accepted as-is.

---

## 🔴 15. Every memory write fails — embedding model emits 1536 dims into a `vector(1024)` column

**Where:** `prisma/schema.prisma:1389` (`ClawMemory.embedding Unsupported("vector(1024)")`), the
`LlmProvider.embeddingModel` row, and every writer through `libs/claw-studio/src/memory/` —
`reconcile.ts`, `episode.ts`, `memory-nodes.ts`, `memory-service.ts`, `embeddings.ts`.

**Problem:** the column is `vector(1024)`, sized for Bedrock Titan **v2**
(`amazon.titan-embed-text-v2:0`) — the schema says so at line 1378: *"Uses pgvector for similarity
search with Bedrock Titan v2 embeddings (1024-dim)"*. The tenant's provider is instead set to Titan
**G1** (`amazon.titan-embed-g1-text-02`), which emits **1536** dimensions. Every INSERT into
`claw_memories` therefore fails:

```
prisma:error  Raw query failed. Code: 22000
Message: ERROR: expected 1024 dimensions, not 1536
```

**Verified:** reproduced across a full chat session on 2026-08-02. `llm_providers` row reads
`llm-pro-aws | embed=amazon.titan-embed-g1-text-02 | dims=null`. Three separate call sites failed in
one conversation — `MemorySave` reconcile ADD (×2, `summary: { added: 0, failed: 2 }`), and
`Episode capture failed (non-fatal)`.

**Not caused by the basePath / Mission Control work.** All five memory files are byte-identical to
`origin/feature/claw-studio`, as is the `20260716085055_add_claw_memory` migration. The column was
introduced 2026-07-16 in `22260b2` (Omar Hussain); the memory code last changed 2026-07-29 in
`8758933` (Adya Tiwari) — both well before the integration branch existed.

**Blast radius:** worse than it looks in the logs. Memory *recall* works — a session shows
`[MemoryRecall:facts] hits: assistant_name` — so the agent appears to remember. But **nothing new is
ever persisted**. Claw looks like it is learning and silently is not. `POST /api/chat` still returns
200 because every failure is caught and logged as a WARN, so there is no user-visible signal at all.

**Fix — a decision, not a one-liner.** Pointing the provider at `amazon.titan-embed-text-v2:0` is a
single row update, but any rows already stored at 1536 dims become unreadable, and re-embedding is
required. This is the same call already parked as the *"embedding dimensions redesign"* deferred item.
Options: (a) switch the provider to Titan v2 and re-embed existing rows; (b) widen the column and index
to 1536; (c) make the dimension follow `LlmProvider.embeddingDimensions` — currently `null` and unused —
so the schema stops hard-coding one provider's shape. Note `document_chunks.embedding` is also
`vector(1024)`, so whichever way this goes, both tables need to agree.

**Partially fixed (2026-08-03).** Chose option (a): the schema's own default (`amazon.titan-embed-text-v2:0`,
1024-dim) is already correct, so nothing needed re-embedding — every insert has been failing outright
since 2026-07-16, meaning nothing was ever successfully written at 1536 dims to begin with.

Root cause, precisely: the dimension guardrail already existed in `embeddings.ts` — `if
(config.embeddingDimensions && config.embeddingDimensions !== REQUIRED_EMBEDDING_DIMENSIONS)` — but the
misconfigured row has `embeddingDimensions: null`, so `&&` short-circuited and the check never fired.

- **Code fix (done):** added `KNOWN_MODEL_DIMENSIONS`, a small static lookup
  (`embeddings.ts`) that the guardrail now falls back to when `embeddingDimensions` is unset, so a
  recognized mismatched model (Titan G1 → 1536) is caught even with no stored dimension. An unrecognized
  model with no stored dimension still can't be validated without calling the API — that residual gap is
  unchanged. Covered by a new test reproducing the exact null-dimensions scenario.
- **Data fix (not done — needs DB access):** the affected tenant's `LlmProvider` row still needs
  `embeddingModel` set to `amazon.titan-embed-text-v2:0` and `embeddingDimensions` to `1024`, via the
  Mission Control LLM Providers page or a direct `prisma.llmProvider.update(...)`. Local Postgres wasn't
  reachable in the session that made this fix, so the row itself is still wrong — the guardrail will now
  at least surface a clear `ClawEmbeddingsConfigError` instead of a raw Postgres 22000 until it's
  corrected.

  Exact remediation, once DB access is available — find the affected row(s) first (any provider whose
  stored dimension doesn't match the column, or whose model is a known mismatch like Titan G1):

  ```sql
  SELECT id, "tenantId", "embeddingModel", "embeddingDimensions" FROM llm_providers
  WHERE "embeddingModel" IS NOT NULL
    AND ("embeddingDimensions" IS NULL OR "embeddingDimensions" != 1024);
  ```

  Then, per affected row (nothing was ever successfully written at the wrong dimension, so no
  re-embedding is required — this is a config correction, not a data migration):

  ```sql
  UPDATE llm_providers
  SET "embeddingModel" = 'amazon.titan-embed-text-v2:0', "embeddingDimensions" = 1024
  WHERE id = '<affected row id>';
  ```

  This is deployment-specific data, not something a PR against this repo can fix — recorded here so
  whoever has DB access can apply it directly from the issue, without re-deriving the root cause.

---

## ✅ 16. FIXED (2026-08-03) — memory extraction intermittently fails on malformed LLM JSON

**Where:** `libs/claw-studio/src/memory/memory-nodes.ts` — `[MemorySave]` extraction step.

**Problem:** the extraction prompt asks the model for JSON and parses the reply directly. When the model
returns something not-quite-JSON, the step throws:

```
WARN: [MemorySave] Extraction failed
error: "Expected ':' after property name in JSON at position 14 (line 1 column 15)"
```

**Verified:** observed 2026-08-02. Intermittent, not deterministic — the very next message in the same
session extracted cleanly (`extracted: 2, dropped: 0`), so this is model output variance rather than a
code fault. Unchanged since `origin/feature/claw-studio`.

**Blast radius:** low individually — one turn's learnings are dropped and the run continues. Compounds
issue #15 though: between them, memory writes fail both when the model misformats and when the write
itself is rejected.

**Fix:** ask for structured output rather than free-form JSON (tool-call / `responseFormat`), or wrap
the parse in a repair pass — strip code fences, retry once with the parser error fed back. Worth pairing
with #15 since both live on the same write path.

**Fixed:** took the repair-pass option (lower risk than switching to structured/tool-call output).
`memory-nodes.ts` now strips ```` ```json ``` ```` code-fence wrapping before the array regex match, and
wraps `JSON.parse` in its own try/catch — on a `SyntaxError`, it retries **once**, re-invoking the model
with the exact parse error and the malformed text, asking for a corrected array only. A second failure
falls through to the original behavior unchanged (logged WARN, that turn's learnings are dropped, run
continues). Three new tests cover: recovery after one retry, a code-fenced response needing no retry,
and both attempts failing without throwing.

---

## 🟡 17. `MaxListenersExceededWarning` flood during `bun run dev:all`

**Where:** local development only — `nx run-many -t serve --parallel` with the Pino logger.

**Problem:** Node warns repeatedly during dev:

```
MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 unpipe listeners added to [WriteStream]. MaxListeners is 10.
```

Each parallel Nx target attaches its own `unpipe`/`error`/`close`/`finish` listeners to the shared
stdout `WriteStream`, and Pino adds more, crossing Node's default limit of 10.

**Verified:** observed 2026-08-02 with counts of 11 and 17 across separate runs, scaling with how many
projects are serving. Not present in the containers — this is a `dev:all` artifact.

**Blast radius:** none functional. It is log noise that buries real warnings, which is the only reason
it is worth recording.

**Fix:** `require('node:events').setMaxListeners(30)` in the dev entrypoint, or run fewer targets in
parallel. Cosmetic — do not spend real time on it.

---

## 🟡 10. ~17 pre-existing `e2e:smoke` failures

**Where:** `apps/web-ui-e2e` marketing and docs specs.

**Problem:** rotted against a prior rewrite; unrelated to Claw Studio.

**Blast radius:** `bun run e2e:smoke` is red, masking real e2e regressions.

**Fix:** update or delete the rotted specs. Not Claw Studio work.
