/**
 * claw-gateway-run — executes a channel-triggered Claw run.
 *
 * The gateway route in Mission Control only validates, persists and enqueues;
 * everything slow lives here. Both the executor and the notification router run
 * in this process, so the in-memory event bus never has to cross a process
 * boundary.
 *
 * @chatbot/claw-studio is imported dynamically (matching resume-agent-execution)
 * so LangGraph and the model SDKs are only loaded when a Claw job actually runs,
 * not at worker boot for every other job type.
 */

import { createLogger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { clawGatewayRunSchema } from './schema.js';

const log = createLogger('claw-gateway-run');

export async function handleClawGatewayRun(data: unknown): Promise<void> {
  const { runId, tenantId, action, content, actorId: newActorId, approvedBy } = clawGatewayRunSchema.parse(data);
  const actorId = newActorId ?? approvedBy; // compatibility for pre-existing queued jobs

  try {
    const { executeRun, terminateRun, grantPendingToolsForRun } = await import('@chatbot/claw-studio');
    const deps = { dashboardBaseUrl: env.MISSION_CONTROL_URL };

    // "Always allow for this task": persist the grant BEFORE resuming, so the
    // approval and the learning are one action from the user's point of view. Doing
    // it here rather than inside executeRun keeps the gateway free of a scheduler
    // import (the scheduler already imports the gateway).
    if (action === 'approve_always') {
      const { granted } = await grantPendingToolsForRun(runId);
      log.info({ runId, tenantId, granted }, 'Granted tools to the scheduled task');
    }

    if (action === 'reject' || action === 'cancel') {
      log.info({ runId, tenantId, action }, 'Terminating run');
      await terminateRun({
        runId,
        deps,
        kind: action === 'reject' ? 'reject' : 'cancel',
        actorId: action === 'reject' ? actorId : undefined,
      });
      return;
    }

    log.info({ runId, tenantId, resume: action ?? null }, 'Executing gateway run');
    await executeRun({
      runId,
      deps,
      resume: action ? { action, content, actorId } : undefined,
    });
    log.info({ runId, tenantId }, 'Gateway run handler finished');
  } catch (error) {
    // executeRun already recorded the failure on the run and notified the
    // channel; rethrow so the queue records it too.
    log.error(
      { runId, tenantId, error: error instanceof Error ? error.message : String(error) },
      'Gateway run failed',
    );
    throw error;
  }
}
