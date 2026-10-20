/**
 * slack.ts — Slack connector + gateway adapter.
 *
 * Inbound shapes handled, all on the one `POST /api/gateway/slack` route:
 *   - slash command            (urlencoded)              → new run
 *   - block_actions            (urlencoded `payload=`)    → approve / reject
 *   - event_callback / message (JSON, Events API)         → clarification reply
 *   - url_verification         (JSON)                     → handshake, preflight
 *
 * Signature verification has a chicken-and-egg problem the design reference
 * glosses over: the signing secret is per-tenant, but the tenant is only
 * discoverable from `team_id` *inside* the body. So the body is parsed first to
 * read team_id, the tenant is resolved from the link table, and only then is the
 * HMAC checked. Nothing is acted on before that check passes, and the parse
 * result is cached per-request so parseInbound doesn't redo it.
 */

import crypto from 'crypto';
import { createLogger } from '@chatbot/shared';
import { ClawConnectorConfigService } from '../config-service';
import { resolveTenantByExternalId } from '../../gateway/channel-link';
import { readRawBody, parseFormEncoded, parseJsonSafely } from '../../gateway/raw-body';
import { getRunService } from '../../gateway/run-service';
import {
  GatewayTenantUnresolvedError,
  GatewayUnsupportedPayloadError,
} from '../../gateway/gateway-service';
import { runUrl } from '../../gateway/notification-router';
import { SCHEDULED_SOURCE } from '../../gateway/types';
import type {
  ApprovalRequest,
  ChannelAdapter,
  ClawRunEventRecord,
  ClawRunRecord,
  GatewayMessage,
  ReplyAction,
  SlackTriggerMeta,
} from '../../gateway/types';
import type {
  ChannelType,
  DeliveryMode,
  HilCapabilities,
  SlackConnectorConfig,
  VerifyResult,
} from '../types';

const logger = createLogger('claw-studio:connector:slack');

const AUTH_TEST_URL = 'https://slack.com/api/auth.test';
const POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const VERIFY_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 10_000;
/** Slack's own recommendation — anything older is a replay. */
const REPLAY_WINDOW_SECONDS = 300;

export const SLACK_APPROVE_ACTION = 'claw_approve';
export const SLACK_REJECT_ACTION = 'claw_reject';
/** Approves AND adds the pending tools to the originating scheduled task's allowlist,
 *  so the task stops asking. Only offered on scheduled runs. */
export const SLACK_APPROVE_ALWAYS_ACTION = 'claw_approve_always';

interface SlackAuthTestResponse {
  ok: boolean;
  team?: string;
  team_id?: string;
  user?: string;
  error?: string;
}

interface SlackPostMessageResponse {
  ok: boolean;
  ts?: string;
  error?: string;
}

/** Everything derived from one inbound request, computed once. */
interface ParsedInbound {
  kind: 'slash' | 'block_actions' | 'event' | 'unsupported';
  teamId: string | null;
  tenantId: string | null;
  form: Record<string, string>;
  interactive: SlackInteractivePayload | null;
  event: SlackEventEnvelope | null;
  raw: string;
}

interface SlackInteractivePayload {
  type?: string;
  team?: { id?: string; domain?: string };
  user?: { id?: string; username?: string; name?: string };
  channel?: { id?: string; name?: string };
  message?: { ts?: string; thread_ts?: string };
  response_url?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
}

interface SlackEventEnvelope {
  type?: string;
  team_id?: string;
  challenge?: string;
  event?: {
    type?: string;
    subtype?: string;
    text?: string;
    user?: string;
    bot_id?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };
}

const inboundCache = new WeakMap<Request, Promise<ParsedInbound>>();

export class SlackConnector implements ChannelAdapter {
  readonly channelType: ChannelType = 'slack';
  readonly displayName = 'Slack';
  readonly description =
    'Trigger Claw from a slash command and get results back in-channel, with approvals as Block Kit buttons.';
  readonly deliveryMode: DeliveryMode = 'callback';
  readonly hilCapabilities: HilCapabilities = {
    clarification: true,
    approvalButtons: true,
    threadedReplies: true,
  };

  async getConfig(tenantId: string): Promise<SlackConnectorConfig | null> {
    return (await new ClawConnectorConfigService(tenantId).getRaw('slack')) as SlackConnectorConfig | null;
  }

  async verifyCredentials(tenantId: string, override?: Record<string, string>): Promise<VerifyResult> {
    const botToken = override?.botToken?.trim() || (await this.getConfig(tenantId))?.botToken;
    if (!botToken) {
      return { ok: false, error: 'A bot token is required to test the Slack connection.' };
    }

    try {
      const res = await fetch(AUTH_TEST_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });

      // Slack answers 200 with {ok:false,error} for bad credentials, so the
      // HTTP status alone doesn't tell us whether the token works.
      const data = (await res.json()) as SlackAuthTestResponse;
      if (!data.ok) {
        logger.warn({ tenantId, error: data.error }, 'Slack auth.test rejected the token');
        return { ok: false, error: `Slack rejected the token: ${data.error ?? 'unknown error'}` };
      }

      logger.info({ tenantId, team: data.team }, 'Slack credentials verified');
      return {
        ok: true,
        detail: `Connected to workspace "${data.team ?? 'unknown'}" as @${data.user ?? 'bot'}`,
        meta: { team: data.team ?? '', teamId: data.team_id ?? '', botUser: data.user ?? '' },
      };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Slack did not respond within 10 seconds.'
          : error instanceof Error
            ? error.message
            : 'Unknown error';
      logger.error({ error, tenantId }, 'Slack credential verification failed');
      return { ok: false, error: message };
    }
  }

  // ==========================================================================
  // Inbound
  // ==========================================================================

  /** Slack's endpoint handshake. Unsigned by necessity — it predates any
   *  team_id we could resolve a signing secret from — but it only echoes back a
   *  nonce Slack itself supplied, so there is nothing to abuse. */
  async preflight(req: Request): Promise<Response | null> {
    const raw = await readRawBody(req);
    const body = parseJsonSafely<SlackEventEnvelope>(raw);
    if (body?.type !== 'url_verification' || !body.challenge) return null;
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private parse(req: Request): Promise<ParsedInbound> {
    const cached = inboundCache.get(req);
    if (cached) return cached;

    const promise = (async (): Promise<ParsedInbound> => {
      const raw = await readRawBody(req);
      const asJson = parseJsonSafely<SlackEventEnvelope>(raw);

      // Events API posts JSON; slash commands and interactivity post urlencoded.
      if (asJson && typeof asJson === 'object' && asJson.type === 'event_callback') {
        const teamId = asJson.team_id ?? null;
        return {
          kind: 'event',
          teamId,
          tenantId: teamId ? await resolveTenantByExternalId('slack', teamId) : null,
          form: {},
          interactive: null,
          event: asJson,
          raw,
        };
      }

      const form = parseFormEncoded(raw);

      if (form.payload) {
        const interactive = parseJsonSafely<SlackInteractivePayload>(form.payload);
        const teamId = interactive?.team?.id ?? null;
        return {
          kind: interactive?.type === 'block_actions' ? 'block_actions' : 'unsupported',
          teamId,
          tenantId: teamId ? await resolveTenantByExternalId('slack', teamId) : null,
          form,
          interactive: interactive ?? null,
          event: null,
          raw,
        };
      }

      if (form.team_id && form.command) {
        return {
          kind: 'slash',
          teamId: form.team_id,
          tenantId: await resolveTenantByExternalId('slack', form.team_id),
          form,
          interactive: null,
          event: null,
          raw,
        };
      }

      return { kind: 'unsupported', teamId: null, tenantId: null, form, interactive: null, event: null, raw };
    })();

    inboundCache.set(req, promise);
    return promise;
  }

  async validateRequest(req: Request): Promise<boolean> {
    try {
      const timestamp = req.headers.get('x-slack-request-timestamp');
      const signature = req.headers.get('x-slack-signature');
      if (!timestamp || !signature) {
        logger.warn('Slack request missing signature headers');
        return false;
      }

      const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
      if (!Number.isFinite(age) || age > REPLAY_WINDOW_SECONDS) {
        logger.warn({ age }, 'Slack request timestamp outside the replay window');
        return false;
      }

      const parsed = await this.parse(req);
      if (!parsed.tenantId) {
        // No linked tenant means no signing secret to check against. Reported as
        // invalid here; parseInbound turns it into a clearer 404.
        logger.warn({ teamId: parsed.teamId }, 'Slack request from an unlinked workspace');
        return false;
      }

      const config = await this.getConfig(parsed.tenantId);
      if (!config?.signingSecret) {
        logger.warn({ tenantId: parsed.tenantId }, 'Slack signing secret not configured');
        return false;
      }

      const expected =
        'v0=' +
        crypto
          .createHmac('sha256', config.signingSecret)
          .update(`v0:${timestamp}:${parsed.raw}`)
          .digest('hex');

      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      // timingSafeEqual throws on length mismatch, which is itself a failure.
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!ok) logger.warn({ tenantId: parsed.tenantId }, 'Slack signature mismatch');
      return ok;
    } catch (error) {
      logger.error({ error }, 'Slack request validation threw');
      return false;
    }
  }

  async parseInbound(req: Request): Promise<GatewayMessage> {
    const parsed = await this.parse(req);
    if (!parsed.tenantId) throw new GatewayTenantUnresolvedError('slack');
    const tenantId = parsed.tenantId;

    if (parsed.kind === 'slash') {
      const meta: SlackTriggerMeta = {
        userId: parsed.form.user_id ?? '',
        userName: parsed.form.user_name,
        channelId: parsed.form.channel_id ?? '',
        channelName: parsed.form.channel_name,
        responseUrl: parsed.form.response_url,
        teamId: parsed.teamId ?? undefined,
      };
      return {
        channelType: 'slack',
        tenantId,
        taskDescription: (parsed.form.text ?? '').trim(),
        userId: meta.userId,
        channelMeta: meta as unknown as Record<string, unknown>,
      };
    }

    if (parsed.kind === 'block_actions') {
      const action = parsed.interactive?.actions?.[0];
      const runId = action?.value;
      const ACTION_MAP: Record<string, ReplyAction> = {
        [SLACK_APPROVE_ACTION]: 'approve',
        [SLACK_REJECT_ACTION]: 'reject',
        [SLACK_APPROVE_ALWAYS_ACTION]: 'approve_always',
      };
      const replyAction = action?.action_id ? ACTION_MAP[action.action_id] : undefined;
      if (!runId || !replyAction) {
        throw new GatewayUnsupportedPayloadError('Unrecognised Slack interaction');
      }
      return {
        channelType: 'slack',
        tenantId,
        taskDescription: '',
        userId: parsed.interactive?.user?.id,
        replyContext: { runId, action: replyAction, tenantId },
        channelMeta: {},
      };
    }

    if (parsed.kind === 'event') {
      const event = parsed.event?.event;
      // Ignore our own messages and non-text events, or the bot will answer itself.
      if (event?.type !== 'message' || event.bot_id || event.subtype || !event.text?.trim()) {
        throw new GatewayUnsupportedPayloadError('Not a user text message');
      }
      const threadTs = event.thread_ts;
      if (!threadTs) {
        throw new GatewayUnsupportedPayloadError('Message is not a thread reply');
      }

      // A reply only means something if it answers a run that asked a question.
      const run = await getRunService().findByTriggerField({
        tenantId,
        source: 'slack',
        path: ['postedTs'],
        value: threadTs,
        statuses: ['awaiting_input'],
      });
      if (!run) {
        throw new GatewayUnsupportedPayloadError('No run is awaiting a reply in this thread');
      }

      return {
        channelType: 'slack',
        tenantId,
        taskDescription: '',
        userId: event.user,
        replyContext: {
          runId: run.runId,
          action: 'clarification_response',
          content: event.text.trim(),
          tenantId,
        },
        channelMeta: {},
      };
    }

    throw new GatewayUnsupportedPayloadError('Unsupported Slack payload');
  }

  async sendAck(req: Request, runId: string): Promise<Response> {
    const parsed = await this.parse(req).catch(() => null);

    // Interactions and Events API deliveries just need a fast 200; a body would
    // overwrite the message the buttons live on.
    if (parsed?.kind !== 'slash') {
      return new Response('', { status: 200 });
    }

    logger.info({ runId }, 'Slack slash command acked');
    return new Response(
      JSON.stringify({
        response_type: 'ephemeral',
        text: 'Claw is on it — results will land in this channel shortly.',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  /** Ephemeral response to the clicking user; never modifies the shared approval message. */
  async sendDenial(req: Request, runId: string): Promise<Response> {
    const parsed = await this.parse(req).catch(() => null);
    if (parsed?.kind !== 'block_actions') return this.sendAck(req, runId);
    return new Response(
      JSON.stringify({
        response_type: 'ephemeral',
        replace_original: false,
        text: 'You are not authorized to approve this request.',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ==========================================================================
  // Outbound
  // ==========================================================================

  private meta(run: ClawRunRecord): SlackTriggerMeta {
    return run.trigger as unknown as SlackTriggerMeta;
  }

  /**
   * Posts via chat.postMessage when a bot token exists (the only way to thread
   * replies and keep buttons interactive), otherwise falls back to the slash
   * command's response_url. Remembers the first message's ts so later messages
   * in the same run thread under it.
   */
  private async post(
    run: ClawRunRecord,
    body: { text: string; blocks?: unknown[] },
  ): Promise<void> {
    const meta = this.meta(run);
    const config = await this.getConfig(run.tenantId);
    const threadTs = meta.postedTs ?? meta.threadTs;

    if (config?.botToken && meta.channelId) {
      const res = await fetch(POST_MESSAGE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.botToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: meta.channelId,
          text: body.text,
          ...(body.blocks ? { blocks: body.blocks } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const data = (await res.json()) as SlackPostMessageResponse;
      if (!data.ok) {
        throw new Error(`Slack chat.postMessage failed: ${data.error ?? 'unknown error'}`);
      }
      // First message of the run becomes the thread anchor, which is also what
      // inbound thread replies are matched against.
      if (!meta.postedTs && data.ts) {
        await getRunService().mergeTrigger(run.runId, { postedTs: data.ts });
      }
      return;
    }

    if (!meta.responseUrl) {
      throw new Error('Slack run has neither a bot token nor a response_url to reply through');
    }
    const res = await fetch(meta.responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'in_channel',
        text: body.text,
        ...(body.blocks ? { blocks: body.blocks } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Slack response_url returned ${res.status}`);
    }
  }

  async sendResult(run: ClawRunRecord, events: ClawRunEventRecord[]): Promise<void> {
    const answer = run.result?.answer?.trim() || 'Claw finished without producing a reply.';
    const tools = [...new Set(events.filter((e) => e.eventType === 'tool_call').map((e) => e.toolName))]
      .filter((t): t is string => !!t);

    const blocks: unknown[] = [
      { type: 'section', text: { type: 'mrkdwn', text: answer.slice(0, 2900) } },
    ];
    if (tools.length > 0) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `:wrench: Used ${tools.join(', ')}` }],
      });
    }
    await this.post(run, { text: answer, blocks });
    logger.info({ runId: run.runId }, 'Slack result delivered');
  }

  async sendError(run: ClawRunRecord, error: string): Promise<void> {
    await this.post(run, { text: `:warning: ${error}` });
  }

  async sendClarification(run: ClawRunRecord, question: string): Promise<void> {
    await this.post(run, {
      text: question,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:speech_balloon: ${question}` } },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Reply in this thread to continue.' }],
        },
      ],
    });
  }

  async sendApprovalRequest(run: ClawRunRecord, request: ApprovalRequest): Promise<void> {
    const summary =
      request.kind === 'tool'
        ? `Claw wants to run: *${(request.pendingTools ?? []).join(', ')}*`
        : 'Claw wants approval for this plan:';
    const detail =
      request.kind === 'plan' && request.planSteps?.length
        ? '\n' + request.planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : '';

    await this.post(run, {
      text: `${summary}${detail}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `${summary}${detail}`.slice(0, 2900) } },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Approve' },
              action_id: SLACK_APPROVE_ACTION,
              value: run.runId,
            },
            // Only for scheduled runs: it grants the tool on that task, and a
            // channel-triggered run has no task to grant it on.
            ...(run.source === SCHEDULED_SOURCE && request.kind === 'tool'
              ? [{
                type: 'button',
                text: { type: 'plain_text', text: 'Always allow for this task' },
                action_id: SLACK_APPROVE_ALWAYS_ACTION,
                value: run.runId,
              }]
              : []),
            {
              type: 'button',
              style: 'danger',
              text: { type: 'plain_text', text: 'Reject' },
              action_id: SLACK_REJECT_ACTION,
              value: run.runId,
            },
          ],
        },
      ],
    });
  }

  /** Exposed so the settings route can build the same link the router uses. */
  dashboardLink(baseUrl: string, run: ClawRunRecord): string {
    return runUrl(baseUrl, run.runId);
  }
}
