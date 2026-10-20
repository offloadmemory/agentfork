import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { createLogger, AuditService } from '@chatbot/shared';
import {
  getConnectorRegistry,
  ClawConnectorConfigService,
  ConnectorEncryptionUnavailableError,
  linkChannel,
  unlinkChannel,
  hashExternalId,
  type ChannelType,
} from '@chatbot/claw-studio';
import { authOptions } from '@/lib/auth';
import { env } from '@/lib/env';

const logger = createLogger('mission-control:api:connectors:channel');

function webhookUrlFor(channel: string): string {
  return `${env.NEXT_PUBLIC_MISSION_CONTROL_URL.replace(/\/+$/, '')}/api/gateway/${channel}`;
}

/**
 * Points the platform's own identifier at this tenant, so inbound webhooks can
 * be routed without trusting anything the caller sends (see
 * gateway/channel-link.ts).
 *
 * Returns a warning string when the link could not be established — the config
 * still saved, but inbound traffic won't route until it is, and the UI needs to
 * say so rather than implying the channel is live.
 */
async function syncChannelLink(
  channel: ChannelType,
  tenantId: string,
): Promise<string | null> {
  const configs = new ClawConnectorConfigService(tenantId);

  if (channel === 'telegram') {
    // The secret token IS the routing key, so no platform round-trip is needed.
    const config = (await configs.getRaw('telegram')) as { secretToken?: string } | null;
    if (!config?.secretToken) {
      return 'Add a secret token before Telegram can deliver updates to Claw.';
    }
    await linkChannel({
      channel,
      externalId: hashExternalId(config.secretToken),
      tenantId,
      label: 'Telegram bot',
    });
    return null;
  }

  if (channel === 'slack') {
    // Slack only tells us the workspace id in exchange for a valid bot token.
    const result = await getConnectorRegistry().get('slack').verifyCredentials(tenantId);
    if (!result.ok) {
      return `Saved, but Slack could not be reached to link the workspace: ${result.error}`;
    }
    const teamId = result.meta?.teamId;
    if (!teamId) {
      return 'Saved, but Slack did not return a workspace id, so inbound requests cannot be routed yet.';
    }
    await linkChannel({ channel, externalId: teamId, tenantId, label: result.meta?.team || undefined });
    return null;
  }

  if (channel === 'discord') {
    // The application id is public (shown in Discord's own developer portal),
    // so — like Slack's team_id — it's used directly as the routing key, no
    // hashing and no platform round-trip needed.
    const config = (await configs.getRaw('discord')) as { applicationId?: string } | null;
    if (!config?.applicationId) {
      return 'Add an application id before Discord can deliver interactions to Claw.';
    }
    await linkChannel({ channel, externalId: config.applicationId, tenantId, label: 'Discord application' });
    return null;
  }

  return null;
}

// Per-channel field whitelist. `.strict()` so a typo'd field name is a 400
// rather than silently writing an ignored key into the stored config.
const saveSchemas: Record<string, z.ZodType> = {
  slack: z
    .object({
      enabled: z.boolean().optional(),
      approverIds: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
      signingSecret: z.string().optional(),
      botToken: z.string().optional(),
      teamId: z.string().optional(),
    })
    .strict(),
  telegram: z
    .object({
      enabled: z.boolean().optional(),
      approverIds: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
      botToken: z.string().optional(),
      secretToken: z.string().optional(),
    })
    .strict(),
  discord: z
    .object({
      enabled: z.boolean().optional(),
      approverIds: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
      applicationId: z.string().optional(),
      publicKey: z.string().optional(),
      botToken: z.string().optional(),
    })
    .strict(),
};

async function resolve(params: Promise<{ channel: string }>) {
  const session = await getServerSession(authOptions);
  if (!session?.studio?.tenantId) {
    return { error: NextResponse.json({ success: false, error: 'Unauthenticated' }, { status: 401 }) };
  }
  const { channel } = await params;
  if (!getConnectorRegistry().has(channel)) {
    return { error: NextResponse.json({ success: false, error: 'Unknown connector' }, { status: 404 }) };
  }
  return {
    session,
    tenantId: session.studio.tenantId,
    channel: channel as ChannelType,
    actor: session.studio.studioId,
  };
}

function handleError(error: unknown, message: string) {
  if (error instanceof ConnectorEncryptionUnavailableError) {
    logger.error({ error }, message);
    return NextResponse.json({ success: false, error: error.message }, { status: 503 });
  }
  logger.error({ error }, message);
  return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ channel: string }> }) {
  try {
    const ctx = await resolve(params);
    if ('error' in ctx) return ctx.error;

    const connector = getConnectorRegistry().get(ctx.channel);
    const masked = await new ClawConnectorConfigService(ctx.tenantId).getMasked(ctx.channel);

    return NextResponse.json({
      success: true,
      data: {
        ...masked,
        displayName: connector.displayName,
        description: connector.description,
        deliveryMode: connector.deliveryMode,
        hilCapabilities: connector.hilCapabilities,
        webhookUrl: webhookUrlFor(ctx.channel),
      },
    });
  } catch (error) {
    return handleError(error, 'Failed to fetch connector config');
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ channel: string }> }) {
  try {
    const ctx = await resolve(params);
    if ('error' in ctx) return ctx.error;

    const parsed = saveSchemas[ctx.channel].safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400 },
      );
    }

    const configs = new ClawConnectorConfigService(ctx.tenantId);
    await configs.save(ctx.channel, parsed.data as Record<string, string | boolean | string[] | undefined>, ctx.actor);

    // Routing is established after the save so the link always reflects what is
    // actually stored. A failure here is reported, never fatal — the credentials
    // did save.
    let warning: string | null = null;
    try {
      warning = await syncChannelLink(ctx.channel, ctx.tenantId);
    } catch (error) {
      logger.error({ error, channel: ctx.channel, tenantId: ctx.tenantId }, 'Failed to sync channel link');
      warning = 'Saved, but inbound routing could not be updated. Try saving again.';
    }

    AuditService.logUserAction({
      eventType: 'claw.connector.updated',
      action: 'Updated Claw Connector',
      resourceType: 'connector',
      resourceId: ctx.channel,
      resourceName: getConnectorRegistry().get(ctx.channel).displayName,
      user: ctx.actor,
      userType: 'user',
      status: 'success',
      severity: 'high',
      details: `Updated Claw connector credentials for ${ctx.channel}`,
      apiRoute: `PUT /api/connectors/${ctx.channel}`,
      httpMethod: 'PUT',
      // Field NAMES only — never the values, which are credentials.
      metadata: { tenantId: ctx.tenantId, channel: ctx.channel, fields: Object.keys(parsed.data as object) },
      tenantId: ctx.tenantId,
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      data: { ...(await configs.getMasked(ctx.channel)), webhookUrl: webhookUrlFor(ctx.channel) },
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    return handleError(error, 'Failed to save connector config');
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ channel: string }> }) {
  try {
    const ctx = await resolve(params);
    if ('error' in ctx) return ctx.error;

    await new ClawConnectorConfigService(ctx.tenantId).reset(ctx.channel);
    // Drop the reverse-lookup rows too, or a stale mapping could misroute a
    // future workspace's requests into this tenant (design reference §6).
    await unlinkChannel(ctx.tenantId, ctx.channel);

    AuditService.logUserAction({
      eventType: 'claw.connector.reset',
      action: 'Reset Claw Connector',
      resourceType: 'connector',
      resourceId: ctx.channel,
      resourceName: getConnectorRegistry().get(ctx.channel).displayName,
      user: ctx.actor,
      userType: 'user',
      status: 'success',
      severity: 'high',
      details: `Cleared all stored credentials for the ${ctx.channel} connector`,
      apiRoute: `DELETE /api/connectors/${ctx.channel}`,
      httpMethod: 'DELETE',
      metadata: { tenantId: ctx.tenantId, channel: ctx.channel },
      tenantId: ctx.tenantId,
    }).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleError(error, 'Failed to reset connector config');
  }
}
