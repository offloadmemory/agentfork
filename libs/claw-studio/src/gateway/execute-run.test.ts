/**
 * executeRun's job is to classify how the graph stopped — completed, paused at an
 * approval gate, waiting on an answer, cancelled, or failed — and to record and
 * announce that correctly. Those five branches are what these tests pin down.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';

const { runs, graph, resolveClawRuntime, cleanup, attachToRun, unsubscribe, registry } = vi.hoisted(
  () => {
    const graph = {
      stream: vi.fn(),
      getState: vi.fn(),
      updateState: vi.fn(async () => {}),
    };
    // The adapter itself is never called here — the notification router is
    // mocked — but it has to be a real object, or resolveAdapter treats the
    // channel as unregistered and never attaches.
    const adapterStub = {
      channelType: 'slack',
      deliveryMode: 'callback',
      hilCapabilities: { clarification: true, approvalButtons: true, threadedReplies: true },
    };
    return {
      graph,
      cleanup: vi.fn(async () => {}),
      unsubscribe: vi.fn(),
      attachToRun: vi.fn(),
      resolveClawRuntime: vi.fn(),
      registry: { has: vi.fn(() => true), get: vi.fn(() => adapterStub) },
      runs: {
        get: vi.fn(),
        getStatus: vi.fn(async () => 'in_progress'),
        appendEvent: vi.fn(async () => ({ id: 'e1', eventType: 'node_complete' })),
        markInProgress: vi.fn(async () => {}),
        markCompleted: vi.fn(async () => {}),
        markFailed: vi.fn(async () => {}),
        markCancelled: vi.fn(async () => {}),
        markAwaitingInput: vi.fn(async () => {}),
        markAwaitingApproval: vi.fn(async () => {}),
      },
    };
  },
);

vi.mock('@chatbot/shared', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

vi.mock('../agent/claw-runtime', () => ({
  resolveClawRuntime,
  BACKGROUND_MAX_ITERATIONS: 30,
}));

vi.mock('../agent/run-manager', () => ({
  registerRun: vi.fn(() => new AbortController()),
  cleanupRun: vi.fn(),
}));

vi.mock('../connectors/registry', () => ({ getConnectorRegistry: () => registry }));
vi.mock('./run-service', () => ({ getRunService: () => runs }));
vi.mock('./notification-router', () => ({ attachToRun, runUrl: () => 'https://mc/runs/x' }));

import { executeRun, terminateRun, deriveNodeEvents, approvalRequestFrom } from './execute-run';
import { getRunEventBus } from './event-bus';

const deps = { dashboardBaseUrl: 'https://mc.example.com' };
const baseRun = {
  id: 'id1',
  tenantId: 'tenant1',
  runId: 'run_abc',
  source: 'slack',
  status: 'queued',
  taskDescription: 'summarise the incident',
  threadId: 'claw_run_run_abc',
  trigger: {},
  result: null,
  clarification: null,
  approvalRequest: null,
  error: null,
  userId: 'U1',
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
};

/** Minimal async-iterable stand-in for graph.stream(). */
function streamOf(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

let emitted: Array<{ name: string; [key: string]: unknown }>;

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  const bus = getRunEventBus();
  bus.cleanup(baseRun.runId);
  bus.subscribe(baseRun.runId, (event) => {
    emitted.push(event as never);
  });

  runs.get.mockResolvedValue({ ...baseRun });
  runs.getStatus.mockResolvedValue('in_progress');
  runs.appendEvent.mockResolvedValue({ id: 'e1', eventType: 'node_complete' } as never);
  attachToRun.mockReturnValue(unsubscribe);
  resolveClawRuntime.mockResolvedValue({
    graph,
    threadId: baseRun.threadId,
    clawId: 'claw1',
    autoApprove: false,
    config: { configurable: { thread_id: baseRun.threadId, tenant_id: 'tenant1', user_id: 'claw1' } },
    cleanup,
    mcpCleanup: cleanup,
  });
  graph.stream.mockResolvedValue(streamOf([]));
  graph.getState.mockResolvedValue({ next: [], values: {} });
});

const names = () => emitted.map((e) => e.name);

describe('executeRun', () => {
  it('does nothing for a run that no longer exists', async () => {
    runs.get.mockResolvedValue(null);
    await executeRun({ runId: 'run_missing', deps });
    expect(resolveClawRuntime).not.toHaveBeenCalled();
  });

  it('skips a run that already reached a terminal state — pg-boss can redeliver', async () => {
    runs.get.mockResolvedValue({ ...baseRun, status: 'completed' });
    await executeRun({ runId: baseRun.runId, deps });
    expect(resolveClawRuntime).not.toHaveBeenCalled();
    expect(runs.markInProgress).not.toHaveBeenCalled();
  });

  it('subscribes the router before the graph runs, so no early event is missed', async () => {
    const order: string[] = [];
    attachToRun.mockImplementation(() => {
      order.push('attach');
      return unsubscribe;
    });
    resolveClawRuntime.mockImplementation(async () => {
      order.push('resolve');
      return {
        graph,
        threadId: baseRun.threadId,
        config: { configurable: {} },
        cleanup,
        mcpCleanup: cleanup,
        clawId: 'c',
        autoApprove: false,
      };
    });

    await executeRun({ runId: baseRun.runId, deps });
    expect(order).toEqual(['attach', 'resolve']);
  });

  it('runs the graph on the run\'s own thread with the background iteration budget', async () => {
    await executeRun({ runId: baseRun.runId, deps });
    // Exact shape on purpose: a channel run must not acquire a promptSurface,
    // approvalPolicy, or provider override just because scheduled runs can.
    expect(resolveClawRuntime).toHaveBeenCalledWith({
      tenantId: 'tenant1',
      threadId: 'claw_run_run_abc',
      maxIterations: 30,
      sourceRunId: 'run_abc',
    });
  });

  it('forwards runtimeOverrides to the runtime for a scheduled run', async () => {
    await executeRun({
      runId: baseRun.runId,
      deps,
      runtimeOverrides: {
        approvalPolicy: { mode: 'allowlist', allowedTools: ['gmail_send_message'] },
        maxIterations: 12,
        promptSurface: 'scheduled',
        providerModelId: 'prov-1',
      },
    });
    expect(resolveClawRuntime).toHaveBeenCalledWith({
      tenantId: 'tenant1',
      threadId: 'claw_run_run_abc',
      maxIterations: 12,
      sourceRunId: 'run_abc',
      promptSurface: 'scheduled',
      approvalPolicy: { mode: 'allowlist', allowedTools: ['gmail_send_message'] },
      overrides: { providerModelId: 'prov-1' },
    });
  });

  it('completes with the last AI message as the answer', async () => {
    graph.getState.mockResolvedValue({
      next: [],
      values: {
        messages: [new AIMessage({ content: 'internal step' }), new AIMessage({ content: 'All done.' })],
        iterationCount: 3,
        toolResults: [{ toolName: 'read_file' }, { toolName: 'read_file' }],
      },
    });

    await executeRun({ runId: baseRun.runId, deps });

    expect(runs.markCompleted).toHaveBeenCalledWith('run_abc', {
      answer: 'All done.',
      iterations: 3,
      toolsUsed: ['read_file'],
    });
    expect(names()).toContain('run:completed');
  });

  it('records a tool-approval pause when the agent stops at an interruptOn gate', async () => {
    // Real shape per humanInTheLoopMiddleware (hitl.js:469-472): the interrupt
    // sits on the paused task, not on state.next — deepagents has no plan-gate
    // node equivalent to the old graph's approval_gate, so tool approval is the
    // only pause interruptOn produces.
    graph.getState.mockResolvedValue({
      next: ['agent'],
      values: {},
      tasks: [
        {
          id: 't1',
          name: 'agent',
          interrupts: [{ id: 'i1', value: { actionRequests: [{ name: 'delete_file', args: {} }], reviewConfigs: [] } }],
        },
      ],
    });

    await executeRun({ runId: baseRun.runId, deps });

    expect(runs.markAwaitingApproval).toHaveBeenCalledWith('run_abc', {
      kind: 'tool',
      pendingTools: ['delete_file'],
    });
    expect(names()).toContain('hil:tool_approval');
    expect(runs.markCompleted).not.toHaveBeenCalled();
  });

  // The turn is paused, not over: the tool awaiting approval may be a browser
  // interaction that will resume against the page loaded right now. Closing the
  // browser here is what made an approved click land on a fresh about:blank.
  it('parks the browser instead of closing it when it pauses for approval', async () => {
    graph.getState.mockResolvedValue({
      next: ['agent'],
      values: {},
      tasks: [
        {
          id: 't1',
          name: 'agent',
          interrupts: [{ id: 'i1', value: { actionRequests: [{ name: 'browser_click', args: {} }], reviewConfigs: [] } }],
        },
      ],
    });

    await executeRun({ runId: baseRun.runId, deps });

    expect(cleanup).toHaveBeenCalledWith({ keepBrowser: true });
  });

  it('closes the browser when the run actually finishes', async () => {
    await executeRun({ runId: baseRun.runId, deps });

    expect(cleanup).toHaveBeenCalledWith({ keepBrowser: false });
  });

  it('never returns an empty tool list when multiple tool calls are bundled into one interrupt', async () => {
    graph.getState.mockResolvedValue({
      next: ['agent'],
      values: {},
      tasks: [
        {
          id: 't1',
          name: 'agent',
          interrupts: [
            {
              value: {
                actionRequests: [
                  { name: 'gmail_send_message', args: {} },
                  { name: 'jira_create_issue', args: { id: 1 } },
                ],
                reviewConfigs: [],
              },
            },
          ],
        },
      ],
    });

    await executeRun({ runId: baseRun.runId, deps });

    expect(runs.markAwaitingApproval).toHaveBeenCalledWith('run_abc', {
      kind: 'tool',
      pendingTools: ['gmail_send_message', 'jira_create_issue'],
    });
  });

  it('records a clarification when the graph ended by asking a question', async () => {
    graph.getState.mockResolvedValue({
      next: [],
      values: { nextAction: 'awaiting_input', clarificationQuestion: 'Which environment?' },
    });

    await executeRun({ runId: baseRun.runId, deps });

    expect(runs.markAwaitingInput).toHaveBeenCalledWith('run_abc', 'Which environment?');
    expect(names()).toContain('hil:clarification');
    expect(runs.markCompleted).not.toHaveBeenCalled();
  });

  it('resumes via Command({ resume: { decisions } }) instead of updateState on approve', async () => {
    runs.get.mockResolvedValue({
      ...baseRun,
      status: 'awaiting_approval',
      approvalRequest: { kind: 'tool', pendingTools: ['delete_file'] },
    });

    await executeRun({ runId: baseRun.runId, resume: { action: 'approve' }, deps });

    expect(graph.updateState).not.toHaveBeenCalled();
    const [input] = graph.stream.mock.calls[0] as [Command];
    expect(input).toBeInstanceOf(Command);
    expect((input as InstanceType<typeof Command>).resume).toEqual({ decisions: [{ type: 'approve' }] });
  });

  it('keeps the approval content stable and attributes the decision in metadata', async () => {
    runs.get.mockResolvedValue({ ...baseRun, status: 'awaiting_approval' });
    await executeRun({ runId: baseRun.runId, resume: { action: 'approve', actorId: 'U1' }, deps });
    expect(runs.appendEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'approval_decision', content: 'approved', metadata: { actorId: 'U1' },
      }),
    );
  });

  it('supplies one approve decision per pending tool when the interrupt bundled several', async () => {
    runs.get.mockResolvedValue({
      ...baseRun,
      status: 'awaiting_approval',
      approvalRequest: { kind: 'tool', pendingTools: ['gmail_send_message', 'jira_create_issue'] },
    });

    await executeRun({ runId: baseRun.runId, resume: { action: 'approve' }, deps });

    const [input] = graph.stream.mock.calls[0] as [Command];
    expect((input as InstanceType<typeof Command>).resume).toEqual({
      decisions: [{ type: 'approve' }, { type: 'approve' }],
    });
  });

  it('feeds a clarification reply back in as a new human turn', async () => {
    runs.get.mockResolvedValue({ ...baseRun, status: 'awaiting_input' });

    await executeRun({
      runId: baseRun.runId,
      resume: { action: 'clarification_response', content: 'staging' },
      deps,
    });

    expect(graph.updateState).not.toHaveBeenCalled();
    const input = graph.stream.mock.calls[0][0] as { messages: Array<{ content: unknown }> };
    expect(input.messages[0].content).toBe('staging');
  });

  it('aborts and reports cancellation when the status flips out of process mid-run', async () => {
    graph.stream.mockResolvedValue(streamOf([{ generate: {} }, { reflect: {} }]));
    runs.getStatus.mockResolvedValue('cancelled');

    await executeRun({ runId: baseRun.runId, deps });

    expect(names()).toContain('run:cancelled');
    expect(runs.markCompleted).not.toHaveBeenCalled();
  });

  it('records a failure, announces it, and rethrows so the queue sees it too', async () => {
    graph.stream.mockRejectedValue(new Error('model exploded'));

    await expect(executeRun({ runId: baseRun.runId, deps })).rejects.toThrow('model exploded');

    expect(runs.markFailed).toHaveBeenCalledWith('run_abc', 'model exploded');
    expect(names()).toContain('run:failed');
  });

  it('always unsubscribes and runs the composed teardown, even when the run throws', async () => {
    graph.stream.mockRejectedValue(new Error('boom'));
    await expect(executeRun({ runId: baseRun.runId, deps })).rejects.toThrow();
    expect(unsubscribe).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  it('writes a tool_call event for each tool the model requested', async () => {
    graph.stream.mockResolvedValue(
      streamOf([
        {
          generate: {
            messages: [{ _getType: () => 'ai', content: '', tool_calls: [{ name: 'read_file', args: { p: 1 } }] }],
          },
        },
      ]),
    );

    await executeRun({ runId: baseRun.runId, deps });

    expect(runs.appendEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'tool_call', toolName: 'read_file' }),
    );
  });

  // `memory_recall`/`memory_save` were graph node names from the retired
  // `claw-graph.ts` StateGraph — resolveClawRuntime no longer builds that graph,
  // so a chunk keyed by those names can no longer occur. The equivalent
  // "don't spam the timeline" guarantee under the agent loop is that a
  // contentless chunk emitted alongside tool traffic doesn't also get a bare
  // node_complete — covered below.
  it('does not emit a bare node_complete for a contentless chunk alongside a tool call', async () => {
    graph.stream.mockResolvedValue(
      streamOf([
        {
          agent: {
            messages: [{ _getType: () => 'ai', content: '', tool_calls: [{ name: 'read_file', args: { p: 1 } }] }],
          },
        },
      ]),
    );

    await executeRun({ runId: baseRun.runId, deps });

    const nodeEvents = runs.appendEvent.mock.calls.filter(
      (call) => (call[1] as { eventType: string }).eventType === 'node_complete',
    );
    expect(nodeEvents).toHaveLength(0);
  });
});

describe('terminateRun', () => {
  it('ends a rejected run without ever touching the graph — resuming would loop back to the gate', async () => {
    runs.get.mockResolvedValue({ ...baseRun, status: 'awaiting_approval' });

    await terminateRun({ runId: baseRun.runId, deps, kind: 'reject' });

    expect(resolveClawRuntime).not.toHaveBeenCalled();
    expect(graph.stream).not.toHaveBeenCalled();
    expect(runs.markCancelled).toHaveBeenCalledWith('run_abc', expect.stringContaining('Rejected'));
    expect(names()).toContain('run:cancelled');
  });

  it('records a rejection decision on the timeline', async () => {
    runs.get.mockResolvedValue({ ...baseRun, status: 'awaiting_approval' });

    await terminateRun({ runId: baseRun.runId, deps, kind: 'reject' });

    expect(runs.appendEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'approval_decision', content: 'rejected' }),
    );
  });

  it('keeps rejection content stable with a structured actor ID', async () => {
    runs.get.mockResolvedValue({ ...baseRun, status: 'awaiting_approval' });
    await terminateRun({ runId: baseRun.runId, deps, kind: 'reject', actorId: 'U1' });
    expect(runs.appendEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'approval_decision', content: 'rejected', metadata: { actorId: 'U1' },
      }),
    );
  });

  it('uses cancellation wording for a cancel', async () => {
    runs.get.mockResolvedValue({ ...baseRun, status: 'awaiting_approval' });

    await terminateRun({ runId: baseRun.runId, deps, kind: 'cancel' });

    expect(runs.markCancelled).toHaveBeenCalledWith('run_abc', 'Run was cancelled.');
  });

  it('ignores a run that already finished', async () => {
    runs.get.mockResolvedValue({ ...baseRun, status: 'completed' });

    await terminateRun({ runId: baseRun.runId, deps, kind: 'reject' });

    expect(runs.markCancelled).not.toHaveBeenCalled();
  });
});

describe('deriveNodeEvents — memory activity', () => {
  // Recall and save run as middleware HOOKS, not tool calls, so they produce no
  // ToolMessage and nothing else in this function can see them. They were doing
  // real work (embedding + 3 pgvector queries + an LLM relevance filter on
  // recall; extraction + reconcile on save) that never reached the timeline, so
  // memory looked to a user like it was switched off. The pair below is what
  // makes it visible — `agent-steps.tsx` drops a tool_result that matches no
  // running tool_call, so a lone result would render nothing at all.
  it('emits a call/result pair for a recall that found memories', () => {
    const drafts = deriveNodeEvents('clawMemory', {
      memoryStats: {
        phase: 'recall',
        facts: [{ key: 'jira-site' }, { key: 'tz' }],
        rules: [{ key: 'check-calendar-first' }],
        episodes: [],
        injected: true,
      },
    });
    expect(drafts).toContainEqual(
      expect.objectContaining({ eventType: 'tool_call', toolName: 'memory_recall' }),
    );
    const result = drafts.find((d) => d.eventType === 'tool_result');
    expect(result?.toolName).toBe('memory_recall');
    expect(result?.toolOutput).toContain('2 facts');
    expect(result?.toolOutput).toContain('1 rule');
  });

  it('still emits a pair when recall found nothing — "searched, found nothing" is activity too', () => {
    const drafts = deriveNodeEvents('clawMemory', {
      memoryStats: { phase: 'recall', facts: [], rules: [], episodes: [], injected: false },
    });
    expect(drafts.filter((d) => d.eventType === 'tool_call')).toHaveLength(1);
    expect(drafts.find((d) => d.eventType === 'tool_result')?.toolOutput).toMatch(/no relevant/i);
  });

  it('emits a call/result pair for a save, including what reconcile decided', () => {
    const drafts = deriveNodeEvents('clawMemory', {
      memoryStats: {
        phase: 'save',
        savedFacts: 2,
        savedRules: 1,
        episodeCaptured: true,
        reconcileActions: { added: 2, updated: 1, superseded: 0, reinforced: 0, noop: 0, failed: 0 },
      },
    });
    expect(drafts).toContainEqual(
      expect.objectContaining({ eventType: 'tool_call', toolName: 'memory_save' }),
    );
    const result = drafts.find((d) => d.eventType === 'tool_result');
    expect(result?.toolOutput).toContain('2 facts');
    expect(result?.toolOutput).toContain('episode captured');
    expect(result?.toolOutput).toContain('updated 1');
  });

  it('names the pair distinctly from the save_memory/search_memory TOOLS, which the model can also call', () => {
    // buildSteps matches a result to a running call BY TOOL NAME. Reusing the
    // real tool names here would let a middleware result close out the model's
    // own in-flight search_memory call, and vice versa.
    const drafts = deriveNodeEvents('clawMemory', {
      memoryStats: { phase: 'recall', facts: [], rules: [], episodes: [], injected: false },
    });
    const names = drafts.map((d) => d.toolName);
    expect(names).not.toContain('search_memory');
    expect(names).not.toContain('save_memory');
  });

  it('emits nothing when the chunk carries no memoryStats', () => {
    expect(deriveNodeEvents('agent', { messages: [] })).toHaveLength(0);
  });
});

describe('deriveNodeEvents under deepagents', () => {
  it('emits a tool_call for each tool the model requested', () => {
    const drafts = deriveNodeEvents('agent', {
      messages: [{ _getType: () => 'ai', content: '', tool_calls: [{ name: 'jira_create_issue', args: { id: 1 } }] }],
    });
    expect(drafts).toContainEqual({ eventType: 'tool_call', toolName: 'jira_create_issue', toolArgs: { id: 1 } });
  });

  it('emits a tool_result with the output', () => {
    const drafts = deriveNodeEvents('agent', {
      toolResults: [{ toolName: 'jira_create_issue', output: 'DEV-1', isError: false }],
    });
    expect(drafts).toContainEqual({
      eventType: 'tool_result', toolName: 'jira_create_issue', toolOutput: 'DEV-1', metadata: undefined,
    });
  });

  it('emits assistant text as node_complete', () => {
    const drafts = deriveNodeEvents('agent', {
      messages: [{ _getType: () => 'ai', content: 'All done.' }],
    });
    expect(drafts.some((d) => d.eventType === 'node_complete' && d.content === 'All done.')).toBe(true);
  });

  it('stays silent for the write_todos plan tool but still records the call', () => {
    const drafts = deriveNodeEvents('agent', {
      messages: [{ _getType: () => 'ai', content: '', tool_calls: [{ name: 'write_todos', args: { todos: ['a'] } }] }],
    });
    expect(drafts.some((d) => d.eventType === 'tool_call' && d.toolName === 'write_todos')).toBe(true);
  });

  // Fix round 1, Important 1: the write_todos chunk sets `update.plan` on the
  // same chunk that carries the tool traffic and no AI text — exactly the shape
  // the noise guard must NOT swallow, or the plan payload is unreachable.
  it('still emits a node_complete carrying metadata.plan when the same chunk has tool traffic and no AI text', () => {
    const drafts = deriveNodeEvents('agent', {
      messages: [{ _getType: () => 'ai', content: '', tool_calls: [{ name: 'write_todos', args: { todos: ['a'] } }] }],
      plan: [{ step: 'a', status: 'pending' }],
    });
    expect(drafts).toContainEqual({
      eventType: 'node_complete',
      content: undefined,
      metadata: { plan: [{ step: 'a', status: 'pending' }] },
    });
  });

  // The two tests above feed `toolResults` and `plan` — channels the OLD graph
  // wrote and nothing writes any more (clawMemoryStateSchema still declares
  // them, but grep finds no writer under deepagents). They pass while the real
  // path produces nothing, which is why the chat timeline showed tool calls
  // that never completed. These two cover the shapes actually on the wire.
  it('derives a tool_result from a ToolMessage, which is where deepagents puts it', () => {
    const drafts = deriveNodeEvents('tools', {
      messages: [{ _getType: () => 'tool', name: 'jira_create_issue', content: 'DEV-1' }],
    });
    expect(drafts).toContainEqual(
      expect.objectContaining({ eventType: 'tool_result', toolName: 'jira_create_issue', toolOutput: 'DEV-1' }),
    );
  });

  it('marks a failed ToolMessage as an error', () => {
    const drafts = deriveNodeEvents('tools', {
      messages: [{ _getType: () => 'tool', name: 'gmail_send', content: 'boom', status: 'error' }],
    });
    expect(drafts).toContainEqual(
      expect.objectContaining({ eventType: 'tool_result', metadata: { isError: true } }),
    );
  });

  it('derives the plan from the todos channel written by todoListMiddleware', () => {
    const drafts = deriveNodeEvents('agent', {
      todos: [{ content: 'Read the file', status: 'pending' }],
    });
    expect(drafts).toContainEqual(
      expect.objectContaining({
        eventType: 'node_complete',
        metadata: { plan: [{ step: 'Read the file', status: 'pending' }] },
      }),
    );
  });

  // Fix round 1, Important 2: restores the old blanket invariant — a wholly
  // contentless, actionless update (no text, no tool traffic, no plan) never
  // becomes a timeline entry.
  it('emits nothing at all for a wholly empty, contentless update', () => {
    const drafts = deriveNodeEvents('agent', {});
    expect(drafts).toHaveLength(0);
  });
});

describe('approvalRequestFrom under interruptOn', () => {
  // Real shape confirmed against humanInTheLoopMiddleware
  // (node_modules/langchain/dist/agents/middleware/hitl.js:469-472,
  // hitl.d.ts's ActionRequest/HITLRequest, and langgraph's
  // Interrupt<Value> = { id?; value? }): camelCase `actionRequests`, each
  // entry keyed by `name` — NOT the plan's guessed `action_requests`/`action`.
  it('names the tools from the interrupt payload', () => {
    const request = approvalRequestFrom(
      [{ value: { actionRequests: [{ name: 'jira_create_issue', args: { id: 1 } }] } }],
      {},
    );
    expect(request).toEqual({ kind: 'tool', pendingTools: ['jira_create_issue'] });
  });

  it('never returns an empty tool list when an interrupt is present', () => {
    // The bug in libs/claw-studio/CLAUDE.md: interruptBefore paused before the
    // gate ran, so pendingToolApprovals was empty and the prompt named nothing.
    // interruptOn's payload carries the tool name at the pause itself, so this
    // must never regress to an empty list even when other state is empty.
    const request = approvalRequestFrom(
      [{ value: { actionRequests: [{ name: 'gmail_send_message' }] } }],
      { pendingToolApprovals: [] },
    );
    expect(request.pendingTools).toEqual(['gmail_send_message']);
  });

  it('names every tool when several action requests are bundled into one interrupt', () => {
    const request = approvalRequestFrom(
      [{ value: { actionRequests: [{ name: 'gmail_send_message' }, { name: 'jira_create_issue' }] } }],
      {},
    );
    expect(request.pendingTools).toEqual(['gmail_send_message', 'jira_create_issue']);
  });

  it('falls back to a plan-kind request when no interrupt is present', () => {
    const request = approvalRequestFrom([], { plan: [{ step: 'delete stale records', status: 'pending' }] });
    expect(request).toEqual({ kind: 'plan', planSteps: ['delete stale records'] });
  });
});

describe('deriveNodeEvents — failed tool calls', () => {
  // Integration tools deliberately never throw: a thrown LangChain tool error
  // aborts the whole run, so all 111 catch paths across src/integrations return a
  // recoverable `Error <verb>ing …:` string instead. That leaves the ToolMessage
  // `status: 'success'`, which is what the timeline was reading — so a Google
  // Calendar call that failed with OAuthReauthRequiredError rendered a green tick
  // and the real failure was invisible until someone read the server log.
  const toolMessage = (name: string, content: string) => ({
    _getType: () => 'tool' as const,
    name,
    content,
    status: 'success' as const,
  });

  it('flags a tool whose recovered output reports an error', () => {
    const drafts = deriveNodeEvents('agent', {
      messages: [toolMessage('google_calendar_list_events', 'Error listing calendar events: OAuthReauthRequiredError')],
    } as never);
    const result = drafts.find((d) => d.eventType === 'tool_result');
    expect(result?.metadata).toEqual({ isError: true });
  });

  it('leaves a successful tool result unflagged', () => {
    const drafts = deriveNodeEvents('agent', {
      messages: [toolMessage('google_calendar_list_events', '[{"id":"evt_1","summary":"Standup"}]')],
    } as never);
    const result = drafts.find((d) => d.eventType === 'tool_result');
    expect(result?.metadata).toBeUndefined();
  });

  it('still honours an explicit error status when a tool does throw', () => {
    const drafts = deriveNodeEvents('agent', {
      messages: [{ ...toolMessage('browser_click', 'boom'), status: 'error' as const }],
    } as never);
    const result = drafts.find((d) => d.eventType === 'tool_result');
    expect(result?.metadata).toEqual({ isError: true });
  });

  it('does not mistake prose that merely mentions an error for a failure', () => {
    const drafts = deriveNodeEvents('agent', {
      messages: [toolMessage('email_search_messages', 'Found 2 messages about the Error Budget review')],
    } as never);
    const result = drafts.find((d) => d.eventType === 'tool_result');
    expect(result?.metadata).toBeUndefined();
  });
});

describe('deriveNodeEvents — duplicate suppression', () => {
  // deepagents reports several nodes per graph chunk (the agent plus each
  // middleware), and they all carry the same trailing AI message on the shared
  // `messages` channel. Both call sites loop `Object.entries(updates)` and call
  // this once per node, so one answer was rendered two to four times in the chat
  // timeline — visible as "Today is August 18, 2026." repeated four times under a
  // single turn. Dedupe on the message's own id: two genuinely distinct messages
  // (including a model that really did repeat itself) carry different ids.
  const aiMessage = (id: string | undefined, text: string) => ({
    _getType: () => 'ai' as const,
    id,
    content: text,
  });

  it('emits an answer once even when several nodes report it in the same chunk', () => {
    const seen = new Set<string>();
    const msg = aiMessage('run-abc-1', 'Today is August 18, 2026.');

    const fromAgent = deriveNodeEvents('agent', { messages: [msg] } as never, seen);
    const fromMiddleware = deriveNodeEvents('clawMemory', { messages: [msg] } as never, seen);

    expect(fromAgent.filter((d) => d.content).length).toBe(1);
    expect(fromMiddleware.filter((d) => d.content).length).toBe(0);
  });

  it('still emits two genuinely different answers', () => {
    const seen = new Set<string>();
    const first = deriveNodeEvents('agent', { messages: [aiMessage('m1', 'First.')] } as never, seen);
    const second = deriveNodeEvents('agent', { messages: [aiMessage('m2', 'Second.')] } as never, seen);
    expect(first.filter((d) => d.content).length).toBe(1);
    expect(second.filter((d) => d.content).length).toBe(1);
  });

  it('does not suppress a message that carries no id, since ids are what make dedupe safe', () => {
    const seen = new Set<string>();
    const a = deriveNodeEvents('agent', { messages: [aiMessage(undefined, 'Untracked.')] } as never, seen);
    const b = deriveNodeEvents('agent', { messages: [aiMessage(undefined, 'Untracked.')] } as never, seen);
    expect(a.filter((d) => d.content).length).toBe(1);
    expect(b.filter((d) => d.content).length).toBe(1);
  });

  it('suppresses a repeated tool result by id, but keeps two real calls to the same tool', () => {
    const seen = new Set<string>();
    const toolMsg = (id: string) => ({ _getType: () => 'tool' as const, id, name: 'get_current_time', content: 'ok', status: 'success' as const });

    const once = deriveNodeEvents('agent', { messages: [toolMsg('t1')] } as never, seen);
    const echoed = deriveNodeEvents('clawMemory', { messages: [toolMsg('t1')] } as never, seen);
    const genuinelySecondCall = deriveNodeEvents('agent', { messages: [toolMsg('t2')] } as never, seen);

    expect(once.filter((d) => d.eventType === 'tool_result').length).toBe(1);
    expect(echoed.filter((d) => d.eventType === 'tool_result').length).toBe(0);
    expect(genuinelySecondCall.filter((d) => d.eventType === 'tool_result').length).toBe(1);
  });

  it('behaves exactly as before when no seen-set is passed', () => {
    const msg = aiMessage('m1', 'Same message twice.');
    expect(deriveNodeEvents('agent', { messages: [msg] } as never).filter((d) => d.content).length).toBe(1);
    expect(deriveNodeEvents('agent', { messages: [msg] } as never).filter((d) => d.content).length).toBe(1);
  });
});
