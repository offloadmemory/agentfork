/**
 * Covers both halves of DiscordConnector: outbound (verifyCredentials, the
 * bot-token channel-message calls) and inbound (Ed25519 signature verification,
 * PING handshake, slash-command and button-click disambiguation) — the same
 * split gateway-adapters.test.ts uses for Slack/Telegram.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import nacl from 'tweetnacl';

const { mockGetRaw, mockResolveTenant } = vi.hoisted(() => ({
  mockGetRaw: vi.fn(),
  mockResolveTenant: vi.fn(),
}));

vi.mock('@chatbot/shared', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  TenantConfigService: vi.fn(),
  EncryptionService: vi.fn(),
}));

vi.mock('../config-service', () => ({
  ClawConnectorConfigService: vi.fn().mockImplementation(() => ({ getRaw: mockGetRaw })),
}));

vi.mock('../../gateway/channel-link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../gateway/channel-link')>();
  return { ...actual, resolveTenantByExternalId: mockResolveTenant };
});

import { DiscordConnector, DISCORD_APPROVE_ACTION, DISCORD_REJECT_ACTION } from './discord';
import type { ClawRunRecord } from '../../gateway/types';

const keyPair = nacl.sign.keyPair();
const PUBLIC_KEY_HEX = Buffer.from(keyPair.publicKey).toString('hex');
const APPLICATION_ID = '1234567890';

function signedRequest(bodyObj: unknown, options: { timestamp?: string; corrupt?: boolean } = {}): Request {
  const body = JSON.stringify(bodyObj);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const message = Buffer.from(timestamp + body);
  const signature = Buffer.from(nacl.sign.detached(message, keyPair.secretKey));
  if (options.corrupt) signature[0] ^= 0xff;

  return new Request('https://mc.example.com/api/gateway/discord', {
    method: 'POST',
    headers: {
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signature.toString('hex'),
      'content-type': 'application/json',
    },
    body,
  });
}

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
}

describe('DiscordConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRaw.mockResolvedValue(null);
    mockResolveTenant.mockResolvedValue('tenant1');
  });

  it('declares callback delivery with approval buttons but no clarification (no inbound path for plain messages)', () => {
    const c = new DiscordConnector();
    expect(c.channelType).toBe('discord');
    expect(c.deliveryMode).toBe('callback');
    expect(c.hilCapabilities).toEqual({ clarification: false, approvalButtons: true, threadedReplies: false });
  });

  describe('verifyCredentials', () => {
    it('fails fast without calling Discord when required fields are missing', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const result = await new DiscordConnector().verifyCredentials('t1');
      expect(result).toEqual({ ok: false, error: expect.stringContaining('bot token is required') });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('succeeds and surfaces the bot username', async () => {
      vi.stubGlobal('fetch', mockFetchOnce({ id: 'bot1', username: 'claw-bot' }));
      const result = await new DiscordConnector().verifyCredentials('t1', {
        botToken: 'discord-token',
        applicationId: APPLICATION_ID,
        publicKey: PUBLIC_KEY_HEX,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.detail).toContain('claw-bot');
    });

    it('surfaces Discord\'s rejection of a bad token', async () => {
      vi.stubGlobal('fetch', mockFetchOnce({ message: '401: Unauthorized' }, false, 401));
      const result = await new DiscordConnector().verifyCredentials('t1', {
        botToken: 'bad',
        applicationId: APPLICATION_ID,
        publicKey: PUBLIC_KEY_HEX,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('401');
    });
  });

  describe('inbound: PING handshake (preflight)', () => {
    beforeEach(() => {
      mockGetRaw.mockResolvedValue({ enabled: true, applicationId: APPLICATION_ID, publicKey: PUBLIC_KEY_HEX, botToken: 'bt' });
    });

    it('answers a validly signed PING with PONG', async () => {
      const req = signedRequest({ type: 1, application_id: APPLICATION_ID });
      const res = await new DiscordConnector().preflight(req);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(await res!.json()).toEqual({ type: 1 });
    });

    it('rejects a PING with a tampered signature', async () => {
      const req = signedRequest({ type: 1, application_id: APPLICATION_ID }, { corrupt: true });
      const res = await new DiscordConnector().preflight(req);
      expect(res!.status).toBe(401);
    });

    it('returns null (not a handshake) for a non-PING interaction', async () => {
      const req = signedRequest({ type: 2, application_id: APPLICATION_ID });
      const res = await new DiscordConnector().preflight(req);
      expect(res).toBeNull();
    });
  });

  describe('inbound: validateRequest', () => {
    it('rejects when no tenant is linked for the application id', async () => {
      mockResolveTenant.mockResolvedValue(null);
      const req = signedRequest({ type: 2, application_id: APPLICATION_ID });
      expect(await new DiscordConnector().validateRequest(req)).toBe(false);
    });

    it('rejects a tampered signature', async () => {
      mockGetRaw.mockResolvedValue({ enabled: true, applicationId: APPLICATION_ID, publicKey: PUBLIC_KEY_HEX, botToken: 'bt' });
      const req = signedRequest({ type: 2, application_id: APPLICATION_ID }, { corrupt: true });
      expect(await new DiscordConnector().validateRequest(req)).toBe(false);
    });

    it('accepts a validly signed command interaction', async () => {
      mockGetRaw.mockResolvedValue({ enabled: true, applicationId: APPLICATION_ID, publicKey: PUBLIC_KEY_HEX, botToken: 'bt' });
      const req = signedRequest({ type: 2, application_id: APPLICATION_ID });
      expect(await new DiscordConnector().validateRequest(req)).toBe(true);
    });
  });

  describe('inbound: parseInbound', () => {
    it('parses a /claw slash command into a new-run message', async () => {
      const req = signedRequest({
        type: 2,
        application_id: APPLICATION_ID,
        channel_id: 'C1',
        guild_id: 'G1',
        data: { name: 'claw', options: [{ name: 'prompt', value: 'summarise the incident' }] },
        member: { user: { id: 'U1', username: 'ada' } },
      });
      const msg = await new DiscordConnector().parseInbound(req);
      expect(msg.taskDescription).toBe('summarise the incident');
      expect(msg.userId).toBe('U1');
      expect(msg.channelMeta).toMatchObject({ userId: 'U1', userName: 'ada', channelId: 'C1', guildId: 'G1' });
    });

    it('rejects a slash command with an unrecognised name', async () => {
      const req = signedRequest({ type: 2, application_id: APPLICATION_ID, data: { name: 'other' } });
      await expect(new DiscordConnector().parseInbound(req)).rejects.toThrow();
    });

    it('parses an approve button click into a replyContext', async () => {
      const req = signedRequest({
        type: 3,
        application_id: APPLICATION_ID,
        data: { custom_id: `${DISCORD_APPROVE_ACTION}:run-123` },
        member: { user: { id: 'U1' } },
      });
      const msg = await new DiscordConnector().parseInbound(req);
      expect(msg.replyContext).toEqual({ runId: 'run-123', action: 'approve', tenantId: 'tenant1' });
    });

    it('parses a reject button click into a replyContext', async () => {
      const req = signedRequest({
        type: 3,
        application_id: APPLICATION_ID,
        data: { custom_id: `${DISCORD_REJECT_ACTION}:run-123` },
      });
      const msg = await new DiscordConnector().parseInbound(req);
      expect(msg.replyContext).toEqual({ runId: 'run-123', action: 'reject', tenantId: 'tenant1' });
    });
  });

  describe('sendAck', () => {
    it('returns a deferred-channel-message response for a slash command', async () => {
      const req = signedRequest({ type: 2, application_id: APPLICATION_ID });
      const res = await new DiscordConnector().sendAck(req, 'run-1');
      expect(await res.json()).toEqual({ type: 5 });
    });

    it('returns a deferred-update-message response for a button click', async () => {
      const req = signedRequest({ type: 3, application_id: APPLICATION_ID, data: { custom_id: 'x:y' } });
      const res = await new DiscordConnector().sendAck(req, 'run-1');
      expect(await res.json()).toEqual({ type: 6 });
    });
  });

  describe('sendDenial', () => {
    it('returns an ephemeral interaction response visible only to the actor', async () => {
      const req = signedRequest({
        type: 3, application_id: APPLICATION_ID, data: { custom_id: 'x:y' },
      });
      const res = await new DiscordConnector().sendDenial(req, 'run-1');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        type: 4,
        data: { flags: 64, content: expect.stringContaining('not authorized') },
      });
    });
  });

  describe('outbound', () => {
    const run: ClawRunRecord = {
      id: '1',
      tenantId: 't1',
      runId: 'run-1',
      source: 'discord',
      status: 'completed',
      taskDescription: 'do the thing',
      threadId: 'thread-1',
      trigger: { channelId: 'C1', guildId: 'G1', userId: 'U1' },
      result: { answer: 'All done.' },
      clarification: null,
      approvalRequest: null,
      error: null,
      userId: 'U1',
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    };

    beforeEach(() => {
      mockGetRaw.mockResolvedValue({ enabled: true, applicationId: APPLICATION_ID, publicKey: PUBLIC_KEY_HEX, botToken: 'bot-token' });
    });

    it('posts the result as a bot-authenticated channel message', async () => {
      const fetchSpy = mockFetchOnce({ id: 'm1' });
      vi.stubGlobal('fetch', fetchSpy);
      await new DiscordConnector().sendResult(run, []);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://discord.com/api/v10/channels/C1/messages',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bot bot-token' }) }),
      );
      const [, init] = fetchSpy.mock.calls[0];
      expect(JSON.parse(init.body).content).toContain('All done.');
    });

    it('includes approve/reject buttons keyed by the run id', async () => {
      const fetchSpy = mockFetchOnce({ id: 'm1' });
      vi.stubGlobal('fetch', fetchSpy);
      await new DiscordConnector().sendApprovalRequest(run, { kind: 'tool', pendingTools: ['github_create_issue'] });
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.components[0].components).toEqual([
        { type: 2, style: 3, label: 'Approve', custom_id: `${DISCORD_APPROVE_ACTION}:run-1` },
        { type: 2, style: 4, label: 'Reject', custom_id: `${DISCORD_REJECT_ACTION}:run-1` },
      ]);
    });

    it('throws a clear error when there is no bot token to reply through', async () => {
      mockGetRaw.mockResolvedValue({ enabled: true, applicationId: APPLICATION_ID, publicKey: PUBLIC_KEY_HEX });
      await expect(new DiscordConnector().sendResult(run, [])).rejects.toThrow(/bot token/);
    });
  });
});
