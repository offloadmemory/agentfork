/**
 * PII-safe handling of per-node execution traces of graph agents.
 *
 * - Every persisted/streamed trace entry is redacted (see ./redact) and then
 *   truncated, in that order, so a cut can never leave half of an identifier.
 * - Types are structural on purpose: this module must not depend on
 *   `@chatbot/agent-studio` (which depends on `@chatbot/shared`).
 */

import { redactDeep, redactText, TRUNCATED_PLACEHOLDER } from './redact';

export interface NodeTraceLike {
  nodeId: string;
  nodeType: string;
  nodeLabel?: string;
  status: 'completed' | 'failed' | 'skipped' | 'paused';
  startedAt: string;
  completedAt?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A redacted, size-capped trace entry. Declared as a JSON-safe type alias (not an
 * interface) so it can be stored in a Prisma `Json` column without casts.
 */
export type PersistedNodeTrace = {
  nodeId: string;
  nodeType: string;
  nodeLabel?: string;
  status: NodeTraceLike['status'];
  startedAt: string;
  completedAt?: string;
  input?: { [key: string]: JsonValue };
  output?: { [key: string]: JsonValue };
  error?: string;
  durationMs?: number;
};

export type PersistedTraceOutput = {
  trace: PersistedNodeTrace[];
  /** Number of entries dropped after MAX_TRACE_ENTRIES was reached. */
  traceDropped?: number;
};

/** Event shape accepted by the collector/sanitizer (structurally compatible with agent-studio's ExecutionEvent). */
export type TraceEvent = { type: string } & Record<string, unknown>;

export const MAX_FIELD_CHARS = 4000;
export const MAX_TRACE_ENTRIES = 200;

/**
 * Caps the size of a (already redacted) value. Strings are cut; objects/arrays
 * larger than `maxChars` once serialised are replaced by a marker object with
 * a preview.
 */
export function truncateValue(value: unknown, maxChars: number = MAX_FIELD_CHARS): unknown {
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}${TRUNCATED_PLACEHOLDER}` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { truncated: true, preview: TRUNCATED_PLACEHOLDER };
  }
  if (json.length <= maxChars) return value;
  return { truncated: true, originalLength: json.length, preview: `${json.slice(0, maxChars)}${TRUNCATED_PLACEHOLDER}` };
}

function redactAndTruncate(value: unknown): unknown {
  return truncateValue(redactDeep(value));
}

function redactAndTruncateRecord(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!record) return record;
  const redacted = redactDeep(record);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(redacted)) out[key] = truncateValue(value);
  return out;
}

/** Returns a redacted, size-capped copy of a trace entry. */
export function sanitizeTraceEntry(entry: NodeTraceLike): PersistedNodeTrace {
  const out: PersistedNodeTrace = {
    nodeId: entry.nodeId,
    nodeType: entry.nodeType,
    status: entry.status,
    startedAt: entry.startedAt,
  };
  if (entry.nodeLabel !== undefined) out.nodeLabel = redactText(entry.nodeLabel);
  if (entry.completedAt !== undefined) out.completedAt = entry.completedAt;
  if (entry.durationMs !== undefined) out.durationMs = entry.durationMs;
  // redactDeep/truncateValue only transform strings/containers of already-serialisable
  // executor data, so the result is JSON-safe.
  if (entry.input !== undefined) out.input = redactAndTruncateRecord(entry.input) as { [key: string]: JsonValue };
  if (entry.output !== undefined) out.output = redactAndTruncateRecord(entry.output) as { [key: string]: JsonValue };
  if (entry.error !== undefined) out.error = redactAndTruncate(entry.error) as string;
  return out;
}

/**
 * Accumulates redacted per-node trace entries from executor events.
 *
 * The graph executor emits `node_complete` only for successful nodes, so failed
 * and paused nodes are reconstructed from `node_start` + `node_error` /
 * `recordPause()`.
 */
export class NodeTraceCollector {
  private entries: PersistedNodeTrace[];
  private dropped: number;
  private current?: { nodeId: string; nodeType: string; startedAtMs: number };

  constructor(
    initial: PersistedNodeTrace[] = [],
    initialDropped = 0,
    private readonly maxEntries: number = MAX_TRACE_ENTRIES,
  ) {
    this.entries = initial.slice(0, maxEntries);
    this.dropped = initialDropped + Math.max(0, initial.length - maxEntries);
  }

  /** Rebuilds a collector from a previously persisted `AgentExecution.output` (e.g. on resume). */
  static fromOutput(output: unknown, maxEntries: number = MAX_TRACE_ENTRIES): NodeTraceCollector {
    if (output && typeof output === 'object') {
      const record = output as { trace?: unknown; traceDropped?: unknown };
      const trace = Array.isArray(record.trace) ? (record.trace as PersistedNodeTrace[]) : [];
      const dropped = typeof record.traceDropped === 'number' ? record.traceDropped : 0;
      return new NodeTraceCollector(trace, dropped, maxEntries);
    }
    return new NodeTraceCollector([], 0, maxEntries);
  }

  handleEvent(event: TraceEvent): void {
    switch (event.type) {
      case 'node_start':
        this.current = {
          nodeId: String(event.nodeId),
          nodeType: String(event.nodeType),
          startedAtMs: Date.now(),
        };
        break;
      case 'node_complete':
        if (event.trace && typeof event.trace === 'object') {
          this.add(sanitizeTraceEntry(event.trace as NodeTraceLike));
        }
        this.current = undefined;
        break;
      case 'node_error': {
        const nowMs = Date.now();
        const known = this.current && this.current.nodeId === String(event.nodeId) ? this.current : undefined;
        this.add({
          nodeId: String(event.nodeId),
          nodeType: known?.nodeType ?? 'unknown',
          status: 'failed',
          startedAt: new Date(known?.startedAtMs ?? nowMs).toISOString(),
          completedAt: new Date(nowMs).toISOString(),
          durationMs: known ? nowMs - known.startedAtMs : undefined,
          error: redactAndTruncate(String(event.error ?? '')) as string,
        });
        this.current = undefined;
        break;
      }
      default:
        break;
    }
  }

  /** Records the node that is pausing the execution (e.g. a human node). */
  recordPause(): void {
    if (!this.current) return;
    const nowMs = Date.now();
    this.add({
      nodeId: this.current.nodeId,
      nodeType: this.current.nodeType,
      status: 'paused',
      startedAt: new Date(this.current.startedAtMs).toISOString(),
      completedAt: new Date(nowMs).toISOString(),
      durationMs: nowMs - this.current.startedAtMs,
    });
    this.current = undefined;
  }

  snapshot(): PersistedTraceOutput {
    return this.dropped > 0
      ? { trace: [...this.entries], traceDropped: this.dropped }
      : { trace: [...this.entries] };
  }

  private add(entry: PersistedNodeTrace): void {
    if (this.entries.length >= this.maxEntries) {
      this.dropped++;
      return;
    }
    this.entries.push(entry);
  }
}

/**
 * Returns the version of an executor event that is safe to stream to the
 * browser console. `text_delta` (the answer shown in the chat) and events
 * without payload are returned unchanged.
 */
export function sanitizeExecutionEvent(event: TraceEvent): TraceEvent {
  switch (event.type) {
    case 'node_complete':
      return event.trace && typeof event.trace === 'object'
        ? { ...event, trace: sanitizeTraceEntry(event.trace as NodeTraceLike) }
        : event;
    case 'node_error':
      return { ...event, error: redactAndTruncate(String(event.error ?? '')) };
    case 'state_update':
      return { ...event, channels: redactAndTruncateRecord(event.channels as Record<string, unknown> | undefined) };
    case 'execution_complete': {
      const trace = Array.isArray(event.trace) ? (event.trace as NodeTraceLike[]).map(sanitizeTraceEntry) : event.trace;
      const finalState = event.finalState as Record<string, unknown> | undefined;
      return {
        ...event,
        trace,
        finalState: finalState
          ? {
              ...finalState,
              channels: redactAndTruncateRecord(finalState.channels as Record<string, unknown> | undefined),
              messages: redactAndTruncate(finalState.messages),
            }
          : finalState,
      };
    }
    default:
      return event;
  }
}
