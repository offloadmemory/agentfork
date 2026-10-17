/**
 * types.ts — the channel-connector contract, ported from the design reference
 * in docs/superpowers/plans/channel-connector-gateway-design.md (§2).
 *
 * The reference declares one 10-member `ChannelAdapter`. Seven of those members
 * (validateRequest/parseInbound/sendAck/send*) are meaningless without the
 * inbound gateway, which doesn't exist yet — Claw runs synchronously inside the
 * chat request and has no persisted run/event model to stream back from. So the
 * contract is split: `ChannelConnector` is the half that is implementable and
 * useful today (config + credential verification), and `ChannelAdapter` extends
 * it with the gateway half. When the gateway lands, the existing adapters widen
 * from one to the other — no stub methods that throw in the meantime.
 */

/** Full channel set from the design reference. Only the registered subset is usable. */
export type ChannelType = 'slack' | 'jira' | 'discord' | 'telegram' | 'webhook' | 'api';

export type DeliveryMode = 'streaming' | 'callback' | 'polling';

export interface HilCapabilities {
  /** Can it ask the user a follow-up question mid-run? */
  clarification: boolean;
  /** Can it render approve/reject affordances? */
  approvalButtons: boolean;
  /** Can replies be scoped to a thread/conversation? */
  threadedReplies: boolean;
}

// ============================================================================
// Per-channel stored config
// ============================================================================

export interface BaseConnectorConfig {
  enabled: boolean;
  /**
   * Platform user ids allowed to act on this channel's approval affordances
   * (Approve / Reject / "Always allow for this task"). Not a secret — these
   * are public platform identifiers, not credentials.
   *
   * Unset or empty means no allowlist is configured yet. See the gateway's
   * `handleResume` for the resulting default-deny behavior on
   * `approve_always`, which grants a standing permission and is too
   * consequential to leave open to any workspace member by default
   * (docs/superpowers/claw-studio-known-issues.md #11).
   */
  approverIds?: string[];
}

export interface SlackConnectorConfig extends BaseConnectorConfig {
  signingSecret: string;
  botToken?: string;
  /** Workspace id. Promoted to its own reverse-lookup table when inbound routing lands. */
  teamId?: string;
}

export interface TelegramConnectorConfig extends BaseConnectorConfig {
  botToken: string;
  secretToken: string;
}

export interface DiscordConnectorConfig extends BaseConnectorConfig {
  /** Public, not a secret — used to resolve the tenant from an inbound interaction. */
  applicationId: string;
  /** Public, not a secret — Discord's own name for the Ed25519 verification key. */
  publicKey: string;
  /** Required: Discord has no long-lived reply mechanism besides bot-authenticated channel messages. */
  botToken: string;
}

export type ConnectorConfig = SlackConnectorConfig | TelegramConnectorConfig | DiscordConnectorConfig;

/** Which fields of a given channel's config hold secrets (encrypted at rest, masked on read). */
export const SECRET_FIELDS: Record<string, readonly string[]> = {
  slack: ['signingSecret', 'botToken'],
  telegram: ['botToken', 'secretToken'],
  discord: ['botToken'],
};

// ============================================================================
// Credential verification (the "Test Connection" button)
// ============================================================================

export interface VerifySuccess {
  ok: true;
  /** Human-readable identity the credential resolved to, e.g. a bot username. */
  detail: string;
  /** Platform-specific extras surfaced in the success toast. */
  meta?: Record<string, string>;
}

export interface VerifyFailure {
  ok: false;
  error: string;
}

export type VerifyResult = VerifySuccess | VerifyFailure;

// ============================================================================
// Contracts
// ============================================================================

/**
 * The half implemented today: describe the channel, read its config, and prove
 * a credential works.
 */
export interface ChannelConnector {
  readonly channelType: ChannelType;
  readonly displayName: string;
  readonly description: string;
  readonly deliveryMode: DeliveryMode;
  readonly hilCapabilities: HilCapabilities;

  getConfig(tenantId: string): Promise<ConnectorConfig | null>;
  /**
   * Live-verifies credentials against the platform without persisting anything.
   * `override` carries a not-yet-saved token typed into the form; when absent,
   * the stored config is used.
   */
  verifyCredentials(tenantId: string, override?: Record<string, string>): Promise<VerifyResult>;
}

// ============================================================================
// Gateway half
// ============================================================================
//
// `ChannelAdapter` — the inbound/outbound half — now lives in
// `../gateway/types`, where it can be typed against the real ClawRun/ClawRunEvent
// records instead of `unknown`. It still extends `ChannelConnector` declared
// above, so the split described in this file's header is unchanged; only the
// declaration moved, to keep the import direction one-way (gateway → connectors).
