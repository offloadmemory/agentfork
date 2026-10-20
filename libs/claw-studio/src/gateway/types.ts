/**
 * gateway/types.ts — the inbound/outbound half of the channel contract, plus the
 * run/event record shapes the router and adapters are typed against.
 *
 * Import direction is one-way: this file imports `ChannelConnector`/`ChannelType`
 * from ../connectors/types, and connectors/* import `ChannelAdapter` from here.
 * connectors/types.ts imports nothing from this file, so there is no cycle.
 */

import type { ChannelConnector, ChannelType } from '../connectors/types';

/** Runs created from the dashboard rather than a channel have no adapter. */
export const DASHBOARD_SOURCE = 'dashboard';
/** Runs created inline from Mission Control's Playground have no adapter either. */
export const PLAYGROUND_SOURCE = 'playground';
/** Time-triggered autonomous run — see scheduler/run-scheduled-task.ts. */
export const SCHEDULED_SOURCE = 'scheduled';
/**
 * A turn of Chat with Claw.
 *
 * Chat deliberately persisted nothing for a long time — the activity timeline was
 * live-only. That is what made a browser reload lose the answer outright: the run
 * was aborted when the SSE socket died, and nothing had ever recorded what it had
 * produced. Chat turns are runs now so a reloaded page can replay the timeline and
 * pick up the answer, exactly as the gateway and Playground surfaces already do.
 *
 * They are excluded from the global /runs list by default (see
 * `ClawRunService.list`) — one row per chat message would otherwise bury the
 * scheduled and channel runs that list exists for.
 */
export const CHAT_SOURCE = 'chat';
export type RunSource =
  | ChannelType
  | typeof DASHBOARD_SOURCE
  | typeof PLAYGROUND_SOURCE
  | typeof SCHEDULED_SOURCE
  | typeof CHAT_SOURCE;

/** How a scheduled run's outcome is summarised for its delivery channel. */
export type ScheduledOutcome = 'result' | 'failure' | 'attention';

export type RunStatus =
  | 'queued'
  | 'in_progress'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Statuses from which a run can still be resumed or is still doing work. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'in_progress',
  'awaiting_input',
  'awaiting_approval',
];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** Runs and their events are pruned after this long. */
export const RUN_TTL_DAYS = 30;

// ============================================================================
// Records
// ============================================================================

export type RunEventType =
  | 'run_started'
  | 'node_complete'
  | 'tool_call'
  | 'tool_result'
  | 'status'
  | 'clarification'
  | 'approval_request'
  | 'approval_decision'
  /** Scheduled-digest delivery attempt — see scheduler/scheduled-notifier.ts. */
  | 'notification'
  | 'error';

export interface ClawRunEventRecord {
  id: string;
  tenantId: string;
  runId: string;
  eventType: RunEventType | string;
  node: string | null;
  content: string | null;
  toolName: string | null;
  toolArgs: unknown;
  toolOutput: string | null;
  metadata: unknown;
  createdAt: Date;
}

export interface ClawRunRecord {
  id: string;
  tenantId: string;
  runId: string;
  source: RunSource;
  status: RunStatus;
  taskDescription: string;
  /** LangGraph checkpoint thread — one per run, never the tenant's chat thread. */
  threadId: string;
  /** The originating adapter's trigger metadata, persisted verbatim. */
  trigger: Record<string, unknown>;
  result: RunResult | null;
  clarification: { question: string } | null;
  approvalRequest: ApprovalRequest | null;
  error: string | null;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface RunResult {
  /** Claw's user-visible final answer. */
  answer: string;
  iterations?: number;
  toolsUsed?: string[];
  /**
   * What the turn cost and how long it took.
   *
   * Carried inside `result` (already a `Json` column) rather than as new columns,
   * deliberately: this schema's pgvector HNSW indexes make `prisma migrate dev`
   * unusable (see libs/claw-studio/CLAUDE.md), so a hand-authored migration for
   * four optional numbers would be pure risk for no gain. Optional throughout —
   * runs recorded before this existed simply have none, and providers that report
   * no usage leave the token counts at zero.
   */
  usage?: { inputTokens: number; outputTokens: number; modelCalls: number; modelMs: number };
  /** Wall-clock for the turn as the user experienced it, including tool time. */
  durationMs?: number;
}

export interface ApprovalRequest {
  kind: 'plan' | 'tool';
  planSteps?: string[];
  pendingTools?: string[];
}

// ============================================================================
// Inbound message
// ============================================================================

/** `approve_always` approves AND adds the tool to the originating scheduled task's
 *  allowlist, so the task stops asking. Falls back to plain approve on runs with no
 *  task behind them. */
export type ReplyAction = 'clarification_response' | 'approve' | 'reject' | 'approve_always';

export interface ReplyContext {
  runId: string;
  action: ReplyAction;
  content?: string;
  tenantId?: string;
}

export interface GatewayMessage {
  channelType: ChannelType;
  tenantId: string;
  taskDescription: string;
  userId?: string;
  /** Present => this is a resume of an existing run, not a new one. */
  replyContext?: ReplyContext;
  /** Polymorphic per-channel trigger metadata, persisted verbatim. */
  channelMeta: Record<string, unknown>;
}

/** Per-channel `channelMeta` shapes. Stored as JSON, so these are documentation
 *  plus a cast target for the adapters' own outbound calls. */
export interface SlackTriggerMeta {
  userId: string;
  userName?: string;
  channelId: string;
  channelName?: string;
  responseUrl?: string;
  teamId?: string;
  threadTs?: string;
  /** Set once an outbound message exists, so follow-ups can thread under it. */
  postedTs?: string;
}

export interface TelegramTriggerMeta {
  userId: number;
  chatId: number;
  messageId?: number;
  callbackQueryId?: string;
  /** The ack message we posted, edited in place as the run progresses. */
  ackMessageId?: number;
}

/**
 * Discord has no persistent Gateway-socket connection in this integration
 * (see discord.ts) — only its Interactions webhook (slash commands + button
 * clicks), so there is no threading/message-id to remember: every reply is a
 * fresh bot-authenticated channel message.
 */
export interface DiscordTriggerMeta {
  userId: string;
  userName?: string;
  channelId: string;
  guildId?: string;
}

// ============================================================================
// Adapter contract
// ============================================================================

export interface ChannelAdapter extends ChannelConnector {
  /**
   * Handles platform handshakes that must be answered before (and without) a
   * tenant-scoped signature check — Slack's `url_verification` challenge is the
   * only current case. Returning null means "not a handshake, carry on".
   */
  preflight?(req: Request): Promise<Response | null>;

  /** Signature / shared-secret check over the raw body. Never trust caller-supplied tenant ids. */
  validateRequest(req: Request): Promise<boolean>;
  parseInbound(req: Request): Promise<GatewayMessage>;
  /** Must be fast — Slack and Discord both time out around 3s. */
  sendAck(req: Request, runId: string): Promise<Response>;
  /** Private, generic feedback on a denied approval. Never reveals run details. */
  sendDenial?(req: Request, runId: string): Promise<Response>;

  sendResult(run: ClawRunRecord, events: ClawRunEventRecord[]): Promise<void>;
  sendError(run: ClawRunRecord, error: string): Promise<void>;
  sendClarification(run: ClawRunRecord, question: string): Promise<void>;
  sendApprovalRequest(run: ClawRunRecord, request: ApprovalRequest): Promise<void>;

  /** Only when deliveryMode === 'streaming'. */
  sendStreamChunk?(run: ClawRunRecord, event: ClawRunEventRecord): Promise<void>;

  /**
   * Delivers a scheduled run's outcome digest. **Optional on purpose**: an adapter
   * without it simply doesn't support scheduled delivery, so Slack/Telegram/Discord
   * stay valid until each implements it. The notifier records a `notification`
   * failure event when a task targets a channel that lacks this.
   */
  sendScheduledNotification?(
    task: { taskId: string; name: string; delivery: { type: string; target?: string } },
    run: ClawRunRecord,
    outcome: ScheduledOutcome,
  ): Promise<void>;
}

// ============================================================================
// Event bus payloads
// ============================================================================

export type BusEvent =
  | { name: 'run:event'; runId: string; event: ClawRunEventRecord }
  | { name: 'run:completed'; runId: string }
  | { name: 'run:failed'; runId: string; error: string }
  | { name: 'run:cancelled'; runId: string; reason?: string }
  | { name: 'hil:clarification'; runId: string; question: string }
  | { name: 'hil:plan_approval'; runId: string; request: ApprovalRequest }
  | { name: 'hil:tool_approval'; runId: string; request: ApprovalRequest };

export type BusEventName = BusEvent['name'];
