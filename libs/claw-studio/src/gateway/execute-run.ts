/**
 * execute-run.ts — drives one gateway run to completion, a pause, or a failure.
 *
 * Runs inside the `claw-gateway-run` worker job, never in a request handler:
 * the graph can take minutes and Slack wants its ack in three seconds. The
 * notification router is attached in the same process, so the event bus never
 * has to cross a process boundary.
 *
 * Terminal outcomes, one of:
 *   completed          → graph reached `final` (task path) or `respond`
 *                        (conversational path); result.answer is the visible reply
 *   awaiting_approval  → interruptOn (humanInTheLoopMiddleware) paused the agent
 *                        loop mid-tool-call; approvalRequest is set
 *   awaiting_input     → clarify node asked a question; clarification is set
 *   cancelled          → status flipped to cancelled out-of-process mid-run
 *   failed             → anything threw
 */

import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createLogger } from '@chatbot/shared';
import { resolveClawRuntime, BACKGROUND_MAX_ITERATIONS } from '../agent/claw-runtime';
import { registerRun, cleanupRun } from '../agent/run-manager';
import { getConnectorRegistry } from '../connectors/registry';
import { getRunEventBus } from './event-bus';
import { attachToRun, type RouterDeps } from './notification-router';
import { getRunService } from './run-service';
import { extractTextContent } from '../agent/agent-shared';
import type { PromptSurface } from '../agent/prompt-composer';
import type { ApprovalMode } from '../scheduler/types';
import {
  DASHBOARD_SOURCE,
  PLAYGROUND_SOURCE,
  isTerminalStatus,
  type ApprovalRequest,
  type ChannelAdapter,
  type ClawRunEventRecord,
  type ClawRunRecord,
  type ReplyAction,
  type RunEventType,
} from './types';

const logger = createLogger('claw-studio:gateway:execute');

export interface ExecuteRunInput {
  runId: string;
  /** Present when this is a HIL resume rather than a first execution. */
  resume?: { action: Exclude<ReplyAction, 'reject'>; content?: string; actorId?: string };
  deps: RouterDeps;
  /**
   * Per-run runtime shaping. Optional and defaulted, so channel runs are unchanged;
   * scheduled runs use it to carry their least-privilege approval policy, their own
   * iteration budget, and the `scheduled` prompt surface (which injects HEARTBEAT).
   */
  runtimeOverrides?: {
    approvalPolicy?: { mode: ApprovalMode; allowedTools?: string[] };
    maxIterations?: number;
    providerModelId?: string;
    promptSurface?: PromptSurface;
  };
}

// Node names are gone with the graph; the only thing worth suppressing is a
// bare node_complete carrying no text, which the loop emits between tool calls.
const SILENT_NODES = new Set<string>();

export interface NodeUpdate {
  messages?: Array<{
    _getType?: () => string;
    content?: unknown;
    /** LangChain assigns one per message; what `deriveNodeEvents` dedupes on. */
    id?: string;
    tool_calls?: Array<{ name?: string; args?: unknown }>;
    /** Present on ToolMessages — the tool whose result this is. */
    name?: string;
    /** LangChain marks a failed tool result with status: 'error'. */
    status?: string;
  }>;
  /** @deprecated Written by the deleted graph. Nothing populates it under deepagents. */
  toolResults?: Array<{ toolName?: string; output?: string; isError?: boolean }>;
  /** @deprecated Superseded by `todos`; see deriveNodeEvents. */
  plan?: Array<{ step: string; status: string }>;
  /** todoListMiddleware's channel: the live plan, as `{ content, status }`. */
  todos?: Array<{ content?: string; status?: string }>;
  clarificationQuestion?: string | null;
  pendingToolApprovals?: string[];
  /**
   * What the memory middleware did this turn. Written by
   * `memory/memory-middleware.ts`'s `beforeAgent` (recall) and `afterAgent`
   * (save); shaped by `memory/types.ts`'s `MemoryStats` union.
   */
  memoryStats?: {
    phase?: string;
    facts?: unknown[];
    rules?: unknown[];
    episodes?: unknown[];
    injected?: boolean;
    savedFacts?: number;
    savedRules?: number;
    episodeCaptured?: boolean;
    reconcileActions?: Record<string, number>;
  } | null;
  [key: string]: unknown;
}

function resolveAdapter(source: string): ChannelAdapter | null {
  if (source === DASHBOARD_SOURCE || source === PLAYGROUND_SOURCE) return null;
  const registry = getConnectorRegistry();
  if (!registry.has(source)) {
    logger.warn({ source }, 'Run references an unregistered channel — no notifications will be sent');
    return null;
  }
  return registry.get(source) as ChannelAdapter;
}

export interface NodeEventDraft {
  eventType: RunEventType;
  content?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolOutput?: string;
  metadata?: Record<string, unknown>;
}

/** `2 facts` / `1 fact`, or null when the count is zero. */
function count(n: number, singular: string): string | null {
  if (!n) return null;
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

/**
 * Renders one memory phase as a timeline call/result PAIR.
 *
 * A pair, not a lone result, because `agent-steps.tsx`'s `buildSteps` closes a
 * `tool_result` against the most recent still-running `tool_call` OF THE SAME
 * NAME and silently drops a result that matches none — a single result event
 * would render nothing at all.
 *
 * The names are deliberately `memory_recall`/`memory_save` rather than the real
 * `search_memory`/`save_memory` tools (`agent/memory-tools.ts`), which the model
 * can also call directly. Sharing a name would let this middleware result close
 * out the model's own in-flight tool call, and vice versa, since that matching
 * is by name alone.
 */
/**
 * Whether a tool's recovered output is reporting its own failure.
 *
 * Anchored at the start on purpose: the convention across all 111 catch paths in
 * `src/integrations` is a leading `Error <verb>ing …:`, while a legitimate result
 * may well mention the word further in ("2 messages about the Error Budget
 * review"). Matching anywhere would flag those as failures.
 */
const RECOVERED_FAILURE = /^\s*(error|failed)\b/i;

function reportsRecoveredFailure(output: string): boolean {
  return RECOVERED_FAILURE.test(output);
}

function memoryDrafts(stats: NonNullable<NodeUpdate['memoryStats']>): NodeEventDraft[] {
  const isSave = stats.phase === 'save';
  const toolName = isSave ? 'memory_save' : 'memory_recall';

  let output: string;
  if (isSave) {
    const saved = [count(stats.savedFacts ?? 0, 'fact'), count(stats.savedRules ?? 0, 'rule')]
      .filter(Boolean)
      .join(', ');
    const parts: string[] = [saved ? `Saved ${saved}` : 'Nothing new to save'];
    if (stats.episodeCaptured) parts.push('episode captured');
    // Only the actions that actually happened — printing `superseded 0` on every
    // turn is noise, and SUPERSEDE is the one worth noticing when it does fire.
    const reconciled = Object.entries(stats.reconcileActions ?? {})
      .filter(([, n]) => n > 0)
      .map(([action, n]) => `${action} ${n}`)
      .join(', ');
    if (reconciled) parts.push(`(${reconciled})`);
    output = parts.join('; ');
  } else {
    const found = [
      count(stats.facts?.length ?? 0, 'fact'),
      count(stats.rules?.length ?? 0, 'rule'),
      count(stats.episodes?.length ?? 0, 'episode'),
    ]
      .filter(Boolean)
      .join(', ');
    output = found
      ? `Recalled ${found}${stats.injected ? ' — added to context' : ''}`
      : 'Searched memory — no relevant memories found';
  }

  return [
    { eventType: 'tool_call', toolName, toolArgs: undefined },
    { eventType: 'tool_result', toolName, toolOutput: output, metadata: undefined },
  ];
}

/**
 * Pure: turns one `graph.stream()` chunk into the timeline events it implies,
 * without persisting or emitting anything. Split out of `recordRunEvents` so a
 * caller with no `ClawRun` to persist against — Chat-with-Claw's live-only
 * activity view, which deliberately writes nothing to the database — can
 * derive the exact same event shapes the persisted paths (gateway worker,
 * Playground) use.
 */
export function deriveNodeEvents(
  node: string,
  update: NodeUpdate,
  /**
   * Message ids already rendered for this stream. Pass one Set for the whole
   * graph run to suppress duplicates; omit it to keep the previous behaviour.
   *
   * deepagents reports SEVERAL nodes per graph chunk — the agent plus each
   * middleware — and they all carry the same trailing AI message, because
   * `messages` is a shared channel. Both callers loop `Object.entries(updates)`
   * and call this once per node, so a single answer was rendered two to four
   * times in the timeline. Deduping on the message's own id is what makes this
   * safe: a model that genuinely repeats itself produces a second message with a
   * different id, so real repetition still shows twice.
   */
  seenMessageIds?: Set<string>,
): NodeEventDraft[] {
  const drafts: NodeEventDraft[] = [];

  /** True the first time this id is seen; false afterwards. Untracked ids (no id
   *  on the message) always report first-time, since there is nothing to key on
   *  and silently dropping content is worse than rendering it twice. */
  const firstSighting = (id: string | undefined): boolean => {
    if (!id || !seenMessageIds) return true;
    if (seenMessageIds.has(id)) return false;
    seenMessageIds.add(id);
    return true;
  };

  // Memory runs as middleware hooks rather than tool calls, so it produces no
  // ToolMessage and none of the branches below can see it. Emitted ahead of the
  // SILENT_NODES check because these events are the whole point of the chunk —
  // whether the surrounding node is one whose text we suppress is irrelevant.
  if (update.memoryStats) drafts.push(...memoryDrafts(update.memoryStats));

  // Tool calls the model just requested.
  const lastMessage = update.messages?.[update.messages.length - 1];
  // One check covers this message's whole contribution — its tool calls AND its
  // text below — so an echoed message adds neither.
  const aiIsNew = lastMessage?._getType?.() === 'ai' ? firstSighting(lastMessage.id) : true;
  for (const call of aiIsNew ? lastMessage?.tool_calls ?? [] : []) {
    drafts.push({ eventType: 'tool_call', toolName: call.name ?? 'unknown_tool', toolArgs: call.args });
  }

  // Tool results, from BOTH places they can appear.
  //
  // `toolResults` was a channel of the hand-written graph. Nothing writes it
  // under deepagents — its ToolNode returns ToolMessages on `messages` instead —
  // so reading only that channel meant no tool ever appeared to finish: the chat
  // timeline showed a spinner per tool call, forever, with no output.
  for (const result of update.toolResults ?? []) {
    drafts.push({
      eventType: 'tool_result',
      toolName: result.toolName ?? 'unknown_tool',
      toolOutput: result.output ?? '',
      metadata: result.isError ? { isError: true } : undefined,
    });
  }

  for (const message of update.messages ?? []) {
    if (message?._getType?.() !== 'tool') continue;
    // Same echo problem as the AI message above; two real calls to one tool carry
    // two ids, so this never collapses genuine repetition.
    if (!firstSighting(message.id)) continue;
    const output = extractTextContent(message.content);
    drafts.push({
      eventType: 'tool_result',
      toolName: message.name ?? 'unknown_tool',
      toolOutput: output,
      // `status` alone is not enough. Tools here deliberately never throw — a
      // thrown LangChain tool error aborts the entire run — so every failure path
      // in src/integrations returns a recoverable `Error …` string and the
      // ToolMessage stays `status: 'success'`. Reading only `status` rendered a
      // green tick for a Google Calendar call that had actually failed
      // reauthorization, hiding the real fault behind an apparently healthy
      // timeline. `status` is still checked first, for the tools that do throw.
      metadata: message.status === 'error' || reportsRecoveredFailure(output) ? { isError: true } : undefined,
    });
  }

  if (SILENT_NODES.has(node)) return drafts;

  // The node's own text output, when it produced one.
  const text = aiIsNew && lastMessage && lastMessage._getType?.() === 'ai' ? extractTextContent(lastMessage.content) : '';
  // `todos` is what todoListMiddleware actually writes ({ content, status });
  // `plan` ({ step, status }) is the deleted graph's channel, kept only so an
  // older persisted run still renders.
  const todos = update.todos?.length
    ? update.todos.map((t) => ({ step: t.content ?? '', status: t.status ?? 'pending' }))
    : undefined;
  const planSteps = todos ?? update.plan;
  const metadata = planSteps ? { plan: planSteps } : undefined;
  // A node_complete only earns a place on the timeline when it carries text or
  // plan metadata. Most chunks under the agent loop are tool traffic with
  // neither — emitting a bare node_complete for each of those, or for a wholly
  // empty chunk, floods the timeline. write_todos chunks DO carry `update.plan`
  // with no AI text, so this must not fall through — otherwise the plan payload
  // for the feature that replaced the planner node is unreachable.
  if (!text && !metadata) return drafts;

  drafts.push({
    eventType: 'node_complete',
    content: text || undefined,
    metadata,
  });
  return drafts;
}

/**
 * Turns one `graph.stream()` chunk into timeline events, persisting each as a
 * ClawRunEvent and emitting it on the run's event bus. Exported so any caller
 * driving a `graph.stream()` loop against a `ClawRun` gets the same event
 * shaping as the gateway worker — e.g. the Playground's inline (non-worker)
 * run endpoint.
 */
export async function recordRunEvents(
  run: ClawRunRecord,
  node: string,
  update: NodeUpdate,
  /** One Set per run — see `deriveNodeEvents`'s `seenMessageIds`. */
  seenMessageIds?: Set<string>,
): Promise<ClawRunEventRecord[]> {
  const runs = getRunService();
  const bus = getRunEventBus();
  const recorded: ClawRunEventRecord[] = [];

  for (const draft of deriveNodeEvents(node, update, seenMessageIds)) {
    const event = await runs.appendEvent(run, { ...draft, node });
    recorded.push(event);
    bus.emit({ name: 'run:event', runId: run.runId, event });
  }
  return recorded;
}

/**
 * Reads the agent's interrupt payloads and names the tools awaiting approval.
 *
 * The real payload shape — confirmed against `humanInTheLoopMiddleware`
 * (`node_modules/langchain/dist/agents/middleware/hitl.js:469-472` and the
 * `HITLRequest`/`ActionRequest`/`Interrupt<Value>` types in
 * `hitl.d.ts:158-171,209-218` and
 * `node_modules/@langchain/langgraph/dist/constants.d.ts:169-172`) — is:
 *
 *   { id?: string; value?: { actionRequests: Array<{ name: string; args: Record<string, unknown>; description?: string }>; reviewConfigs: [...] } }
 *
 * i.e. camelCase `actionRequests`, and each entry's tool name is under `name`,
 * not `action`/`action_requests` as an earlier draft of this plan guessed.
 * Unlike the old `interruptBefore` gate, this payload carries the tool name
 * (and args) at the moment of the pause itself, so the list is never empty —
 * this closes the bug recorded in libs/claw-studio/CLAUDE.md.
 */
export function approvalRequestFrom(interrupts: unknown[], values: NodeUpdate): ApprovalRequest {
  const names: string[] = [];
  for (const raw of interrupts) {
    const value = (raw as { value?: unknown })?.value as
      | { actionRequests?: Array<{ name?: string }> }
      | undefined;
    for (const req of value?.actionRequests ?? []) {
      if (req.name) names.push(req.name);
    }
  }
  if (names.length > 0) return { kind: 'tool', pendingTools: names };
  return { kind: 'plan', planSteps: (values.plan ?? []).map((s) => s.step) };
}

export async function executeRun(input: ExecuteRunInput): Promise<void> {
  const runs = getRunService();
  const bus = getRunEventBus();
  const { runId, resume, deps, runtimeOverrides } = input;

  const run = await runs.get(runId);
  if (!run) {
    logger.warn({ runId }, 'Run not found — nothing to execute');
    return;
  }

  // Idempotency: pg-boss can redeliver, and a terminal run must not re-execute.
  if (isTerminalStatus(run.status)) {
    logger.info({ runId, status: run.status }, 'Run already terminal — skipping execution');
    return;
  }

  const adapter = resolveAdapter(run.source);
  // Subscribe BEFORE any execution so no early event is missed.
  const unsubscribe = adapter ? attachToRun(run, adapter, deps) : () => {};
  const abortController = registerRun(run.threadId);
  let runtime: Awaited<ReturnType<typeof resolveClawRuntime>> | null = null;
  /** Set when this pass ends parked at an approval gate — read by the `finally`. */
  let pausedForApproval = false;

  try {
    await runs.markInProgress(runId);
    if (!resume) {
      await runs.appendEvent(run, { eventType: 'run_started', content: run.taskDescription });
    }

    runtime = await resolveClawRuntime({
      tenantId: run.tenantId,
      threadId: run.threadId,
      maxIterations: runtimeOverrides?.maxIterations ?? BACKGROUND_MAX_ITERATIONS,
      sourceRunId: run.runId,
      // Spread conditionally so a channel run's call shape stays minimal rather
      // than carrying a row of explicit `undefined`s.
      ...(runtimeOverrides?.promptSurface ? { promptSurface: runtimeOverrides.promptSurface } : {}),
      ...(runtimeOverrides?.approvalPolicy ? { approvalPolicy: runtimeOverrides.approvalPolicy } : {}),
      ...(runtimeOverrides?.providerModelId
        ? { overrides: { providerModelId: runtimeOverrides.providerModelId } }
        : {}),
    });

    // Resume shape per action. `approve` feeds a decision back into the paused
    // `interrupt()` call via `Command({ resume })` — `humanInTheLoopMiddleware`
    // destructures `.decisions` off whatever `resume` value it's fed
    // (hitl.js:469-472), and requires exactly one decision per action request
    // it bundled into that interrupt (hitl.js:480). The persisted
    // `run.approvalRequest.pendingTools` is exactly that action-request count —
    // it was populated by `approvalRequestFrom` from the same interrupt at the
    // moment of the pause — so it's used here rather than re-fetching state.
    // A clarification reply is a genuine new turn on the same thread.
    let graphInput: { messages: HumanMessage[] } | Command | null = null;
    if (!resume) {
      graphInput = { messages: [new HumanMessage(run.taskDescription)] };
    } else if (resume.action === 'approve' || resume.action === 'approve_always') {
      // Both unblock the gate identically. The "always" part — persisting the grant
      // onto the scheduled task — happens before this, in the worker handler, so the
      // gateway keeps no dependency on the scheduler module.
      const decisionCount = run.approvalRequest?.pendingTools?.length || 1;
      graphInput = new Command({
        resume: { decisions: Array.from({ length: decisionCount }, () => ({ type: 'approve' as const })) },
      });
      await runs.appendEvent(run, {
        eventType: 'approval_decision',
        content: resume.action === 'approve_always' ? 'approved (always, for this task)' : 'approved',
        metadata: resume.actorId ? { actorId: resume.actorId } : undefined,
      });
    } else {
      graphInput = { messages: [new HumanMessage(resume.content ?? '')] };
    }

    const stream = await runtime.graph.stream(graphInput, {
      ...runtime.config,
      signal: abortController.signal,
    });

    let cancelled = false;
    // One Set for the whole run: deepagents echoes the same message across every
    // node it reports in a chunk, so without this each answer and tool result is
    // persisted several times over.
    const seenMessageIds = new Set<string>();
    for await (const chunk of stream) {
      for (const [node, update] of Object.entries(chunk as Record<string, NodeUpdate>)) {
        await recordRunEvents(run, node, update ?? {}, seenMessageIds);
      }
      // Cancellation arrives from another process (the dashboard route can't
      // reach this AbortController), so it shows up as a status change in the DB.
      if ((await runs.getStatus(runId)) === 'cancelled') {
        cancelled = true;
        abortController.abort();
        break;
      }
    }

    if (cancelled) {
      logger.info({ runId }, 'Run cancelled mid-execution');
      bus.emit({ name: 'run:cancelled', runId, reason: 'Run was cancelled.' });
      return;
    }

    // deepagents' `DeepAgent extends ReactAgent`, whose `getState` is typed
    // `internal-only` — the awaited result types as `never`. Same library-typing
    // limitation Task 8 hit in both `apps/mission-control` chat/playground
    // routes; cast the awaited result inline there too, so all three call
    // sites agree on the same shape rather than inventing a third pattern.
    const state = (await runtime.graph.getState(runtime.config)) as {
      values?: NodeUpdate;
      tasks?: Array<{ interrupts?: unknown[] }>;
    };
    const values = (state.values ?? {}) as NodeUpdate;
    const interrupts = (state.tasks ?? []).flatMap((t: { interrupts?: unknown[] }) => t.interrupts ?? []);

    // Paused at an approval gate (interruptOn / humanInTheLoopMiddleware).
    if (interrupts.length > 0) {
      // Tells the `finally` below to park the browser rather than close it: the
      // tool awaiting approval may be a page interaction, which will resume
      // against the page loaded right now. See browser-session-registry.ts.
      pausedForApproval = true;
      const request = approvalRequestFrom(interrupts, values);
      await runs.markAwaitingApproval(runId, request);
      await runs.appendEvent(run, {
        eventType: 'approval_request',
        content: request.kind === 'tool'
          ? `Approval needed to run: ${(request.pendingTools ?? []).join(', ')}`
          : 'Approval needed for the plan',
        metadata: { ...request },
      });
      bus.emit({
        name: request.kind === 'tool' ? 'hil:tool_approval' : 'hil:plan_approval',
        runId,
        request,
      });
      return;
    }

    // Clarify path — the graph ended by asking the user something.
    const question = values.clarificationQuestion;
    if (values.nextAction === 'awaiting_input' && typeof question === 'string' && question.trim()) {
      await runs.markAwaitingInput(runId, question);
      await runs.appendEvent(run, { eventType: 'clarification', content: question });
      bus.emit({ name: 'hil:clarification', runId, question });
      return;
    }

    // Completed.
    const messages = (values.messages ?? []) as NodeUpdate['messages'];
    const lastAi = [...(messages ?? [])].reverse().find((m) => m._getType?.() === 'ai');
    const answer = lastAi ? extractTextContent(lastAi.content) : '';
    const toolsUsed = [
      ...new Set((values.toolResults ?? []).map((t) => t.toolName).filter((n): n is string => !!n)),
    ];
    await runs.markCompleted(runId, {
      answer: answer || 'Claw finished without producing a reply.',
      iterations: typeof values.iterationCount === 'number' ? values.iterationCount : undefined,
      toolsUsed,
    });
    bus.emit({ name: 'run:completed', runId });
    logger.info({ runId, tenantId: run.tenantId, answerLength: answer.length }, 'Gateway run completed');
  } catch (error) {
    const aborted = abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    if (aborted) {
      logger.info({ runId }, 'Run aborted');
      await runs.markCancelled(runId, 'Run was cancelled.').catch(() => {});
      bus.emit({ name: 'run:cancelled', runId, reason: 'Run was cancelled.' });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, runId, tenantId: run.tenantId }, 'Gateway run failed');
    await runs.markFailed(runId, message).catch(() => {});
    await runs.appendEvent(run, { eventType: 'error', content: message }).catch(() => {});
    bus.emit({ name: 'run:failed', runId, error: message });
    throw error;
  } finally {
    // Let the router finish delivering before the bus is torn down.
    await bus.drain(runId).catch(() => {});
    unsubscribe();
    bus.cleanup(runId);
    cleanupRun(run.threadId, abortController);
    await runtime?.cleanup?.({ keepBrowser: pausedForApproval }).catch(() => {});
  }
}

/**
 * Ends a run without re-entering the executor, and tells the channel why.
 *
 * Reject deliberately does NOT resume the graph. Resuming with
 * approvalStatus:'rejected' would route straight back into the same gate
 * (`routeFromPlanner` sends anything that isn't 'approved' to approval_gate, and
 * routeFromGenerateToTools does the same for the mutative gate), leaving the run
 * pending approval forever instead of answering. So a rejection is terminal
 * here, matching the design reference (§7).
 *
 * Cancel takes the same path when the run isn't currently executing. A run that
 * IS executing is cancelled by flipping its status instead — executeRun notices
 * between graph steps and emits run:cancelled itself, so routing it through here
 * as well would double-notify the channel.
 */
export async function terminateRun(input: {
  runId: string;
  deps: RouterDeps;
  kind: 'reject' | 'cancel';
  /** Platform user id that rejected, when `kind` is `'reject'` and it came from a channel. */
  actorId?: string;
}): Promise<void> {
  const runs = getRunService();
  const bus = getRunEventBus();
  const run = await runs.get(input.runId);
  if (!run) {
    logger.warn({ runId: input.runId, kind: input.kind }, 'Terminate for unknown run');
    return;
  }
  if (isTerminalStatus(run.status)) {
    logger.info(
      { runId: run.runId, status: run.status, kind: input.kind },
      'Terminate on an already-terminal run — ignored',
    );
    return;
  }

  const rejected = input.kind === 'reject';
  const reason = rejected
    ? 'Rejected. Claw stopped without running the pending step.'
    : 'Run was cancelled.';

  const adapter = resolveAdapter(run.source);
  const unsubscribe = adapter ? attachToRun(run, adapter, input.deps) : () => {};
  try {
    if (rejected) {
      await runs.appendEvent(run, {
        eventType: 'approval_decision',
        content: 'rejected',
        metadata: input.actorId ? { actorId: input.actorId } : undefined,
      });
    } else {
      await runs.appendEvent(run, { eventType: 'status', content: 'cancelled' });
    }
    await runs.markCancelled(run.runId, reason);
    bus.emit({ name: 'run:cancelled', runId: run.runId, reason });
    logger.info({ runId: run.runId, tenantId: run.tenantId, kind: input.kind }, 'Run terminated');
  } finally {
    await bus.drain(run.runId).catch(() => {});
    unsubscribe();
    bus.cleanup(run.runId);
  }
}
