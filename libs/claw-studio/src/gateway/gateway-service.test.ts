import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRegistry, mockRunService, mockConnectorConfigService, adapter } = vi.hoisted(() => {
  const adapter = {
    channelType: 'slack',
    displayName: 'Slack',
    description: '',
    deliveryMode: 'callback',
    hilCapabilities: { clarification: true, approvalButtons: true, threadedReplies: true },
    getConfig: vi.fn(),
    verifyCredentials: vi.fn(),
    preflight: vi.fn(async () => null),
    validateRequest: vi.fn(async () => true),
    parseInbound: vi.fn(),
    sendAck: vi.fn(async () => new Response('acked', { status: 200 })),
    sendResult: vi.fn(),
    sendError: vi.fn(),
    sendClarification: vi.fn(),
    sendApprovalRequest: vi.fn(),
  };
  return {
    adapter,
    mockRegistry: {
      has: vi.fn((channel: string) => channel === 'slack'),
      get: vi.fn(() => adapter),
      list: vi.fn(() => [adapter]),
    },
    mockRunService: { create: vi.fn(), get: vi.fn() },
    mockConnectorConfigService: { getRaw: vi.fn() },
  };
});

vi.mock('@chatbot/shared', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

vi.mock('../connectors/registry', () => ({ getConnectorRegistry: () => mockRegistry }));
vi.mock('./run-service', () => ({ getRunService: () => mockRunService }));
// Default (no allowlist configured) preserves the pre-existing permissive
// behavior for plain approve/reject; approve_always is covered explicitly
// below since it default-denies with no allowlist regardless.
vi.mock('../connectors/config-service', () => ({
  ClawConnectorConfigService: vi.fn(() => mockConnectorConfigService),
}));

import { handleInbound } from './gateway-service';

const enqueue = vi.fn(async () => {});
const deps = { enqueue };

function req(): Request {
  return new Request('https://mc.example.com/api/gateway/slack', { method: 'POST', body: '{}' });
}

const newRunMessage = {
  channelType: 'slack' as const,
  tenantId: 'tenant1',
  taskDescription: 'do the thing',
  userId: 'U1',
  channelMeta: { channelId: 'C1' },
};

const createdRun = { runId: 'run_new', tenantId: 'tenant1' };

beforeEach(() => {
  // clearAllMocks resets recorded calls but keeps implementations, so each
  // implementation a test overrides has to be restored explicitly here.
  vi.clearAllMocks();
  enqueue.mockResolvedValue(undefined);
  adapter.preflight.mockResolvedValue(null);
  adapter.validateRequest.mockResolvedValue(true);
  adapter.sendAck.mockResolvedValue(new Response('acked', { status: 200 }));
  adapter.getConfig.mockResolvedValue({ enabled: true });
  adapter.parseInbound.mockResolvedValue(newRunMessage);
  mockRunService.create.mockResolvedValue(createdRun);
  // No allowlist configured by default.
  mockConnectorConfigService.getRaw.mockResolvedValue(null);
});

describe('handleInbound', () => {
  it('404s an unregistered channel without touching any adapter', async () => {
    const res = await handleInbound('discord', req(), deps);
    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns a platform handshake before validating or resolving a tenant', async () => {
    adapter.preflight.mockResolvedValue(new Response('challenge', { status: 200 }));

    const res = await handleInbound('slack', req(), deps);

    await expect(res.text()).resolves.toBe('challenge');
    expect(adapter.validateRequest).not.toHaveBeenCalled();
  });

  it('401s an invalid signature and never creates a run', async () => {
    adapter.validateRequest.mockResolvedValue(false);

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(401);
    expect(mockRunService.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('creates a run, enqueues it, then acks — in that order', async () => {
    const order: string[] = [];
    mockRunService.create.mockImplementation(async () => {
      order.push('create');
      return createdRun;
    });
    enqueue.mockImplementation(async () => {
      order.push('enqueue');
    });
    adapter.sendAck.mockImplementation(async () => {
      order.push('ack');
      return new Response('acked', { status: 200 });
    });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    // Enqueue before ack: acking first would promise the user a run that might
    // never be queued.
    expect(order).toEqual(['create', 'enqueue', 'ack']);
    // A fresh run has no approver decision to attribute — approvedBy is
    // only threaded through on a HIL resume.
    expect(enqueue).toHaveBeenCalledWith({ runId: 'run_new', tenantId: 'tenant1' });
  });

  it('403s when the connector is configured but switched off', async () => {
    adapter.getConfig.mockResolvedValue({ enabled: false });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(403);
    expect(mockRunService.create).not.toHaveBeenCalled();
  });

  it('403s when the channel has no stored config at all', async () => {
    adapter.getConfig.mockResolvedValue(null);
    const res = await handleInbound('slack', req(), deps);
    expect(res.status).toBe(403);
  });

  it('400s an empty task rather than starting a run with nothing to do', async () => {
    adapter.parseInbound.mockResolvedValue({ ...newRunMessage, taskDescription: '   ' });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(400);
    expect(mockRunService.create).not.toHaveBeenCalled();
  });

  it('404s when the inbound identifier maps to no tenant', async () => {
    const { GatewayTenantUnresolvedError } = await import('./gateway-service');
    adapter.parseInbound.mockRejectedValue(new GatewayTenantUnresolvedError('slack'));

    const res = await handleInbound('slack', req(), deps);
    expect(res.status).toBe(404);
  });

  it('200s an unsupported payload — the platform must not retry noise it will keep resending', async () => {
    const { GatewayUnsupportedPayloadError } = await import('./gateway-service');
    adapter.parseInbound.mockRejectedValue(new GatewayUnsupportedPayloadError('a bot message'));

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ignored: 'a bot message' });
  });

  it('500s if the queue is unreachable, so the caller learns the run will not happen', async () => {
    enqueue.mockRejectedValue(new Error('queue down'));

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(500);
  });
});

describe('handleInbound — HIL resume', () => {
  const replyMessage = {
    ...newRunMessage,
    taskDescription: '',
    replyContext: { runId: 'run_existing', action: 'approve' as const, tenantId: 'tenant1' },
  };

  beforeEach(() => {
    adapter.parseInbound.mockResolvedValue(replyMessage);
  });

  it('queues an approve for a run that is awaiting approval', async () => {
    mockRunService.get.mockResolvedValue({
      runId: 'run_existing',
      tenantId: 'tenant1',
      status: 'awaiting_approval',
    });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith({
      runId: 'run_existing',
      tenantId: 'tenant1',
      action: 'approve',
      content: undefined,
      approvedBy: 'U1',
    });
    // A resume must never create a second run.
    expect(mockRunService.create).not.toHaveBeenCalled();
  });

  it('refuses a run belonging to another tenant even though the signature was valid', async () => {
    mockRunService.get.mockResolvedValue({
      runId: 'run_existing',
      tenantId: 'someone-else',
      status: 'awaiting_approval',
    });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('404s a run that no longer exists', async () => {
    mockRunService.get.mockResolvedValue(null);

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(404);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('acks without queueing when the run already finished — a double-tapped button is not an error', async () => {
    mockRunService.get.mockResolvedValue({
      runId: 'run_existing',
      tenantId: 'tenant1',
      status: 'completed',
    });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores an approve for a run that is not waiting on approval', async () => {
    mockRunService.get.mockResolvedValue({
      runId: 'run_existing',
      tenantId: 'tenant1',
      status: 'in_progress',
    });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues a clarification reply with its content', async () => {
    adapter.parseInbound.mockResolvedValue({
      ...replyMessage,
      replyContext: {
        runId: 'run_existing',
        action: 'clarification_response' as const,
        content: 'the blue one',
        tenantId: 'tenant1',
      },
    });
    mockRunService.get.mockResolvedValue({
      runId: 'run_existing',
      tenantId: 'tenant1',
      status: 'awaiting_input',
    });

    await handleInbound('slack', req(), deps);

    expect(enqueue).toHaveBeenCalledWith({
      runId: 'run_existing',
      tenantId: 'tenant1',
      action: 'clarification_response',
      content: 'the blue one',
      approvedBy: 'U1',
    });
  });

  it('400s a blank clarification reply', async () => {
    adapter.parseInbound.mockResolvedValue({
      ...replyMessage,
      replyContext: {
        runId: 'run_existing',
        action: 'clarification_response' as const,
        content: '   ',
        tenantId: 'tenant1',
      },
    });
    mockRunService.get.mockResolvedValue({
      runId: 'run_existing',
      tenantId: 'tenant1',
      status: 'awaiting_input',
    });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('handleInbound — HIL resume — approver allowlist', () => {
  const replyMessage = {
    ...newRunMessage,
    taskDescription: '',
    replyContext: { runId: 'run_existing', action: 'approve' as const, tenantId: 'tenant1' },
  };

  beforeEach(() => {
    adapter.parseInbound.mockResolvedValue(replyMessage);
    mockRunService.get.mockResolvedValue({
      runId: 'run_existing',
      tenantId: 'tenant1',
      status: 'awaiting_approval',
    });
  });

  it('ignores an approve from a user who is not on the configured allowlist', async () => {
    mockConnectorConfigService.getRaw.mockResolvedValue({ approverIds: ['someone-else'] });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues an approve from a user who is on the configured allowlist', async () => {
    mockConnectorConfigService.getRaw.mockResolvedValue({ approverIds: ['U1', 'U2'] });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_existing', action: 'approve', approvedBy: 'U1' }),
    );
  });

  it('queues a plain approve with no allowlist configured — unchanged back-compat behavior', async () => {
    mockConnectorConfigService.getRaw.mockResolvedValue(null);

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_existing', action: 'approve', approvedBy: 'U1' }),
    );
  });

  it('ignores approve_always with no allowlist configured — a standing grant needs one', async () => {
    mockConnectorConfigService.getRaw.mockResolvedValue(null);
    adapter.parseInbound.mockResolvedValue({
      ...replyMessage,
      replyContext: { ...replyMessage.replyContext, action: 'approve_always' as const },
    });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues approve_always once an allowlist is configured and the user is on it', async () => {
    mockConnectorConfigService.getRaw.mockResolvedValue({ approverIds: ['U1'] });
    adapter.parseInbound.mockResolvedValue({
      ...replyMessage,
      replyContext: { ...replyMessage.replyContext, action: 'approve_always' as const },
    });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve_always', approvedBy: 'U1' }),
    );
  });

  it('ignores a reject from a user who is not on the configured allowlist', async () => {
    mockConnectorConfigService.getRaw.mockResolvedValue({ approverIds: ['someone-else'] });
    adapter.parseInbound.mockResolvedValue({
      ...replyMessage,
      replyContext: { ...replyMessage.replyContext, action: 'reject' as const },
    });

    const res = await handleInbound('slack', req(), deps);

    expect(res.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
