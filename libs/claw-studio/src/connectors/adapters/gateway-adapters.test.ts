/**
 * Inbound half of the adapters: signature verification, tenant resolution from
 * platform-native ids, and payload disambiguation. These are the paths where a
 * mistake is a security bug rather than a bad message, so they're covered
 * directly rather than through the gateway service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// Hoisted: vi.mock factories are lifted above normal top-level declarations, so
// plain consts would be uninitialised when the factory runs.
const { mockGetRaw, mockResolveTenant, mockFindByTriggerField } = vi.hoisted(() => ({
  mockGetRaw: vi.fn(),
  mockResolveTenant: vi.fn(),
  mockFindByTriggerField: vi.fn(),
}));

vi.mock('@chatbot/shared', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  TenantConfigService: vi.fn(),
  EncryptionService: vi.fn(),
  getPrismaClient: vi.fn(),
}));

vi.mock('../config-service', () => ({
  ClawConnectorConfigService: vi.fn().mockImplementation(() => ({ getRaw: mockGetRaw })),
}));

vi.mock('../../gateway/channel-link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../gateway/channel-link')>();
  return { ...actual, resolveTenantByExternalId: mockResolveTenant };
});

vi.mock('../../gateway/run-service', () => ({
  getRunService: () => ({ findByTriggerField: mockFindByTriggerField, mergeTrigger: vi.fn() }),
}));

import { SlackConnector } from './slack';
import { TelegramConnector } from './telegram';
import { hashExternalId } from '../../gateway/channel-link';

const SIGNING_SECRET = 'slack-signing-secret';

function slackRequest(body: string, options: { secret?: string; timestamp?: number } = {}): Request {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const signature =
    'v0=' +
    crypto
      .createHmac('sha256', options.secret ?? SIGNING_SECRET)
      .update(`v0:${timestamp}:${body}`)
      .digest('hex');

  return new Request('https://mc.example.com/api/gateway/slack', {
    method: 'POST',
    headers: {
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': signature,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
}

const slashBody = new URLSearchParams({
  command: '/claw',
  text: 'summarise the incident',
  team_id: 'T123',
  user_id: 'U1',
  user_name: 'ada',
  channel_id: 'C1',
  channel_name: 'ops',
  response_url: 'https://hooks.slack.com/commands/1',
}).toString();

describe('SlackConnector inbound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRaw.mockResolvedValue({ enabled: true, signingSecret: SIGNING_SECRET, botToken: 'xoxb-1' });
    mockResolveTenant.mockResolvedValue('tenant1');
  });

  it('accepts a correctly signed slash command', async () => {
    await expect(new SlackConnector().validateRequest(slackRequest(slashBody))).resolves.toBe(true);
  });

  it('rejects a body signed with the wrong secret', async () => {
    const req = slackRequest(slashBody, { secret: 'not-the-secret' });
    await expect(new SlackConnector().validateRequest(req)).resolves.toBe(false);
  });

  it('rejects a replayed request outside the five-minute window', async () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    await expect(new SlackConnector().validateRequest(slackRequest(slashBody, { timestamp: stale }))).resolves.toBe(
      false,
    );
  });

  it('rejects a request with no signature headers at all', async () => {
    const req = new Request('https://mc.example.com/api/gateway/slack', { method: 'POST', body: slashBody });
    await expect(new SlackConnector().validateRequest(req)).resolves.toBe(false);
  });

  it('rejects a workspace that is not linked to any tenant — there is no secret to verify against', async () => {
    mockResolveTenant.mockResolvedValue(null);
    await expect(new SlackConnector().validateRequest(slackRequest(slashBody))).resolves.toBe(false);
  });

  it('parses a slash command into a new-run message carrying the trigger metadata', async () => {
    const message = await new SlackConnector().parseInbound(slackRequest(slashBody));
    expect(message).toMatchObject({
      channelType: 'slack',
      tenantId: 'tenant1',
      taskDescription: 'summarise the incident',
      userId: 'U1',
    });
    expect(message.channelMeta).toMatchObject({
      channelId: 'C1',
      responseUrl: 'https://hooks.slack.com/commands/1',
      teamId: 'T123',
    });
    expect(message.replyContext).toBeUndefined();
  });

  it('parses an Approve button press into an approve reply for that run', async () => {
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T123' },
        user: { id: 'U9' },
        actions: [{ action_id: 'claw_approve', value: 'run_xyz' }],
      }),
    }).toString();

    const message = await new SlackConnector().parseInbound(slackRequest(body));
    expect(message.replyContext).toEqual({ runId: 'run_xyz', action: 'approve', tenantId: 'tenant1' });
  });

  it('parses a Reject button press into a reject reply', async () => {
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T123' },
        actions: [{ action_id: 'claw_reject', value: 'run_xyz' }],
      }),
    }).toString();

    const message = await new SlackConnector().parseInbound(slackRequest(body));
    expect(message.replyContext?.action).toBe('reject');
  });

  it('rejects an interaction whose action_id is not one of ours', async () => {
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T123' },
        actions: [{ action_id: 'someone_elses_button', value: 'run_xyz' }],
      }),
    }).toString();

    await expect(new SlackConnector().parseInbound(slackRequest(body))).rejects.toThrow(
      /Unrecognised Slack interaction/,
    );
  });

  it('answers the url_verification handshake in preflight, before any tenant lookup', async () => {
    const req = new Request('https://mc.example.com/api/gateway/slack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
    });

    const res = await new SlackConnector().preflight(req);
    expect(res).not.toBeNull();
    await expect(res!.json()).resolves.toEqual({ challenge: 'abc123' });
    expect(mockResolveTenant).not.toHaveBeenCalled();
  });

  it('preflight passes through anything that is not a handshake', async () => {
    await expect(new SlackConnector().preflight(slackRequest(slashBody))).resolves.toBeNull();
  });

  it('turns a thread reply into a clarification response for the run waiting in that thread', async () => {
    mockFindByTriggerField.mockResolvedValue({ runId: 'run_waiting', tenantId: 'tenant1' });
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event: { type: 'message', text: 'the second one', user: 'U1', channel: 'C1', thread_ts: '111.222' },
    });

    const message = await new SlackConnector().parseInbound(slackRequest(body));
    expect(message.replyContext).toEqual({
      runId: 'run_waiting',
      action: 'clarification_response',
      content: 'the second one',
      tenantId: 'tenant1',
    });
    expect(mockFindByTriggerField).toHaveBeenCalledWith(
      expect.objectContaining({ path: ['postedTs'], value: '111.222', statuses: ['awaiting_input'] }),
    );
  });

  it('ignores the bot\'s own messages so it cannot answer itself in a loop', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event: { type: 'message', text: 'my own output', bot_id: 'B1', channel: 'C1', thread_ts: '111.222' },
    });

    await expect(new SlackConnector().parseInbound(slackRequest(body))).rejects.toThrow(/Not a user text message/);
  });

  it('ignores a thread reply when no run there is waiting for one', async () => {
    mockFindByTriggerField.mockResolvedValue(null);
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event: { type: 'message', text: 'unrelated chatter', user: 'U1', channel: 'C1', thread_ts: '999.999' },
    });

    await expect(new SlackConnector().parseInbound(slackRequest(body))).rejects.toThrow(/No run is awaiting/);
  });

  it('acks a slash command ephemerally and everything else with a bare 200', async () => {
    const connector = new SlackConnector();
    const slashAck = await connector.sendAck(slackRequest(slashBody), 'run_1');
    await expect(slashAck.json()).resolves.toMatchObject({ response_type: 'ephemeral' });

    const buttonBody = new URLSearchParams({
      payload: JSON.stringify({ type: 'block_actions', team: { id: 'T123' }, actions: [] }),
    }).toString();
    const buttonAck = await connector.sendAck(slackRequest(buttonBody), 'run_1');
    expect(buttonAck.status).toBe(200);
    await expect(buttonAck.text()).resolves.toBe('');
  });

  it('returns a private ephemeral denial without replacing Slack approval buttons', async () => {
    const buttonBody = new URLSearchParams({
      payload: JSON.stringify({ type: 'block_actions', team: { id: 'T123' }, actions: [] }),
    }).toString();
    const res = await new SlackConnector().sendDenial(slackRequest(buttonBody), 'run_1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      response_type: 'ephemeral',
      replace_original: false,
    });
  });

});

const SECRET_TOKEN = 'a-high-entropy-secret-token';

function telegramRequest(update: unknown, secret: string | null = SECRET_TOKEN): Request {
  return new Request('https://mc.example.com/api/gateway/telegram', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
    },
    body: JSON.stringify(update),
  });
}

describe('TelegramConnector inbound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRaw.mockResolvedValue({ enabled: true, botToken: '123:ABC', secretToken: SECRET_TOKEN });
    mockFindByTriggerField.mockResolvedValue(null);
    mockResolveTenant.mockImplementation(async (_channel: string, externalId: string) =>
      externalId === hashExternalId(SECRET_TOKEN) ? 'tenant1' : null,
    );
  });

  it('accepts a request whose secret token hashes to a linked tenant', async () => {
    const req = telegramRequest({ message: { text: 'hi', chat: { id: 5 } } });
    await expect(new TelegramConnector().validateRequest(req)).resolves.toBe(true);
  });

  it('rejects a request with the wrong secret token', async () => {
    const req = telegramRequest({ message: { text: 'hi', chat: { id: 5 } } }, 'wrong-secret');
    await expect(new TelegramConnector().validateRequest(req)).resolves.toBe(false);
  });

  it('rejects a request with no secret token header', async () => {
    const req = telegramRequest({ message: { text: 'hi', chat: { id: 5 } } }, null);
    await expect(new TelegramConnector().validateRequest(req)).resolves.toBe(false);
  });

  it('parses a plain message into a new run with the chat id remembered', async () => {
    const req = telegramRequest({
      message: { message_id: 7, text: 'check the deploy', from: { id: 42 }, chat: { id: 5 } },
    });

    const message = await new TelegramConnector().parseInbound(req);
    expect(message).toMatchObject({ tenantId: 'tenant1', taskDescription: 'check the deploy', userId: '42' });
    expect(message.channelMeta).toMatchObject({ chatId: 5, userId: 42, messageId: 7 });
  });

  it('strips a leading bot command so the slash word never reaches the model', async () => {
    const req = telegramRequest({ message: { text: '/claw@mybot fix the thing', chat: { id: 5 }, from: { id: 42 } } });
    const message = await new TelegramConnector().parseInbound(req);
    expect(message.taskDescription).toBe('fix the thing');
  });

  it('keeps the original text when stripping the command would leave nothing', async () => {
    const req = telegramRequest({ message: { text: '/status', chat: { id: 5 }, from: { id: 42 } } });
    const message = await new TelegramConnector().parseInbound(req);
    expect(message.taskDescription).toBe('/status');
  });

  it('treats a message as a clarification reply when a run in that chat is waiting', async () => {
    mockFindByTriggerField.mockResolvedValue({ runId: 'run_waiting', tenantId: 'tenant1' });
    const req = telegramRequest({ message: { text: 'the blue one', chat: { id: 5 }, from: { id: 42 } } });

    const message = await new TelegramConnector().parseInbound(req);
    expect(message.replyContext).toEqual({
      runId: 'run_waiting',
      action: 'clarification_response',
      content: 'the blue one',
      tenantId: 'tenant1',
    });
  });

  it('parses an inline-keyboard press into the matching decision', async () => {
    const req = telegramRequest({
      callback_query: { id: 'cb1', data: 'claw:approve:run_xyz', from: { id: 42 }, message: { chat: { id: 5 } } },
    });

    const message = await new TelegramConnector().parseInbound(req);
    expect(message.replyContext).toEqual({ runId: 'run_xyz', action: 'approve', tenantId: 'tenant1' });
  });

  it('ignores callback data that is not ours', async () => {
    const req = telegramRequest({ callback_query: { id: 'cb1', data: 'other:thing:1' } });
    await expect(new TelegramConnector().parseInbound(req)).rejects.toThrow(/Unrecognised Telegram callback/);
  });

  it('ignores messages sent by bots', async () => {
    const req = telegramRequest({ message: { text: 'beep', chat: { id: 5 }, from: { id: 1, is_bot: true } } });
    await expect(new TelegramConnector().parseInbound(req)).rejects.toThrow(/Not a user text message/);
  });

  it('answers a denied Telegram callback privately without posting to the chat', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    );
    try {
      const req = telegramRequest({
        callback_query: { id: 'cb1', data: 'claw:approve:run_xyz', from: { id: 42 } },
      });
      const res = await new TelegramConnector().sendDenial(req, 'run_xyz');
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/answerCallbackQuery'),
        expect.objectContaining({ body: expect.stringContaining('not authorized') }),
      );
      expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining('/sendMessage'), expect.anything());
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps the approve callback payload inside Telegram\'s 64-byte limit', () => {
    const runId = `run_${'x'.repeat(22)}`;
    expect(Buffer.byteLength(`claw:approve:${runId}`)).toBeLessThanOrEqual(64);
  });
});
