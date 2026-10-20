/**
 * telegram.ts — Telegram connector + gateway adapter.
 *
 * Deliberately does NOT reuse `TelegramBotApi` from @chatbot/telegram: importing
 * it pulls in libs/telegram/src/config/env.ts, whose validation would run inside
 * Mission Control, a process that doesn't set those vars. Direct fetch keeps the
 * adapter self-contained, which is what the design reference calls for.
 *
 * Tenant resolution: a Telegram webhook body carries no workspace or bot
 * identifier at all, so the `x-telegram-bot-api-secret-token` header is the only
 * tenant-identifying value in the request. We look the tenant up by sha256 of
 * that header (see gateway/channel-link.ts). That makes the secret both the
 * authentication AND the routing key, so it must be high-entropy — which is why
 * the settings form generates it rather than letting anyone type one.
 *
 * Replay protection: none, matching the reference's §4 note. Telegram sends no
 * timestamp or signature, so opacity of the secret over TLS is all there is.
 */

import { createLogger } from '@chatbot/shared';
import { ClawConnectorConfigService } from '../config-service';
import { hashExternalId, resolveTenantByExternalId } from '../../gateway/channel-link';
import { readRawBody, parseJsonSafely } from '../../gateway/raw-body';
import { getRunService } from '../../gateway/run-service';
import {
  GatewayTenantUnresolvedError,
  GatewayUnsupportedPayloadError,
} from '../../gateway/gateway-service';
import type {
  ApprovalRequest,
  ChannelAdapter,
  ClawRunEventRecord,
  ClawRunRecord,
  GatewayMessage,
  TelegramTriggerMeta,
} from '../../gateway/types';
import type {
  ChannelType,
  DeliveryMode,
  HilCapabilities,
  TelegramConnectorConfig,
  VerifyResult,
} from '../types';

const logger = createLogger('claw-studio:connector:telegram');

const API_BASE = 'https://api.telegram.org';
const VERIFY_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 10_000;
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
/** Telegram rejects messages over 4096 characters. */
const MAX_MESSAGE_LENGTH = 4000;

export const TELEGRAM_CALLBACK_PREFIX = 'claw';

interface TelegramGetMeResponse {
  ok: boolean;
  result?: { id?: number; username?: string; first_name?: string };
  description?: string;
}

interface TelegramSendResponse {
  ok: boolean;
  result?: { message_id?: number };
  description?: string;
}

interface TelegramUpdate {
  message?: {
    message_id?: number;
    text?: string;
    from?: { id?: number; is_bot?: boolean };
    chat?: { id?: number };
    reply_to_message?: { message_id?: number };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: { message_id?: number; chat?: { id?: number } };
  };
}

interface ParsedInbound {
  tenantId: string | null;
  update: TelegramUpdate | null;
}

const inboundCache = new WeakMap<Request, Promise<ParsedInbound>>();

export class TelegramConnector implements ChannelAdapter {
  readonly channelType: ChannelType = 'telegram';
  readonly displayName = 'Telegram';
  readonly description =
    'Talk to Claw from a Telegram bot, with replies streamed into the chat and approvals as inline buttons.';
  readonly deliveryMode: DeliveryMode = 'streaming';
  readonly hilCapabilities: HilCapabilities = {
    clarification: true,
    approvalButtons: true,
    threadedReplies: true,
  };

  async getConfig(tenantId: string): Promise<TelegramConnectorConfig | null> {
    return (await new ClawConnectorConfigService(tenantId).getRaw(
      'telegram',
    )) as TelegramConnectorConfig | null;
  }

  async verifyCredentials(tenantId: string, override?: Record<string, string>): Promise<VerifyResult> {
    const botToken = override?.botToken?.trim() || (await this.getConfig(tenantId))?.botToken;
    if (!botToken) {
      return { ok: false, error: 'A bot token is required to test the Telegram connection.' };
    }

    try {
      const res = await fetch(`${API_BASE}/bot${botToken}/getMe`, {
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      const data = (await res.json()) as TelegramGetMeResponse;

      if (!data.ok) {
        logger.warn({ tenantId, description: data.description }, 'Telegram getMe rejected the token');
        return { ok: false, error: `Telegram rejected the token: ${data.description ?? 'unknown error'}` };
      }

      const username = data.result?.username ?? data.result?.first_name ?? 'bot';
      logger.info({ tenantId, username }, 'Telegram credentials verified');
      return {
        ok: true,
        detail: `Connected as @${username}`,
        meta: { botUsername: username, botId: String(data.result?.id ?? '') },
      };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Telegram did not respond within 10 seconds.'
          : error instanceof Error
            ? error.message
            : 'Unknown error';
      logger.error({ error, tenantId }, 'Telegram credential verification failed');
      return { ok: false, error: message };
    }
  }

  // ==========================================================================
  // Inbound
  // ==========================================================================

  private parse(req: Request): Promise<ParsedInbound> {
    const cached = inboundCache.get(req);
    if (cached) return cached;

    const promise = (async (): Promise<ParsedInbound> => {
      const secret = req.headers.get(SECRET_HEADER);
      const tenantId = secret ? await resolveTenantByExternalId('telegram', hashExternalId(secret)) : null;
      const update = parseJsonSafely<TelegramUpdate>(await readRawBody(req));
      return { tenantId, update };
    })();

    inboundCache.set(req, promise);
    return promise;
  }

  /**
   * The secret token IS the credential. Resolving a tenant from its hash proves
   * the header matched a stored secret exactly, which is the same check as the
   * reference's plain equality — just done as an indexed lookup so it also tells
   * us whose request it is.
   */
  async validateRequest(req: Request): Promise<boolean> {
    try {
      if (!req.headers.get(SECRET_HEADER)) {
        logger.warn('Telegram request missing the secret token header');
        return false;
      }
      const { tenantId } = await this.parse(req);
      if (!tenantId) {
        logger.warn('Telegram secret token did not match any connected tenant');
        return false;
      }
      return true;
    } catch (error) {
      logger.error({ error }, 'Telegram request validation threw');
      return false;
    }
  }

  async parseInbound(req: Request): Promise<GatewayMessage> {
    const { tenantId, update } = await this.parse(req);
    if (!tenantId) throw new GatewayTenantUnresolvedError('telegram');
    if (!update) throw new GatewayUnsupportedPayloadError('Telegram update was not valid JSON');

    // Inline keyboard press → approve / reject.
    if (update.callback_query) {
      const data = update.callback_query.data ?? '';
      const [prefix, action, runId] = data.split(':');
      if (prefix !== TELEGRAM_CALLBACK_PREFIX || (action !== 'approve' && action !== 'reject') || !runId) {
        throw new GatewayUnsupportedPayloadError('Unrecognised Telegram callback data');
      }
      return {
        channelType: 'telegram',
        tenantId,
        taskDescription: '',
        userId: update.callback_query.from?.id ? String(update.callback_query.from.id) : undefined,
        replyContext: { runId, action, tenantId },
        channelMeta: {},
      };
    }

    const message = update.message;
    const text = message?.text?.trim();
    const chatId = message?.chat?.id;
    if (!message || !text || typeof chatId !== 'number' || message.from?.is_bot) {
      throw new GatewayUnsupportedPayloadError('Not a user text message');
    }

    // In a 1:1 bot chat there are no threads, so a plain message while a run in
    // this chat is waiting on the user is that run's answer — not a new task.
    const waiting = await getRunService().findByTriggerField({
      tenantId,
      source: 'telegram',
      path: ['chatId'],
      value: chatId,
      statuses: ['awaiting_input'],
    });
    if (waiting) {
      return {
        channelType: 'telegram',
        tenantId,
        taskDescription: '',
        userId: message.from?.id ? String(message.from.id) : undefined,
        replyContext: {
          runId: waiting.runId,
          action: 'clarification_response',
          content: text,
          tenantId,
        },
        channelMeta: {},
      };
    }

    const meta: TelegramTriggerMeta = {
      userId: message.from?.id ?? 0,
      chatId,
      messageId: message.message_id,
    };
    return {
      channelType: 'telegram',
      tenantId,
      // Strip a leading /command so "/claw fix the thing" doesn't reach the model.
      taskDescription: text.replace(/^\/[A-Za-z0-9_]+(@\w+)?\s*/, '').trim() || text,
      userId: String(meta.userId),
      channelMeta: meta as unknown as Record<string, unknown>,
    };
  }

  /** Answer the clicker's callback privately so denial does not post to the chat. */
  async sendDenial(req: Request, runId: string): Promise<Response> {
    try {
      const { tenantId, update } = await this.parse(req);
      if (tenantId && update?.callback_query?.id) {
        await this.call(tenantId, 'answerCallbackQuery', {
          callback_query_id: update.callback_query.id,
          text: 'You are not authorized to approve this request.',
          show_alert: true,
        });
      }
    } catch (error) {
      logger.warn({ error, runId }, 'Unable to acknowledge denied Telegram approval');
    }
    return new Response('', { status: 200 });
  }

  /**
   * Telegram only needs an empty 200 — but a run started from a message gets a
   * visible "on it" message whose id is remembered, so progress can be edited
   * into that one message instead of spamming the chat.
   */
  async sendAck(req: Request, runId: string): Promise<Response> {
    try {
      const { tenantId, update } = await this.parse(req);
      const callbackQueryId = update?.callback_query?.id;

      if (callbackQueryId && tenantId) {
        // Clears the button's spinner. Without this the client shows it for ~30s.
        await this.call(tenantId, 'answerCallbackQuery', {
          callback_query_id: callbackQueryId,
          text: 'Got it.',
        }).catch(() => {});
        return new Response('', { status: 200 });
      }

      const chatId = update?.message?.chat?.id;
      if (tenantId && typeof chatId === 'number') {
        const res = await this.call(tenantId, 'sendMessage', {
          chat_id: chatId,
          text: '🐾 Claw is on it…',
        });
        const messageId = res?.result?.message_id;
        if (messageId) {
          await getRunService().mergeTrigger(runId, { ackMessageId: messageId });
        }
      }
    } catch (error) {
      // The ack is a courtesy — Telegram still needs its 200 either way, and the
      // run is already queued.
      logger.warn({ error, runId }, 'Telegram ack message failed');
    }
    return new Response('', { status: 200 });
  }

  // ==========================================================================
  // Outbound
  // ==========================================================================

  private async call(
    tenantId: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<TelegramSendResponse> {
    const config = await this.getConfig(tenantId);
    if (!config?.botToken) {
      throw new Error('Telegram bot token is not configured for this tenant');
    }
    const res = await fetch(`${API_BASE}/bot${config.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const data = (await res.json()) as TelegramSendResponse;
    if (!data.ok) {
      throw new Error(`Telegram ${method} failed: ${data.description ?? 'unknown error'}`);
    }
    return data;
  }

  private meta(run: ClawRunRecord): TelegramTriggerMeta {
    return run.trigger as unknown as TelegramTriggerMeta;
  }

  private async send(
    run: ClawRunRecord,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const { chatId } = this.meta(run);
    if (typeof chatId !== 'number') {
      throw new Error('Telegram run has no chat id to reply to');
    }
    await this.call(run.tenantId, 'sendMessage', {
      chat_id: chatId,
      text: text.slice(0, MAX_MESSAGE_LENGTH),
      ...extra,
    });
  }

  async sendResult(run: ClawRunRecord, events: ClawRunEventRecord[]): Promise<void> {
    const answer = run.result?.answer?.trim() || 'Claw finished without producing a reply.';
    const tools = [...new Set(events.filter((e) => e.eventType === 'tool_call').map((e) => e.toolName))]
      .filter((t): t is string => !!t);
    const footer = tools.length > 0 ? `\n\n🔧 Used ${tools.join(', ')}` : '';
    await this.send(run, `${answer}${footer}`);
    logger.info({ runId: run.runId }, 'Telegram result delivered');
  }

  async sendError(run: ClawRunRecord, error: string): Promise<void> {
    await this.send(run, `⚠️ ${error}`);
  }

  async sendClarification(run: ClawRunRecord, question: string): Promise<void> {
    await this.send(run, `💬 ${question}\n\nJust reply here to continue.`);
  }

  async sendApprovalRequest(run: ClawRunRecord, request: ApprovalRequest): Promise<void> {
    const body =
      request.kind === 'tool'
        ? `Claw wants to run: ${(request.pendingTools ?? []).join(', ')}`
        : ['Claw wants approval for this plan:', ...(request.planSteps ?? []).map((s, i) => `${i + 1}. ${s}`)].join(
            '\n',
          );

    // callback_data has a hard 64-byte limit; "claw:approve:" + a 26-char run id
    // is 39 bytes, so this always fits.
    await this.send(run, body, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `${TELEGRAM_CALLBACK_PREFIX}:approve:${run.runId}` },
            { text: '✖️ Reject', callback_data: `${TELEGRAM_CALLBACK_PREFIX}:reject:${run.runId}` },
          ],
        ],
      },
    });
  }

  /**
   * Streaming progress, edited into the ack message so a long run doesn't turn
   * into a wall of messages. Only meaningful steps produce an edit, and every
   * failure is swallowed — Telegram rate-limits edits, and a dropped progress
   * update must never affect the run.
   */
  async sendStreamChunk(run: ClawRunRecord, event: ClawRunEventRecord): Promise<void> {
    const { ackMessageId, chatId } = this.meta(run);
    if (!ackMessageId || typeof chatId !== 'number') return;

    let text: string | null = null;
    if (event.eventType === 'tool_call' && event.toolName) {
      text = `🐾 Working… running \`${event.toolName}\``;
    } else if (event.eventType === 'node_complete' && event.node === 'planner') {
      text = '🐾 Working… planning the task';
    } else if (event.eventType === 'node_complete' && event.node === 'reflect') {
      text = '🐾 Working… reviewing the result';
    }
    if (!text) return;

    try {
      await this.call(run.tenantId, 'editMessageText', {
        chat_id: chatId,
        message_id: ackMessageId,
        text,
        parse_mode: 'Markdown',
      });
    } catch (error) {
      logger.debug({ error, runId: run.runId }, 'Telegram progress edit skipped');
    }
  }
}
