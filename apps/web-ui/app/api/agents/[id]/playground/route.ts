import { NextRequest } from 'next/server';
import {
  getSessionTenantId,
  getSessionUserId,
  authorize,
  getPrismaClient,
  createLogger,
  TenantConfigService,
  LlmProviderService,
  PausedExecutionService,
  playgroundRequestSchema,
  NodeTraceCollector,
  sanitizeExecutionEvent,
} from '@chatbot/shared';
import { S3Service } from '@chatbot/shared/server';
import { streamChat, createLLMProvider, type TenantLLMConfig, ContentResolver, type MessageAttachment, buildBuiltInTools } from '@chatbot/ai';
import { authOptions } from '@/lib/auth';

const logger = createLogger('api:playground');

async function resolveProviderForModel(
  tenantId: string,
  modelId: string | undefined
): Promise<TenantLLMConfig | null> {
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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = crypto.randomUUID();
  let agentId: string | undefined;
  try {
    const tenantId = await getSessionTenantId(authOptions);
    const userId = await getSessionUserId(authOptions);
    const authError = await authorize('create', 'AgentExecution', authOptions);
    if (authError) return authError;

    const { id } = await params;
    agentId = id;

    logger.info({ requestId, agentId, tenantId, userId }, 'Playground execution started');

    const db = getPrismaClient();

    const body = await req.json();
    const parsed = playgroundRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }),
        { status: 400 }
      );
    }
    const { messages, systemPrompt, model, temperature, maxTokens, agentVersionId, attachments: topLevelAttachments } = parsed.data;
    const { alias } = parsed.data;

    // Fetch agent
    const agent = await db.agent.findFirst({ where: { id, tenantId } });
    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), { status: 404 });
    }

    // Resolve version
    let resolvedConfig: Record<string, unknown> = {};
    let resolvedVersionId: string | null = agentVersionId ?? null;

    if (resolvedVersionId) {
      const version = await db.agentVersion.findFirst({ where: { id: resolvedVersionId, agentId: id } });
      if (version) {
        resolvedConfig = (version.config as Record<string, unknown>) ?? {};
      }
    } else if (alias) {
      const aliasService = new (await import('@chatbot/agent-studio')).AgentAliasService(tenantId, db as any);
      try {
        const resolved = await aliasService.resolveAlias(id, alias);
        resolvedConfig = resolved.config;
        resolvedVersionId = resolved.versionId;
      } catch {
        // fall through to agent config
      }
    } else {
      // Try default alias
      const defaultAlias = await db.agentAlias.findFirst({
        where: { agentId: id, isDefault: true },
        include: { version: true },
      });
      if (defaultAlias) {
        resolvedConfig = (defaultAlias.version.config as Record<string, unknown>) ?? {};
        resolvedVersionId = defaultAlias.versionId;
      }
    }

    if (Object.keys(resolvedConfig).length === 0) {
      resolvedConfig = (agent.config as Record<string, unknown>) ?? {};
    }

    // Fallback: if no version resolved, use the latest version for this agent
    if (!resolvedVersionId) {
      const latestVersion = await db.agentVersion.findFirst({
        where: { agentId: id },
        orderBy: { version: 'desc' },
      });
      if (latestVersion) {
        resolvedVersionId = latestVersion.id;
      }
    }

    // If still no version, we cannot create an execution (schema requires agentVersionId)
    if (!resolvedVersionId) {
      return new Response(JSON.stringify({ error: 'Agent has no versions. Please publish a version first.' }), { status: 400 });
    }

    const startedAt = new Date();
    const execution = await db.agentExecution.create({
      data: {
        agentId: id,
        agentVersionId: resolvedVersionId as string,
        tenantId,
        userId,
        status: 'running',
        input: { messages, overrides: { systemPrompt, model, temperature } },
        startedAt,
      },
    });

    logger.info({ requestId, executionId: execution.id, agentId: id, agentType: agent.type }, 'Execution record created');

    // Simple agent execution
    if (agent.type === 'simple') {
      const simpleConfig = resolvedConfig as { model?: string; systemPrompt?: string; temperature?: number; maxTokens?: number; tools?: string[] };
      const effectiveModel = model ?? simpleConfig.model ?? undefined;
      const effectiveTemperature = temperature ?? simpleConfig.temperature ?? 0.7;

      // Resolve LLM provider by model, then fall back to default
      const llmProviderService = new LlmProviderService(tenantId);
      const llmConfig = await resolveProviderForModel(tenantId, effectiveModel)
        ?? await llmProviderService.getDefaultConfig()
        ?? await new TenantConfigService(tenantId).get<TenantLLMConfig>('llmConfig');

      logger.info({ requestId, provider: llmConfig?.provider, chatModel: llmConfig?.chatModel, region: llmConfig?.region, hasAccessKey: !!llmConfig?.accessKeyId }, 'Resolved LLM config');

      const provider = createLLMProvider(llmConfig);
      logger.info({ requestId, providerName: provider.name, providerChatModel: provider.chatModel }, 'LLM provider instantiated');

      await provider.validate();
      logger.info({ requestId }, 'Provider validation passed');

      const coreMessages = (messages as Array<{ role: string; content?: string; parts?: Array<{ type: string; text: string }>; data?: { attachments?: MessageAttachment[] } }>).map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content ?? m.parts?.filter((p) => p.type === 'text').map((p) => p.text).join('') ?? '',
        attachments: (m.data?.attachments ?? []) as MessageAttachment[],
      }));

      // Top-level attachments (sent via useChat per-call body) apply to the current (last) turn.
      if (topLevelAttachments && topLevelAttachments.length > 0 && coreMessages.length > 0) {
        coreMessages[coreMessages.length - 1].attachments = topLevelAttachments as MessageAttachment[];
      }

      logger.debug(
        {
          requestId,
          rawMessages: coreMessages.map((m) => ({ role: m.role, hasContent: !!m.content, attachmentCount: m.attachments.length })),
          topLevelAttachmentCount: topLevelAttachments?.length ?? 0,
        },
        'Parsed messages from request body',
      );

      // Resolve multimodal content — fetch files from S3 for the current turn
      const s3 = new S3Service();
      const contentResolver = new ContentResolver(s3);
      const currentTurnIndex = coreMessages.length - 1;
      const hasAttachments = coreMessages.some((m) => m.attachments.length > 0);

      let resolvedCoreMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string | Array<{ type: string; text?: string; image?: string; mimeType?: string }> }>;

      if (hasAttachments) {
        logger.info(
          { requestId, currentTurnIndex, attachmentCount: coreMessages[currentTurnIndex]?.attachments.length ?? 0 },
          'Resolving multimodal attachments for playground',
        );
        const storedMessages = coreMessages.map((m) => ({
          role: m.role,
          content: m.content,
          attachments: m.attachments,
        }));
        const resolved = await contentResolver.resolve(storedMessages, currentTurnIndex);
        resolvedCoreMessages = resolved.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.content.map((p) => {
            if (p.type === 'text') return { type: 'text' as const, text: p.text };
            return { type: 'image' as const, image: p.image, mimeType: p.mimeType };
          }),
        }));
      } else {
        resolvedCoreMessages = coreMessages.map((m) => ({ role: m.role, content: m.content }));
      }

      const userQuery = typeof resolvedCoreMessages[resolvedCoreMessages.length - 1]?.content === 'string'
        ? resolvedCoreMessages[resolvedCoreMessages.length - 1].content as string
        : (resolvedCoreMessages[resolvedCoreMessages.length - 1]?.content as Array<{ type: string; text?: string }>)
            ?.filter((p) => p.type === 'text').map((p) => p.text ?? '').join(' ') ?? '';
      const kbContext = await buildKbContext(id, tenantId, userQuery, db);

      // Discover MCP tools attached to this agent
      const { buildMcpToolsForAgent } = await import('@chatbot/agent-studio/server');
      const { tools: mcpTools, cleanup: mcpCleanup } = await buildMcpToolsForAgent(id, tenantId, db);
      const tenantConfigService = new TenantConfigService(tenantId);
      const builtInTools = await buildBuiltInTools(tenantId, {
        configResolver: { get: (key) => tenantConfigService.get(key) },
      });
      const allTools = { ...mcpTools, ...builtInTools };
      const hasTools = Object.keys(allTools).length > 0;

      logger.info(
        {
          requestId,
          mcpToolCount: Object.keys(mcpTools).length,
          builtInToolCount: Object.keys(builtInTools).length,
          mcpToolNames: Object.keys(mcpTools),
          builtInToolNames: Object.keys(builtInTools),
        },
        'MCP + built-in tools discovered',
      );

      let effectiveSystem = systemPrompt ?? simpleConfig.systemPrompt ?? 'You are a helpful assistant.';
      if (kbContext) {
        effectiveSystem = `${effectiveSystem}\n\nUse the following retrieved context to answer questions. If the context does not contain the answer, say so.\n\n${kbContext}`;
      }

      logger.info(
        {
          requestId,
          executionId: execution.id,
          messageCount: resolvedCoreMessages.length,
          hasKbContext: !!kbContext,
          hasTools,
          toolNames: Object.keys(allTools),
          maxSteps: hasTools ? 5 : 0,
          hasAttachments,
        },
        'Starting stream chat',
      );

      const startTime = Date.now();

      const result = streamChat({
        provider,
        messages: resolvedCoreMessages as any,
        model: effectiveModel,
        system: effectiveSystem,
        temperature: effectiveTemperature,
        maxOutputTokens: maxTokens ?? simpleConfig.maxTokens ?? undefined,
        ...(hasTools ? { tools: allTools, maxSteps: 5 } : {}),
        onFinish: async ({ text, usage }) => {
          await mcpCleanup();
          const completedAt = new Date();
          const durationMs = Date.now() - startTime;
          await db.agentExecution.update({
            where: { id: execution.id },
            data: {
              status: 'completed',
              output: { text, usage, durationMs, model: effectiveModel ?? llmConfig?.chatModel ?? 'unknown' },
              completedAt,
            },
          });
          logger.info({ requestId, executionId: execution.id, usage, durationMs }, 'Execution completed');
        },
      });

      return result.toUIMessageStreamResponse({
        headers: {
          'x-execution-id': execution.id,
          'x-model-id': effectiveModel ?? llmConfig?.chatModel ?? 'unknown',
          'x-request-timestamp': String(startTime),
        },
      });
    }

    // Graph agent execution with real GraphExecutor
    if (agent.type === 'graph') {
      const { GraphExecutor, LlmNodeExecutor, RouterNodeExecutor, ToolNodeExecutor, StateSchemaNodeExecutor, KnowledgeBaseNodeExecutor, McpServerNodeExecutor, InputNodeExecutor, OutputNodeExecutor, MemoryNodeExecutor, CodeNodeExecutor, ConditionNodeExecutor, HttpNodeExecutor, HumanNodeExecutor, ParallelNodeExecutor, SubAgentNodeExecutor, DelayNodeExecutor } = await import('@chatbot/agent-studio/server');

      const graphDef = resolvedConfig as { nodes?: any[]; edges?: any[] };
      const nodes = graphDef.nodes ?? [];
      const edges = graphDef.edges ?? [];

      if (nodes.length === 0) {
        return new Response(JSON.stringify({ error: 'Graph has no nodes' }), { status: 400 });
      }

      const coreMessages = (messages as Array<{ role: string; content?: string; parts?: Array<{ type: string; text: string }> }>).map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content ?? m.parts?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') ?? '',
      }));

      const llmProviderService = new LlmProviderService(tenantId);

      // Build the tool registry once per execution: built-in tools + MCP tools
      // attached to this agent. Node executors (tool, llm) resolve tool names
      // against this registry via ctx.services.toolRegistry.
      const graphTenantConfigService = new TenantConfigService(tenantId);
      const graphBuiltInTools = await buildBuiltInTools(tenantId, {
        configResolver: { get: (key) => graphTenantConfigService.get(key) },
      });
      const { buildMcpToolsForAgent: buildGraphMcpTools } = await import('@chatbot/agent-studio/server');
      const { tools: graphMcpTools, cleanup: graphMcpCleanup } = await buildGraphMcpTools(id, tenantId, db);
      const toolRegistry: Record<string, unknown> = { ...graphMcpTools, ...graphBuiltInTools };

      logger.info(
        { requestId, builtInToolCount: Object.keys(graphBuiltInTools).length, mcpToolCount: Object.keys(graphMcpTools).length },
        'Graph tool registry built',
      );

      const services = {
        llmProvider: async (_providerId?: string, modelId?: string) => {
          const llmConfig = await resolveProviderForModel(tenantId, modelId)
            ?? await llmProviderService.getDefaultConfig()
            ?? await new TenantConfigService(tenantId).get('llmConfig');
          const provider = createLLMProvider(llmConfig);
          await provider.validate();
          return provider;
        },
        prisma: db,
        toolRegistry,
      };

      const executor = new GraphExecutor(services);
      executor.register(new LlmNodeExecutor());
      executor.register(new RouterNodeExecutor());
      executor.register(new ToolNodeExecutor());
      executor.register(new StateSchemaNodeExecutor());
      executor.register(new KnowledgeBaseNodeExecutor());
      executor.register(new McpServerNodeExecutor());
      executor.register(new InputNodeExecutor());
      executor.register(new OutputNodeExecutor());
      executor.register(new MemoryNodeExecutor());
      executor.register(new CodeNodeExecutor());
      executor.register(new ConditionNodeExecutor());
      executor.register(new HttpNodeExecutor());
      executor.register(new HumanNodeExecutor());
      executor.register(new ParallelNodeExecutor());
      executor.register(new SubAgentNodeExecutor());
      executor.register(new DelayNodeExecutor());

      let fullText = '';
      const graphStartTime = Date.now();
      let graphTtftMs: number | undefined;
      let paused = false;
      const pausedExecService = new PausedExecutionService(db);
      // Per-node trace, redacted and size-capped before it is persisted or streamed.
      const traceCollector = new NodeTraceCollector();

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();

          const sendEvent = (event: string, data: unknown) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };

          sendEvent('execution_start', {
            executionId: execution.id,
            model: 'graph',
            temperature: 0,
            maxTokens: 0,
            timestamp: graphStartTime,
          });

          try {
            await executor.execute(
              { nodes, edges },
              { messages: coreMessages },
              { executionId: execution.id, agentId: id, tenantId, userId },
              {
                onEvent: (event) => {
                  if (event.type === 'text_delta' && graphTtftMs === undefined) {
                    graphTtftMs = Date.now() - graphStartTime;
                  }
                  traceCollector.handleEvent(event);
                  sendEvent(event.type, sanitizeExecutionEvent(event));
                  if (event.type === 'text_delta') {
                    fullText += (event as any).delta;
                  }
                },
                onPause: async (pauseInfo) => {
                  paused = true;
                  traceCollector.recordPause();
                  await pausedExecService.create({
                    tenantId,
                    agentId: id,
                    executionId: execution.id,
                    graphState: pauseInfo.state,
                    prompt: pauseInfo.prompt,
                    outputChannel: pauseInfo.outputChannel,
                    nextNodeId: pauseInfo.nextNodeId,
                    resumeToken: pauseInfo.resumeToken,
                  });
                  await db.agentExecution.update({
                    where: { id: execution.id },
                    data: { status: 'paused', output: { ...traceCollector.snapshot() } },
                  });
                  sendEvent('execution_paused', {
                    resumeToken: pauseInfo.resumeToken,
                    prompt: pauseInfo.prompt,
                  });
                  logger.info({ executionId: execution.id, resumeToken: pauseInfo.resumeToken }, 'Playground execution paused at human node');
                },
              }
            );

            if (!paused) {
              const durationMs = Date.now() - graphStartTime;
              sendEvent('execution_end', {
                usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
                durationMs,
                ttftMs: graphTtftMs ?? durationMs,
                model: 'graph',
              });

              await db.agentExecution.update({
                where: { id: execution.id },
                data: {
                  status: 'completed',
                  output: { text: fullText, ...traceCollector.snapshot() },
                  completedAt: new Date(),
                },
              });
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            const durationMs = Date.now() - graphStartTime;
            sendEvent('error', { code: 'EXECUTION_ERROR', message: errorMessage, timestamp: Date.now() });
            sendEvent('execution_end', {
              usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 },
              durationMs,
              ttftMs: graphTtftMs ?? durationMs,
              model: 'graph',
              error: errorMessage,
            });
            await db.agentExecution.update({
              where: { id: execution.id },
              data: { status: 'failed', output: { error: errorMessage, ...traceCollector.snapshot() }, completedAt: new Date() },
            });
            logger.error({ executionId: execution.id, error: errorMessage }, 'Graph execution failed');
          } finally {
            await graphMcpCleanup().catch((cleanupErr) => {
              logger.warn({ executionId: execution.id, error: (cleanupErr as Error).message }, 'Graph MCP cleanup warning');
            });
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'x-execution-id': execution.id,
        },
      });
    }

    return new Response(JSON.stringify({ error: 'Unsupported agent type' }), { status: 400 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unauthenticated')) {
      return new Response(JSON.stringify({ error: 'Unauthenticated' }), { status: 401 });
    }
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(
      { err, errorMessage: err.message, errorStack: err.stack, requestId, agentId },
      'Playground execution error'
    );
    return new Response(JSON.stringify({ error: 'Internal server error', message: err.message }), { status: 500 });
  }
}

async function buildKbContext(
  agentId: string,
  tenantId: string,
  query: string,
  db: any
): Promise<string> {
  const attachments = await db.agentKnowledgeBase.findMany({
    where: { agentId },
    include: { knowledgeBase: true },
  });

  if (!attachments || attachments.length === 0) return '';

  const { RetrievalService } = await import('@chatbot/knowledge-base');
  const retrieval = new RetrievalService(tenantId);

  const contexts: string[] = [];
  for (const att of attachments) {
    const kb = att.knowledgeBase;
    if (kb.status !== 'active') continue;

    try {
      const results = await retrieval.query(query, {
        knowledgeBaseId: kb.id,
        topK: 5,
      });

      if (results.length > 0) {
        contexts.push(`--- From ${kb.name} ---\\n${results.map((r: any) => r.content).join('\\n\\n')}`);
      }
    } catch {
      // Skip KBs that fail retrieval
    }
  }

  return contexts.join('\\n\\n');
}
