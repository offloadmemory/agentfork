/**
 * config-service.ts — per-tenant connector credential storage.
 *
 * Follows the design reference (§5, §6): one `TenantConfig` row per channel per
 * tenant, keyed `claw-connector-<channel>`. Secret fields are AES-256-GCM
 * encrypted at rest via the shared EncryptionService and masked on read; the
 * "leave blank to keep existing" rule means a blank incoming field can never
 * clobber a stored secret.
 */

import { TenantConfigService, EncryptionService, createLogger } from '@chatbot/shared';
import { maskSecret } from './mask';
import { SECRET_FIELDS, type ChannelType, type ConnectorConfig } from './types';

const logger = createLogger('claw-studio:connector-config');

export function configKeyFor(channel: ChannelType): string {
  return `claw-connector-${channel}`;
}

export class ConnectorEncryptionUnavailableError extends Error {
  constructor() {
    super(
      'Connectors require ENCRYPTION_KEY to be set (64 hex characters). ' +
        'Generate one with: openssl rand -hex 32',
    );
    this.name = 'ConnectorEncryptionUnavailableError';
  }
}

export interface MaskedConnectorConfig {
  channel: ChannelType;
  configured: boolean;
  enabled: boolean;
  /** Secret fields are masked; non-secret fields are verbatim. Absent fields are omitted. */
  fields: Record<string, string>;
}

/** A stored value that failed to decrypt is unusable — surface it as absent rather than as ciphertext. */
function safeDecrypt(enc: EncryptionService, value: string, context: string): string | null {
  try {
    return enc.decrypt(value);
  } catch (error) {
    logger.error({ error, context }, 'Failed to decrypt connector secret — treating as unset');
    return null;
  }
}

export class ClawConnectorConfigService {
  private readonly configs: TenantConfigService;
  private readonly tenantId: string;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
    this.configs = new TenantConfigService(tenantId);
  }

  /**
   * Constructed lazily so that merely listing connectors (which needs no
   * decryption) doesn't fail on a deployment with no ENCRYPTION_KEY.
   */
  private encryption(): EncryptionService {
    try {
      return new EncryptionService();
    } catch {
      throw new ConnectorEncryptionUnavailableError();
    }
  }

  /** Raw stored row, secrets still encrypted. */
  private async getStored(channel: ChannelType): Promise<Record<string, unknown> | null> {
    try {
      return await this.configs.get<Record<string, unknown>>(configKeyFor(channel));
    } catch (error) {
      logger.error({ error, tenantId: this.tenantId, channel }, 'Failed to read connector config');
      throw error;
    }
  }

  /** Decrypted config, or null when the channel has never been configured. */
  async getRaw(channel: ChannelType): Promise<ConnectorConfig | null> {
    const stored = await this.getStored(channel);
    if (!stored) return null;

    const enc = this.encryption();
    const secretKeys = SECRET_FIELDS[channel] ?? [];
    const out: Record<string, unknown> = { ...stored };

    for (const key of secretKeys) {
      const value = stored[key];
      if (typeof value === 'string' && value) {
        const plain = safeDecrypt(enc, value, `${channel}.${key}`);
        if (plain === null) delete out[key];
        else out[key] = plain;
      }
    }

    // Widened through unknown: the row is whatever was persisted, and a secret
    // that failed to decrypt was dropped above, so the result is structurally a
    // partial. Callers must treat individual credential fields as optional.
    return out as unknown as ConnectorConfig;
  }

  /** Display-safe config: secrets replaced by their mask. Never returns plaintext. */
  async getMasked(channel: ChannelType): Promise<MaskedConnectorConfig> {
    const stored = await this.getStored(channel);
    if (!stored) {
      return { channel, configured: false, enabled: false, fields: {} };
    }

    const secretKeys = SECRET_FIELDS[channel] ?? [];
    const fields: Record<string, string> = {};
    let enc: EncryptionService | null = null;

    for (const [key, value] of Object.entries(stored)) {
      if (key === 'enabled') continue;
      // This allowlist contains public platform user IDs, not secret credentials.
      if (key === 'approverIds' && Array.isArray(value)) {
        fields[key] = value.join(', ');
        continue;
      }
      if (typeof value !== 'string' || !value) continue;

      if (secretKeys.includes(key)) {
        // Mask the plaintext length, not the ciphertext length, so the hint
        // ("ab12****ef90") actually corresponds to the real secret.
        enc ??= this.encryption();
        const plain = safeDecrypt(enc, value, `${channel}.${key}`);
        if (plain) fields[key] = maskSecret(plain);
      } else {
        fields[key] = value;
      }
    }

    return {
      channel,
      configured: true,
      enabled: stored.enabled === true,
      fields,
    };
  }

  /**
   * Upsert. Per the reference's §6 rule (`newValue?.trim() || existingValue`),
   * a blank or omitted secret preserves whatever is already stored — so the UI
   * can post a form whose secret inputs were left empty.
   */
  async save(
    channel: ChannelType,
    input: Record<string, string | boolean | string[] | undefined>,
    updatedBy = 'system',
  ): Promise<void> {
    const stored = (await this.getStored(channel)) ?? {};
    const secretKeys = SECRET_FIELDS[channel] ?? [];
    const next: Record<string, unknown> = { ...stored };

    for (const [key, value] of Object.entries(input)) {
      if (key === 'enabled') continue;
      if (key === 'approverIds') {
        if (!Array.isArray(value) ||
            value.length > 50 ||
            !value.every((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 128)) {
          throw new Error('Invalid approverIds: expected up to 50 non-empty user IDs');
        }
        next[key] = Array.from(new Set(value.map((id) => id.trim())));
        continue;
      }
      if (typeof value !== 'string') continue;

      const trimmed = value.trim();
      if (!trimmed) continue; // blank => keep existing

      next[key] = secretKeys.includes(key) ? this.encryption().encrypt(trimmed) : trimmed;
    }

    // `enabled` is a genuine boolean toggle, so it must be settable to false —
    // it can't go through the "blank means keep" path above.
    next.enabled = typeof input.enabled === 'boolean' ? input.enabled : stored.enabled === true;

    await this.configs.set(configKeyFor(channel), next, updatedBy);
    logger.info({ tenantId: this.tenantId, channel, enabled: next.enabled }, 'Connector config saved');
  }

  /** Wipes the channel's stored credentials. Idempotent. */
  async reset(channel: ChannelType): Promise<void> {
    await this.configs.delete(configKeyFor(channel));
    logger.info({ tenantId: this.tenantId, channel }, 'Connector config reset');
  }
}
