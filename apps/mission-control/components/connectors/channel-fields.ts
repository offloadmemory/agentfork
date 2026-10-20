import type { ChannelId } from '@/hooks/use-connectors';

export interface FieldSpec {
  name: string;
  label: string;
  /** Secret fields are encrypted at rest, masked on read, and rendered as password inputs. */
  secret: boolean;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  /** Renders a "Generate" button that fills the field with 32 random bytes of hex. */
  generate?: boolean;
  /** Only render this field while the named sibling field has no value stored or typed. */
  showWhileEmpty?: string;
}

export interface ChannelFieldConfig {
  fields: FieldSpec[];
  /** Fields forwarded to the /test route as not-yet-saved overrides. */
  testOverrideKeys: string[];
  /** Human-readable list of what a reset wipes. */
  clears: string;
  setupHint: string;
}

export const CHANNEL_FIELDS: Record<ChannelId, ChannelFieldConfig> = {
  slack: {
    fields: [
      {
        name: 'signingSecret',
        label: 'Signing Secret',
        secret: true,
        required: true,
        placeholder: 'Enter signing secret',
        hint: 'Slack app → Basic Information → App Credentials → Signing Secret. Used to verify inbound requests.',
      },
      {
        name: 'botToken',
        label: 'Bot Token',
        secret: true,
        placeholder: 'xoxb-…',
        hint: 'Slack app → OAuth & Permissions → Bot User OAuth Token. Required to post replies and to test the connection.',
      },
      {
        name: 'teamId',
        label: 'Team ID',
        secret: false,
        placeholder: 'T01234567',
        hint: 'Only needed when no bot token is set — otherwise it is read from Slack automatically.',
        showWhileEmpty: 'botToken',
      },
      {
        name: 'approverIds',
        label: 'Authorized Approver IDs',
        secret: false,
        placeholder: 'U123, U456',
        hint: 'Platform user IDs separated by commas. With no IDs, one-time approve/reject remains available to workspace members, while Always allow is blocked.',
      },
    ],
    testOverrideKeys: ['botToken'],
    clears: 'signing secret, bot token, and authorized approvers',
    setupHint: 'Test Connection calls Slack’s auth.test with your bot token.',
  },
  telegram: {
    fields: [
      {
        name: 'botToken',
        label: 'Bot Token',
        secret: true,
        required: true,
        placeholder: '123456:ABC-DEF…',
        hint: 'Message @BotFather on Telegram → /newbot → copy the token it gives you.',
      },
      {
        name: 'secretToken',
        label: 'Secret Token',
        secret: true,
        required: true,
        generate: true,
        placeholder: 'Generate or paste a high-entropy value',
        hint: 'Sent by Telegram on every inbound request so we can verify it really came from Telegram.',
      },
      {
        name: 'approverIds',
        label: 'Authorized Approver IDs',
        secret: false,
        placeholder: 'U123, U456',
        hint: 'Platform user IDs separated by commas. With no IDs, one-time approve/reject remains available to workspace members, while Always allow is blocked.',
      },
    ],
    testOverrideKeys: ['botToken'],
    clears: 'bot token, secret token, and authorized approvers',
    setupHint: 'Test Connection calls Telegram’s getMe with your bot token.',
  },
  discord: {
    fields: [
      {
        name: 'applicationId',
        label: 'Application ID',
        secret: false,
        required: true,
        placeholder: '1234567890123456789',
        hint: 'Discord Developer Portal → your app → General Information → Application ID.',
      },
      {
        name: 'publicKey',
        label: 'Public Key',
        secret: false,
        required: true,
        placeholder: 'Discord Developer Portal → General Information → Public Key',
        hint: 'Used to verify that inbound interactions really came from Discord.',
      },
      {
        name: 'botToken',
        label: 'Bot Token',
        secret: true,
        required: true,
        placeholder: 'Discord Developer Portal → Bot → Reset Token',
        hint: 'Required to post replies — Discord has no long-lived reply mechanism besides bot-authenticated messages.',
      },
      {
        name: 'approverIds',
        label: 'Authorized Approver IDs',
        secret: false,
        placeholder: 'U123, U456',
        hint: 'Platform user IDs separated by commas. With no IDs, one-time approve/reject remains available to workspace members, while Always allow is blocked.',
      },
    ],
    testOverrideKeys: ['botToken', 'applicationId', 'publicKey'],
    clears: 'application id, public key, bot token, and authorized approvers',
    setupHint: 'Test Connection calls Discord’s /users/@me with your bot token. Register a /claw slash command and set the Interactions Endpoint URL to the webhook URL below.',
  },
};
