import { describe, it, expect } from 'vitest';
import {
  NodeTraceCollector,
  sanitizeExecutionEvent,
  sanitizeTraceEntry,
  truncateValue,
  MAX_FIELD_CHARS,
  type NodeTraceLike,
} from './node-trace';

const CPF = '529.982.247-25';

function entry(overrides: Partial<NodeTraceLike> = {}): NodeTraceLike {
  return {
    nodeId: 'n1',
    nodeType: 'tool',
    status: 'completed',
    startedAt: '2026-10-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('truncateValue', () => {
  it('keeps small values and cuts long strings', () => {
    expect(truncateValue('abc', 10)).toBe('abc');
    expect(truncateValue('a'.repeat(20), 10)).toBe(`${'a'.repeat(10)}[TRUNCADO]`);
  });

  it('replaces large objects by a marker with preview', () => {
    const out = truncateValue({ big: 'x'.repeat(100) }, 50) as { truncated: boolean; originalLength: number; preview: string };
    expect(out.truncated).toBe(true);
    expect(out.originalLength).toBeGreaterThan(50);
    expect(out.preview.endsWith('[TRUNCADO]')).toBe(true);
  });

  it('passes through primitives', () => {
    expect(truncateValue(5)).toBe(5);
    expect(truncateValue(null)).toBeNull();
  });
});

describe('sanitizeTraceEntry', () => {
  it('redacts input, output and error', () => {
    const out = sanitizeTraceEntry(
      entry({
        input: { toolName: 'lookup', parameters: { cpf: CPF } },
        output: { result: `email ana@exemplo.com` },
        error: `falhou para ${CPF}`,
      }),
    );
    expect(JSON.stringify(out)).not.toContain('529.982');
    expect(JSON.stringify(out)).not.toContain('ana@exemplo.com');
    expect(out.input).toEqual({ toolName: 'lookup', parameters: { cpf: '[CPF]' } });
    expect(out.error).toBe('falhou para [CPF]');
  });

  it('redacts before truncating so a cut never leaves part of an identifier', () => {
    const padding = 'x'.repeat(MAX_FIELD_CHARS - 5);
    const out = sanitizeTraceEntry(entry({ output: { body: `${padding}${CPF}` } }));
    const body = (out.output as { body: string }).body;
    expect(body).not.toMatch(/\d{3}\.\d{3}/);
  });

  it('does not mutate the original entry', () => {
    const original = entry({ input: { v: CPF } });
    sanitizeTraceEntry(original);
    expect(original.input).toEqual({ v: CPF });
  });
});

describe('NodeTraceCollector', () => {
  it('collects completed nodes redacted', () => {
    const c = new NodeTraceCollector();
    c.handleEvent({ type: 'node_start', nodeId: 'n1', nodeType: 'tool' });
    c.handleEvent({ type: 'node_complete', nodeId: 'n1', trace: entry({ input: { v: CPF } }) });
    const { trace } = c.snapshot();
    expect(trace).toHaveLength(1);
    expect(trace[0]?.input).toEqual({ v: '[CPF]' });
  });

  it('reconstructs a failed node from node_start + node_error', () => {
    const c = new NodeTraceCollector();
    c.handleEvent({ type: 'node_start', nodeId: 'n2', nodeType: 'http' });
    c.handleEvent({ type: 'node_error', nodeId: 'n2', error: `bad request for ${CPF}` });
    const { trace } = c.snapshot();
    expect(trace[0]).toMatchObject({ nodeId: 'n2', nodeType: 'http', status: 'failed', error: 'bad request for [CPF]' });
    expect(typeof trace[0]?.durationMs).toBe('number');
  });

  it('records node_error without a prior node_start as unknown type', () => {
    const c = new NodeTraceCollector();
    c.handleEvent({ type: 'node_error', nodeId: 'n9', error: 'no executor' });
    expect(c.snapshot().trace[0]).toMatchObject({ nodeId: 'n9', nodeType: 'unknown', status: 'failed' });
  });

  it('records the pausing node', () => {
    const c = new NodeTraceCollector();
    c.handleEvent({ type: 'node_start', nodeId: 'h1', nodeType: 'human' });
    c.recordPause();
    expect(c.snapshot().trace[0]).toMatchObject({ nodeId: 'h1', nodeType: 'human', status: 'paused' });
  });

  it('recordPause without a current node is a no-op', () => {
    const c = new NodeTraceCollector();
    c.recordPause();
    expect(c.snapshot().trace).toHaveLength(0);
  });

  it('caps the number of entries and reports dropped ones', () => {
    const c = new NodeTraceCollector([], 0, 2);
    for (let i = 0; i < 5; i++) {
      c.handleEvent({ type: 'node_complete', nodeId: `n${i}`, trace: entry({ nodeId: `n${i}` }) });
    }
    expect(c.snapshot()).toMatchObject({ traceDropped: 3 });
    expect(c.snapshot().trace).toHaveLength(2);
  });

  it('ignores unrelated events', () => {
    const c = new NodeTraceCollector();
    c.handleEvent({ type: 'text_delta', nodeId: 'n1', delta: 'oi' });
    expect(c.snapshot().trace).toHaveLength(0);
  });

  it('continues from a previously persisted output (resume)', () => {
    const first = new NodeTraceCollector();
    first.handleEvent({ type: 'node_complete', nodeId: 'a', trace: entry({ nodeId: 'a' }) });
    const persisted = JSON.parse(JSON.stringify({ text: 'x', ...first.snapshot() }));

    const resumed = NodeTraceCollector.fromOutput(persisted);
    resumed.handleEvent({ type: 'node_complete', nodeId: 'b', trace: entry({ nodeId: 'b' }) });
    expect(resumed.snapshot().trace.map((t) => t.nodeId)).toEqual(['a', 'b']);
  });

  it('fromOutput tolerates null and malformed values', () => {
    expect(NodeTraceCollector.fromOutput(null).snapshot().trace).toEqual([]);
    expect(NodeTraceCollector.fromOutput({ trace: 'nope' }).snapshot().trace).toEqual([]);
    expect(NodeTraceCollector.fromOutput({ error: 'x' }).snapshot().trace).toEqual([]);
  });
});

describe('sanitizeExecutionEvent', () => {
  it('redacts node_complete, node_error and state_update', () => {
    const complete = sanitizeExecutionEvent({
      type: 'node_complete',
      nodeId: 'n1',
      trace: entry({ output: { r: CPF } }),
    }) as { trace: NodeTraceLike };
    expect(complete.trace.output).toEqual({ r: '[CPF]' });

    const err = sanitizeExecutionEvent({ type: 'node_error', nodeId: 'n1', error: CPF }) as { error: string };
    expect(err.error).toBe('[CPF]');

    const state = sanitizeExecutionEvent({ type: 'state_update', channels: { who: CPF } }) as {
      channels: Record<string, unknown>;
    };
    expect(state.channels).toEqual({ who: '[CPF]' });
  });

  it('redacts execution_complete trace and final state, keeping other fields', () => {
    const out = sanitizeExecutionEvent({
      type: 'execution_complete',
      trace: [entry({ input: { v: CPF } })],
      finalState: {
        channels: { who: CPF },
        messages: [{ role: 'user', content: CPF }],
        currentNodeId: null,
        metadata: { executionId: 'e1' },
      },
    }) as { trace: NodeTraceLike[]; finalState: { channels: unknown; messages: unknown; currentNodeId: unknown; metadata: unknown } };
    expect(JSON.stringify(out)).not.toContain('529.982');
    expect(out.finalState.currentNodeId).toBeNull();
    expect(out.finalState.metadata).toEqual({ executionId: 'e1' });
  });

  it('leaves text_delta and other events unchanged', () => {
    const delta = { type: 'text_delta', nodeId: 'n1', delta: `seu CPF ${CPF}` };
    expect(sanitizeExecutionEvent(delta)).toBe(delta);
    const start = { type: 'node_start', nodeId: 'n1', nodeType: 'llm' };
    expect(sanitizeExecutionEvent(start)).toBe(start);
  });
});
