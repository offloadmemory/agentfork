/**
 * discord.ts — Discord connector + gateway adapter.
 *
 * Scoped deliberately narrow: Discord's Interactions webhook (slash commands +
 * message-component/button clicks), the same stateless request/response shape
 * Slack and Telegram already use. Reading arbitrary channel messages the way
 * Slack's Events API does would need Discord's Gateway WebSocket instead — a
 * persistent duplex connection that can't run inside a Next.js API route and
 * doesn't exist anywhere in this codebase. That's why `hilCapabilities.clarification`
 * is false below: there is no inbound path for a plain-text follow-up message,
 * only for a slash command or a button click.
 *
 * Inbound shapes handled, all on `POST /api/gateway/discord`:
 *   - PING (type 1)               → handshake, answered in preflight()
 *   - APPLICATION_COMMAND (type 2) → the `/claw` slash command → new run
 *   - MESSAGE_COMPONENT (type 3)   → approve/reject button click → resume
 *
 * Every interaction (including PING) is Ed25519-signed by Discord over
 * `timestamp + rawBody` using the per-application public key, verified with
 * tweetnacl (Node has no built-in raw-key Ed25519 verify). Same chicken-and-egg
 * shape as Slack: the verification key is per-tenant, but the tenant is only
 * resolvable from `application_id` *inside* the body, so the body is parsed
 * first and cached per-request.
 *
 * Outbound replies always go through the bot-token channel-message endpoint,
 * never the interaction's own follow-up webhook — that token expires after 15
 * minutes, which a long-running approval-gated task can easily outlive.
 */

import nacl from 'tweetnacl';
import { createLogger } from '@chatbot/shared';
import { ClawConnectorConfigService } from '../config-service';
import { resolveTenantByExternalId } from '../../gateway/channel-link';
import { readRawBody, parseJsonSafely } from '../../gateway/raw-body';
import {
  GatewayTenantUnresolvedError,
  GatewayUnsupportedPayloadError,
} from '../../gateway/gateway-service';
import { runUrl } from '../../gateway/notification-router';
import type {
  ApprovalRequest,
  ChannelAdapter,
  ClawRunEventRecord,
  ClawRunRecord,
  DiscordTriggerMeta,
  GatewayMessage,
} from '../../gateway/types';
import type {
  ChannelType,
  DeliveryMode,
  DiscordConnectorConfig,
  HilCapabilities,
  VerifyResult,
} from '../types';

const logger = createLogger('claw-studio:connector:discord');

const API_BASE = 'https://discord.com/api/v10';
const VERIFY_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 10_000;

/** The one slash command this connector registers and understands. */
const COMMAND_NAME = 'claw';

// Discord interaction types (https://discord.com/developers/docs/interactions/receiving-and-responding).
const TYPE_PING = 1;
const TYPE_APPLICATION_COMMAND = 2;
const TYPE_MESSAGE_COMPONENT = 3;

// Response types this adapter sends back.
const RESPONSE_PONG = 1;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;
const RESPONSE_DEFERRED_UPDATE_MESSAGE = 6;

export const DISCORD_APPROVE_ACTION = 'claw_approve';
export const DISCORD_REJECT_ACTION = 'claw_reject';

interface DiscordUser {
  id?: string;
  username?: string;
}

interface DiscordInteraction {
  id?: string;
  application_id?: string;
  type?: number;
  data?: { name?: string; options?: Array<{ name?: string; value?: string }>; custom_id?: string };
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
}

/** Everything derived from one inbound request, computed once. */
interface ParsedInbound {
  kind: 'command' | 'component' | 'ping' | 'unsupported';
  applicationId: string | null;
  tenantId: string | null;
  interaction: DiscordInteraction | null;
  raw: string;
}

const inboundCache = new WeakMap<Request, Promise<ParsedInbound>>();

function actorId(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

function actorName(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user?.username ?? interaction.user?.username;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Verifies Discord's Ed25519 signature over `timestamp + rawBody`. Never throws — returns false on any malformed input. */
function verifySignature(rawBody: string, timestamp: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const message = Buffer.from(timestamp + rawBody);
    const signature = Buffer.from(signatureHex, 'hex');
    const publicKey = Buffer.from(publicKeyHex, 'hex');
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

export class DiscordConnector implements ChannelAdapter {
  readonly channelType: ChannelType = 'discord';
  readonly displayName = 'Discord';
  readonly description = 'Trigger Claw with a /claw slash command and get results back in-channel, with approvals as buttons.';
  readonly deliveryMode: DeliveryMode = 'callback';
  readonly hilCapabilities: HilCapabilities = {
    // No inbound path exists for a plain follow-up message (see file header) —
    // the notification router falls back to a dashboard link instead.
    clarification: false,
    approvalButtons: true,
    threadedReplies: false,
  };

  async getConfig(tenantId: string): Promise<DiscordConnectorConfig | null> {
    return (await new ClawConnectorConfigService(tenantId).getRaw('discord')) as DiscordConnectorConfig | null;
  }

  async verifyCredentials(tenantId: string, override?: Record<string, string>): Promise<VerifyResult> {
    const config = await this.getConfig(tenantId);
    const botToken = override?.botToken?.trim() || config?.botToken;
    const applicationId = override?.applicationId?.trim() || config?.applicationId;
    const publicKey = override?.publicKey?.trim() || config?.publicKey;

    if (!botToken) return { ok: false, error: 'A bot token is required to test the Discord connection.' };
    if (!applicationId) return { ok: false, error: 'An application id is required.' };
    if (!publicKey) return { ok: false, error: 'A public key is required.' };

    try {
      const res = await fetch(`${API_BASE}/users/@me`, {
        headers: { Authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text();
        logger.warn({ tenantId, status: res.status }, 'Discord rejected the bot token');
        return { ok: false, error: `Discord rejected the bot token (${res.status}): ${text.slice(0, 200)}` };
      }
      const data = (await res.json()) as DiscordUser;
      logger.info({ tenantId, botUsername: data.username }, 'Discord credentials verified');
      return {
        ok: true,
        detail: `Connected as bot @${data.username ?? 'unknown'}`,
        meta: { botUsername: data.username ?? '', applicationId },
      };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Discord did not respond within 10 seconds.'
          : error instanceof Error
            ? error.message
            : 'Unknown error';
      logger.error({ error, tenantId }, 'Discord credential verification failed');
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
      const raw = await readRawBody(req);
      const interaction = parseJsonSafely<DiscordInteraction>(raw);
      const applicationId = interaction?.application_id ?? null;
      const tenantId = applicationId ? await resolveTenantByExternalId('discord', applicationId) : null;

      const kind: ParsedInbound['kind'] =
        interaction?.type === TYPE_PING
          ? 'ping'
          : interaction?.type === TYPE_APPLICATION_COMMAND
            ? 'command'
            : interaction?.type === TYPE_MESSAGE_COMPONENT
              ? 'component'
              : 'unsupported';

      return { kind, applicationId, tenantId, interaction, raw };
    })();

    inboundCache.set(req, promise);
    return promise;
  }

  /**
   * Discord's PING handshake is itself signed, so — unlike Slack's unsigned
   * url_verification — this still resolves the tenant and verifies before
   * answering. Every other interaction type falls through to the normal
   * validateRequest()/parseInbound() path (returns null here).
   */
  async preflight(req: Request): Promise<Response | null> {
    const parsed = await this.parse(req);
    if (parsed.kind !== 'ping') return null;

    const valid = await this.checkSignature(req, parsed);
    if (!valid) {
      logger.warn('Discord PING failed signature validation');
      return json({ error: 'Invalid signature' }, 401);
    }
    logger.info('Answered Discord PING handshake');
    return json({ type: RESPONSE_PONG });
  }

  private async checkSignature(req: Request, parsed: ParsedInbound): Promise<boolean> {
    const timestamp = req.headers.get('x-signature-timestamp');
    const signature = req.headers.get('x-signature-ed25519');
    if (!timestamp || !signature) {
      logger.warn('Discord request missing signature headers');
      return false;
    }
    if (!parsed.tenantId) {
      logger.warn({ applicationId: parsed.applicationId }, 'Discord request from an unlinked application');
      return false;
    }
    const config = await this.getConfig(parsed.tenantId);
    if (!config?.publicKey) {
      logger.warn({ tenantId: parsed.tenantId }, 'Discord public key not configured');
      return false;
    }
    return verifySignature(parsed.raw, timestamp, signature, config.publicKey);
  }

  async validateRequest(req: Request): Promise<boolean> {
    try {
      const parsed = await this.parse(req);
      // PING already validated (and answered) in preflight — anything reaching
      // here is a real command/component interaction.
      return await this.checkSignature(req, parsed);
    } catch (error) {
      logger.error({ error }, 'Discord request validation threw');
      return false;
    }
  }

  async parseInbound(req: Request): Promise<GatewayMessage> {
    const parsed = await this.parse(req);
    if (!parsed.tenantId) throw new GatewayTenantUnresolvedError('discord');
    const tenantId = parsed.tenantId;
    const interaction = parsed.interaction;
    if (!interaction) throw new GatewayUnsupportedPayloadError('Empty Discord interaction');

    if (parsed.kind === 'command') {
      if (interaction.data?.name !== COMMAND_NAME) {
        throw new GatewayUnsupportedPayloadError(`Unrecognised Discord command: ${interaction.data?.name}`);
      }
      const prompt = interaction.data.options?.find((o) => o.name === 'prompt')?.value ?? '';
      const meta: DiscordTriggerMeta = {
        userId: actorId(interaction) ?? '',
        userName: actorName(interaction),
        channelId: interaction.channel_id ?? '',
        guildId: interaction.guild_id,
      };
      return {
        channelType: 'discord',
        tenantId,
        taskDescription: prompt.trim(),
        userId: meta.userId,
        channelMeta: meta as unknown as Record<string, unknown>,
      };
    }

    if (parsed.kind === 'component') {
      const customId = interaction.data?.custom_id ?? '';
      const [action, runId] = customId.split(':');
      if (!runId || (action !== DISCORD_APPROVE_ACTION && action !== DISCORD_REJECT_ACTION)) {
        throw new GatewayUnsupportedPayloadError('Unrecognised Discord component interaction');
      }
      return {
        channelType: 'discord',
        tenantId,
        taskDescription: '',
        userId: actorId(interaction),
        replyContext: {
          runId,
          action: action === DISCORD_APPROVE_ACTION ? 'approve' : 'reject',
          tenantId,
        },
        channelMeta: {},
      };
    }

    throw new GatewayUnsupportedPayloadError('Unsupported Discord payload');
  }

  async sendAck(req: Request, runId: string): Promise<Response> {
    const parsed = await this.parse(req).catch(() => null);
    logger.info({ runId, kind: parsed?.kind }, 'Discord interaction acked');

    // A deferred response tells Discord "we're working on it" within its ~3s
    // budget; the real content always arrives later as a bot channel message.
    if (parsed?.kind === 'component') {
      return json({ type: RESPONSE_DEFERRED_UPDATE_MESSAGE });
    }
    return json({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE });
  }

  /** Discord interaction response visible only to the clicking member. */
  async sendDenial(req: Request, runId: string): Promise<Response> {
    const parsed = await this.parse(req).catch(() => null);
    if (parsed?.kind !== 'component') return this.sendAck(req, runId);
    return json({
      type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
      data: { content: 'You are not authorized to approve this request.', flags: 64 },
    });
  }

  // ==========================================================================
  // Outbound
  // ==========================================================================

  private meta(run: ClawRunRecord): DiscordTriggerMeta {
    return run.trigger as unknown as DiscordTriggerMeta;
  }

  private async post(run: ClawRunRecord, body: { content: string; components?: unknown[] }): Promise<void> {
    const meta = this.meta(run);
    const config = await this.getConfig(run.tenantId);
    if (!config?.botToken || !meta.channelId) {
      throw new Error('Discord run has no bot token or channel to reply through');
    }
    const res = await fetch(`${API_BASE}/channels/${meta.channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${config.botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord channel message failed (${res.status}): ${text.slice(0, 300)}`);
    }
  }

  async sendResult(run: ClawRunRecord, events: ClawRunEventRecord[]): Promise<void> {
    const answer = run.result?.answer?.trim() || 'Claw finished without producing a reply.';
    const tools = [...new Set(events.filter((e) => e.eventType === 'tool_call').map((e) => e.toolName))]
      .filter((t): t is string => !!t);
    const suffix = tools.length > 0 ? `\n\n🔧 Used ${tools.join(', ')}` : '';
    await this.post(run, { content: `${answer.slice(0, 1900)}${suffix}` });
    logger.info({ runId: run.runId }, 'Discord result delivered');
  }

  async sendError(run: ClawRunRecord, error: string): Promise<void> {
    await this.post(run, { content: `⚠️ ${error}` });
  }

  async sendClarification(run: ClawRunRecord, question: string): Promise<void> {
    // hilCapabilities.clarification is false, so the notification router
    // never actually calls this — implemented anyway so an accidental call
    // does something reasonable instead of throwing.
    await this.post(run, { content: `💬 ${question}\n\n(Replies aren't monitored on Discord — check the dashboard.)` });
  }

  async sendApprovalRequest(run: ClawRunRecord, request: ApprovalRequest): Promise<void> {
    const summary =
      request.kind === 'tool'
        ? `Claw wants to run: **${(request.pendingTools ?? []).join(', ')}**`
        : 'Claw wants approval for this plan:';
    const detail =
      request.kind === 'plan' && request.planSteps?.length
        ? '\n' + request.planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : '';

    await this.post(run, {
      content: `${summary}${detail}`.slice(0, 1900),
      components: [
        {
          type: 1, // Action Row
          components: [
            { type: 2, style: 3, label: 'Approve', custom_id: `${DISCORD_APPROVE_ACTION}:${run.runId}` },
            { type: 2, style: 4, label: 'Reject', custom_id: `${DISCORD_REJECT_ACTION}:${run.runId}` },
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
