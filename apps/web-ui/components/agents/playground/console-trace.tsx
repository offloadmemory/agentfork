'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChevronRight, CheckCircle2, XCircle, Clock } from 'lucide-react';
import type { ConsoleEvent } from '@/lib/playground/types';

interface ConsoleTraceProps {
  events: ConsoleEvent[];
}

interface TraceItem {
  id: string;
  type: string;
  name: string;
  status: 'completed' | 'failed' | 'running';
  durationMs?: number;
  input?: unknown;
  output?: unknown;
}

/** Subset of a graph `NodeTraceEntry` as streamed (already redacted by the server). */
interface NodeTracePayload {
  nodeId?: string;
  nodeType?: string;
  nodeLabel?: string;
  status?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

function applyNodeTrace(item: TraceItem, trace: NodeTracePayload): void {
  item.name = trace.nodeLabel ?? item.name;
  item.type = trace.nodeType ?? item.type;
  item.status = trace.status === 'failed' ? 'failed' : 'completed';
  item.durationMs = trace.durationMs;
  item.input = trace.input;
  item.output =
    trace.error !== undefined
      ? { ...((trace.output as Record<string, unknown> | undefined) ?? {}), error: trace.error }
      : trace.output;
}

function buildTraceItems(events: ConsoleEvent[]): TraceItem[] {
  const items: TraceItem[] = [];
  const toolCalls = new Map<string, TraceItem>();
  // Latest running item per graph node id (a node may run more than once in loops).
  const runningNodes = new Map<string, TraceItem>();

  for (const event of events) {
    if (event.type === 'tool_call') {
      const item: TraceItem = {
        id: (event.data.id as string) ?? event.id,
        type: 'tool',
        name: String(event.data.toolName ?? 'unknown'),
        status: 'running',
        input: event.data.args,
      };
      toolCalls.set(item.id, item);
      items.push(item);
    } else if (event.type === 'tool_result') {
      const id = (event.data.id as string) ?? '';
      const existing = toolCalls.get(id);
      if (existing) {
        existing.status = 'completed';
        existing.durationMs = event.data.durationMs as number;
        existing.output = event.data.result;
      } else {
        items.push({
          id: event.id,
          type: 'tool',
          name: String(event.data.toolName ?? 'unknown'),
          status: 'completed',
          durationMs: event.data.durationMs as number,
          output: event.data.result,
        });
      }
    } else if (event.type === 'execution_start') {
      items.unshift({
        id: event.id,
        type: 'execution',
        name: `Execution (${event.data.model})`,
        status: 'running',
      });
    } else if (event.type === 'execution_end') {
      const execItem = items.find((i) => i.type === 'execution');
      if (execItem) {
        execItem.status = event.data.error ? 'failed' : 'completed';
        execItem.durationMs = event.data.durationMs as number;
      }
    } else if (event.type === 'node_start') {
      const nodeId = String(event.data.nodeId ?? 'node');
      const item: TraceItem = {
        id: event.id,
        type: String(event.data.nodeType ?? 'node'),
        name: nodeId,
        status: 'running',
      };
      runningNodes.set(nodeId, item);
      items.push(item);
    } else if (event.type === 'node_complete') {
      const trace = (event.data.trace ?? {}) as NodeTracePayload;
      const nodeId = String(event.data.nodeId ?? trace.nodeId ?? 'node');
      let item = runningNodes.get(nodeId);
      if (!item) {
        item = { id: event.id, type: trace.nodeType ?? 'node', name: nodeId, status: 'running' };
        items.push(item);
      }
      applyNodeTrace(item, trace);
      runningNodes.delete(nodeId);
    } else if (event.type === 'node_error') {
      const nodeId = String(event.data.nodeId ?? 'node');
      let item = runningNodes.get(nodeId);
      if (!item) {
        item = { id: event.id, type: 'node', name: nodeId, status: 'running' };
        items.push(item);
      }
      item.status = 'failed';
      item.output = { error: String(event.data.error ?? 'Node failed') };
      runningNodes.delete(nodeId);
    } else if (event.type === 'error') {
      items.push({
        id: event.id,
        type: 'error',
        name: String(event.data.message ?? 'Error'),
        status: 'failed',
      });
    }
  }

  return items;
}

function TraceItemRow({ item }: { item: TraceItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = item.input !== undefined || item.output !== undefined;

  const StatusIcon =
    item.status === 'completed' ? CheckCircle2 : item.status === 'failed' ? XCircle : Clock;

  const statusColor =
    item.status === 'completed'
      ? 'text-green-500'
      : item.status === 'failed'
        ? 'text-red-500'
        : 'text-yellow-500';

  return (
    <div className="border-b border-border/30">
      <button
        onClick={() => hasDetail && setExpanded(!expanded)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors',
          !hasDetail && 'cursor-default'
        )}
      >
        {hasDetail ? (
          <ChevronRight
            className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')}
          />
        ) : (
          <div className="w-3" />
        )}
        <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', statusColor)} />
        <span className="text-[11px] font-medium truncate">{item.name}</span>
        <Badge variant="outline" className="text-[9px] ml-auto shrink-0">
          {item.type}
        </Badge>
        {item.durationMs !== undefined && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {item.durationMs < 1000 ? `${item.durationMs}ms` : `${(item.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-6 pb-2 space-y-1">
          {item.input !== undefined && (
            <div>
              <span className="text-[9px] uppercase text-muted-foreground font-semibold">Input</span>
              <pre className="text-[10px] bg-muted rounded p-2 mt-0.5 overflow-auto max-h-24">
                {JSON.stringify(item.input, null, 2)}
              </pre>
            </div>
          )}
          {item.output !== undefined && (
            <div>
              <span className="text-[9px] uppercase text-muted-foreground font-semibold">Output</span>
              <pre className="text-[10px] bg-muted rounded p-2 mt-0.5 overflow-auto max-h-24">
                {JSON.stringify(item.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ConsoleTrace({ events }: ConsoleTraceProps) {
  const traceItems = buildTraceItems(events);

  if (traceItems.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-xs text-muted-foreground">Run the agent to see execution trace.</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div>
        {traceItems.map((item) => (
          <TraceItemRow key={item.id} item={item} />
        ))}
      </div>
    </ScrollArea>
  );
}
