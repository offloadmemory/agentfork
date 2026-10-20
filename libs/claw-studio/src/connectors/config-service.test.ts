import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, Record<string, unknown>>();

const mockGet = vi.fn(async (key: string) => store.get(key) ?? null);
const mockSet = vi.fn(async (key: string, value: Record<string, unknown>) => {
  store.set(key, value);
});
const mockDelete = vi.fn(async (key: string) => {
  store.delete(key);
});

// Reversible stand-in for AES-GCM: the service's contract is "secrets are not
// stored verbatim and round-trip correctly", which this exercises without
// depending on ENCRYPTION_KEY being present in the test environment.
let encryptionAvailable = true;
const mockEncrypt = vi.fn((plain: string) => `enc(${plain})`);
const mockDecrypt = vi.fn((cipher: string) => {
  const match = /^enc\((.*)\)$/.exec(cipher);
  if (!match) throw new Error('Invalid encrypted format');
  return match[1];
});

vi.mock('@chatbot/shared', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  TenantConfigService: vi.fn().mockImplementation(() => ({
    get: mockGet,
    set: mockSet,
    delete: mockDelete,
  })),
  EncryptionService: vi.fn().mockImplementation(() => {
    if (!encryptionAvailable) throw new Error('ENCRYPTION_KEY must be a 64-character hex string');
    return { encrypt: mockEncrypt, decrypt: mockDecrypt };
  }),
}));

import {
  ClawConnectorConfigService,
  ConnectorEncryptionUnavailableError,
  configKeyFor,
} from './config-service';

const KEY = configKeyFor('telegram');

describe('ClawConnectorConfigService', () => {
  beforeEach(() => {
    store.clear();
    encryptionAvailable = true;
    vi.clearAllMocks();
  });

  it('encrypts secret fields before storing them', async () => {
    const svc = new ClawConnectorConfigService('tenant-1');
    await svc.save('telegram', { botToken: 'bot-123', secretToken: 'sek-456', enabled: true });

    const stored = store.get(KEY)!;
    expect(stored.botToken).toBe('enc(bot-123)');
    expect(stored.secretToken).toBe('enc(sek-456)');
    expect(stored.botToken).not.toBe('bot-123');
    expect(stored.enabled).toBe(true);
  });

  it('round-trips through getRaw', async () => {
    const svc = new ClawConnectorConfigService('tenant-1');
    await svc.save('telegram', { botToken: 'bot-123', secretToken: 'sek-456', enabled: true });

    expect(await svc.getRaw('telegram')).toMatchObject({
      botToken: 'bot-123',
      secretToken: 'sek-456',
      enabled: true,
    });
  });

  it('round-trips, lists and clears approver IDs without encrypting public IDs', async () => {
    const svc = new ClawConnectorConfigService('tenant-1');
    await svc.save('telegram', { approverIds: ['42', '43', '42'] });
    expect(await svc.getRaw('telegram')).toMatchObject({ approverIds: ['42', '43'] });
    expect((await svc.getMasked('telegram')).fields.approverIds).toBe('42, 43');
    await svc.save('telegram', { enabled: false });
    expect(await svc.getRaw('telegram')).toMatchObject({ approverIds: ['42', '43'] });
    await svc.save('telegram', { approverIds: [] });
    expect(await svc.getRaw('telegram')).toMatchObject({ approverIds: [] });
  });

  it('rejects malformed approver IDs before saving', async () => {
    const svc = new ClawConnectorConfigService('tenant-1');
    await expect(svc.save('telegram', { approverIds: [''] })).rejects.toThrow('Invalid approverIds');
    await expect(svc.save('telegram', { approverIds: Array(51).fill('1') })).rejects.toThrow('Invalid approverIds');
  });

  it('returns null from getRaw when the channel was never configured', async () => {
    expect(await new ClawConnectorConfigService('tenant-1').getRaw('telegram')).toBeNull();
  });

  it('keeps the stored secret when an incoming field is blank or omitted', async () => {
    const svc = new ClawConnectorConfigService('tenant-1');
    await svc.save('telegram', { botToken: 'original', secretToken: 'sek', enabled: true });

    // Blank string and absent key must both mean "leave it alone".
    await svc.save('telegram', { botToken: '   ', enabled: true });

    expect(await svc.getRaw('telegram')).toMatchObject({ botToken: 'original', secretToken: 'sek' });
  });

  it('replaces the stored secret when a non-blank value is supplied', async () => {
    const svc = new ClawConnectorConfigService('tenant-1');
    await svc.save('telegram', { botToken: 'original', secretToken: 'sek', enabled: true });
    await svc.save('telegram', { botToken: 'rotated', enabled: true });

    expect(await svc.getRaw('telegram')).toMatchObject({ botToken: 'rotated' });
  });

  it('can toggle enabled to false without resupplying credentials', async () => {
    const svc = new ClawConnectorConfigService('tenant-1');
    await svc.save('telegram', { botToken: 'bot-123', secretToken: 'sek', enabled: true });
    await svc.save('telegram', { enabled: false });

    const config = await svc.getRaw('telegram');
    expect(config).toMatchObject({ enabled: false, botToken: 'bot-123' });
  });

  it('never exposes plaintext through getMasked', async () => {
    const svc = new ClawConnectorConfigService('tenant-1');
    await svc.save('telegram', { botToken: '123456:ABCDEFGHIJKLMNOP', secretToken: 'sek', enabled: true });

    const masked = await svc.getMasked('telegram');
    expect(masked.configured).toBe(true);
    expect(masked.enabled).toBe(true);
    expect(masked.fields.botToken).toBe('1234****MNOP');
    expect(JSON.stringify(masked)).not.toContain('ABCDEFGHIJKLMNOP');
  });

  it('reports not-configured for a channel with no stored row', async () => {
    const masked = await new ClawConnectorConfigService('tenant-1').getMasked('telegram');
    expect(masked).toEqual({ channel: 'telegram', configured: false, enabled: false, fields: {} });
  });

  it('treats an undecryptable secret as absent rather than leaking ciphertext', async () => {
    store.set(KEY, { enabled: true, botToken: 'not-valid-ciphertext', secretToken: 'enc(sek)' });

    const svc = new ClawConnectorConfigService('tenant-1');
    expect(await svc.getRaw('telegram')).not.toHaveProperty('botToken');

    const masked = await svc.getMasked('telegram');
    expect(masked.fields).not.toHaveProperty('botToken');
    expect(masked.fields.secretToken).toBe('********');
  });

  it('deletes the row on reset', async () => {
    const svc = new ClawConnectorConfigService('tenant-1');
    await svc.save('telegram', { botToken: 'bot-123', secretToken: 'sek', enabled: true });
    await svc.reset('telegram');

    expect(mockDelete).toHaveBeenCalledWith(KEY);
    expect(await svc.getRaw('telegram')).toBeNull();
  });

  it('surfaces a actionable error when ENCRYPTION_KEY is missing', async () => {
    encryptionAvailable = false;
    const svc = new ClawConnectorConfigService('tenant-1');

    await expect(svc.save('telegram', { botToken: 'x' })).rejects.toBeInstanceOf(
      ConnectorEncryptionUnavailableError,
    );
    await expect(svc.save('telegram', { botToken: 'x' })).rejects.toThrow(/ENCRYPTION_KEY/);
  });

  it('lists connectors without needing encryption when nothing is stored', async () => {
    encryptionAvailable = false;
    // No row => no decryption needed => must not throw, so the Connectors page
    // still renders on a deployment that has not set ENCRYPTION_KEY yet.
    await expect(new ClawConnectorConfigService('t').getMasked('telegram')).resolves.toMatchObject({
      configured: false,
    });
  });
});
