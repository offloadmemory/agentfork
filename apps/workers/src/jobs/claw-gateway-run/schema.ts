import { z } from 'zod';

export const clawGatewayRunSchema = z.object({
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  /**
   * Absent => first execution of a fresh run. Present => a human-in-the-loop
   * resume, dispatched from either a channel (button press, thread reply) or the
   * runs dashboard. `cancel` is dashboard-only — channels have no cancel
   * affordance, and an already-executing run is cancelled through its status
   * rather than through the queue.
   *
   * `approve_always` behaves as `approve` and additionally adds the pending tools
   * to the originating scheduled task's allowlist, so that task stops asking.
   */
  action: z.enum([
    'approve', 'approve_always', 'reject', 'clarification_response', 'cancel',
  ]).optional(),
  /** The user's reply text, for clarification_response. */
  content: z.string().optional(),
  /** The platform user id that made this decision, when it came from a channel. */
  actorId: z.string().optional(),
  /** Accept already-queued jobs created before the actorId rename. */
  approvedBy: z.string().optional(),
});

export type ClawGatewayRunData = z.infer<typeof clawGatewayRunSchema>;
