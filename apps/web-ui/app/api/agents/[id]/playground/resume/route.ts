import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  getSessionTenantId,
  getSessionUserId,
  authorize,
  getPrismaClient,
  createLogger,
  PausedExecutionService,
  LlmProviderService,
  TenantConfigService,
  NodeTraceCollector,
  sanitizeExecutionEvent,
} from '@chatbot/shared';
import { createLLMProvider, type TenantLLMConfig } from '@chatbot/ai';
import { GraphExecutor, createNodeExecutors } from '@chatbot/agent-studio/server';
import type { GraphState } from '@chatbot/agent-studio/server';
import { authOptions } from '@/lib/auth';

const logger = createLogger('api:playground:resume');

const resumeSchema = z.object({
  resumeToken: z.string().uuid(),
  userInput: z.string().min(1),
});

async function resolveProviderForModel(tenantId: string, modelId: string | undefined): Promise<TenantLLMConfig | null> {
  if (!modelId) return null;
  const llmProviderService = new LlmProviderService(tenantId);
  const providers = await llmProviderService.list();
  for (const provider of providers) {
    const discovered = (provider.models as { models?: Array<{ id: string }> } | null)?.models ?? [];
    if (discovered.some((m) => m.id === modelId)) {
      return llmProviderService.getConfigById(provider.id);
    }
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: agentId } = await params;

  try {
    const tenantId = await getSessionTenantId(authOptions);
    const userId = await getSessionUserId(authOptions);
    const authError = await authorize('create', 'AgentExecution', authOptions);
    if (authError) return authError;

    const body = await req.json();
    const parsed = resumeSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }),
        { status: 400 }
      );
    }
    const { resumeToken, userInput } = parsed.data;

    const db = getPrismaClient();
    const pausedExecService = new PausedExecutionService(db);

    const paused = await pausedExecService.claimToken(resumeToken);
    if (!paused) {
      return new Response(JSON.stringify({ error: 'Resume token invalid, expired, or already used' }), { status: 410 });
    }
    if (paused.tenantId !== tenantId) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    }

    const agentExecution = await db.agentExecution.findFirst({
      where: { id: paused.executionId, tenantId },
      include: { agentVersion: true },
    });
    if (!agentExecution) {
      return new Response(JSON.stringify({ error: 'Execution not found' }), { status: 404 });
    }

    const graphDef = agentExecution.agentVersion.config as { nodes?: any[]; edges?: any[] };
    const nodes = graphDef.nodes ?? [];
    const edges = graphDef.edges ?? [];

    const savedState = paused.graphState as GraphState;
    const restoredState: GraphState = {
      ...savedState,
      channels: {
        ...savedState.channels,
        [paused.outputChannel]: userInput,
        __paused: false,
        __resumeToken: null,
      },
      currentNodeId: paused.nextNodeId,
    };

    await db.agentExecution.update({
      where: { id: paused.executionId },
      data: { status: 'running' },
    });

    const llmProviderService = new LlmProviderService(tenantId);
    const services = {
      llmProvider: async (_providerId?: string, modelId?: string) => {
        const llmConfig =
          await resolveProviderForModel(tenantId, modelId) ??
          await llmProviderService.getDefaultConfig() ??
          await new TenantConfigService(tenantId).get<TenantLLMConfig>('llmConfig');
        const provider = createLLMProvider(llmConfig);
        await provider.validate();
        return provider;
      },
      prisma: db,
    };

    const executor = new GraphExecutor(services);
    for (const nodeExecutor of createNodeExecutors()) {
      executor.register(nodeExecutor);
    }

    const metadata = {
      executionId: paused.executionId,
      agentId,
      tenantId,
      userId,
    };

    let fullText = '';
    let pausedAgain = false;
    // Continue the per-node trace persisted before the pause (already redacted).
    const traceCollector = NodeTraceCollector.fromOutput(agentExecution.output);

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const sendEvent = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        try {
          await executor.executeFromState(
            { nodes, edges },
            restoredState,
            metadata,
            {
              onEvent: (event) => {
                traceCollector.handleEvent(event);
                sendEvent(event.type, sanitizeExecutionEvent(event));
                if (event.type === 'text_delta') {
                  fullText += (event as any).delta;
                }
              },
              onPause: async (pauseInfo) => {
                pausedAgain = true;
                traceCollector.recordPause();
                await pausedExecService.create({
                  tenantId,
                  agentId,
                  executionId: paused.executionId,
                  graphState: pauseInfo.state,
                  prompt: pauseInfo.prompt,
                  outputChannel: pauseInfo.outputChannel,
                  nextNodeId: pauseInfo.nextNodeId,
                  resumeToken: pauseInfo.resumeToken,
                });
                await db.agentExecution.update({
                  where: { id: paused.executionId },
                  data: { status: 'paused', output: { ...traceCollector.snapshot() } },
                });
                logger.info({ executionId: paused.executionId, resumeToken: pauseInfo.resumeToken }, 'Playground resumed execution paused again');
              },
            }
          );

          if (!pausedAgain) {
            await db.agentExecution.update({
              where: { id: paused.executionId },
              data: {
                status: 'completed',
                output: { text: fullText, ...traceCollector.snapshot() },
                completedAt: new Date(),
              },
            });
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          sendEvent('execution_error', { error: errorMessage });
          await db.agentExecution.update({
            where: { id: paused.executionId },
            data: { status: 'failed', output: { error: errorMessage, ...traceCollector.snapshot() }, completedAt: new Date() },
          });
          logger.error({ executionId: paused.executionId, error: errorMessage }, 'Graph resume execution failed');
        } finally {
          controller.close();
        }
      },
    });

    logger.info({ executionId: paused.executionId, agentId }, 'Streaming resumed graph execution');

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'x-execution-id': paused.executionId,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthenticated')) {
      return new Response(JSON.stringify({ error: 'Unauthenticated' }), { status: 401 });
    }
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ err, agentId }, 'Playground resume error');
    return new Response(JSON.stringify({ error: 'Internal server error', message: err.message }), { status: 500 });
  }
}
