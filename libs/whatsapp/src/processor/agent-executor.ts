import type { PrismaClient } from '@prisma/client';
import { createLLMProvider, streamChat, buildBuiltInTools } from '@chatbot/ai';
import { LlmProviderService, TenantConfigService, createLogger } from '@chatbot/shared';
import type { AgentExecutor } from './message-processor';

const logger = createLogger('whatsapp:agent-executor');

export type LlmProviderFactory = (config: { model: string; temperature?: number; tenantId: string }) => {
  chat(params: { messages: Array<{ role: string; content: string }>; maxTokens?: number }): Promise<{ text: string }>;
};

export class WhatsAppAgentExecutor implements AgentExecutor {
  private readonly prisma: PrismaClient;
  private readonly providerFactory: LlmProviderFactory;

  constructor(prisma: PrismaClient, providerFactory: LlmProviderFactory) {
    this.prisma = prisma;
    this.providerFactory = providerFactory;
  }

  async execute(
    agentId: string,
    message: { text?: string; mediaUrl?: string; mediaType?: string; mediaId?: string },
    context: Record<string, unknown>,
  ): Promise<{ text: string }> {
    const agent = await (this.prisma as any).agent.findFirst({
      where: { id: agentId },
    });

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    logger.info({ agentId, tenantId: context.tenantId, agentType: agent.type }, 'Executing agent');

    if (agent.type === 'simple') {
      return this.executeSimpleAgent(agent, message, context);
    }

    if (agent.type === 'graph') {
      return this.executeGraphAgent(agent, message, context);
    }

    throw new Error(`Unsupported agent type: ${agent.type}`);
  }

  private async executeSimpleAgent(
    agent: { id: string; config: any },
    message: { text?: string },
    context: Record<string, unknown>,
  ): Promise<{ text: string }> {
    const config = agent.config as { model: string; systemPrompt: string; temperature?: number; maxTokens?: number };
    const tenantId = (context.tenantId as string) ?? '';

    logger.debug({ agentId: agent.id, tenantId }, 'Executing simple agent');

    // Resolve LLM provider
    const llmConfig = await this.resolveLlmConfig(tenantId, config.model);
    const llmProvider = createLLMProvider(llmConfig);

    // Build conversation history
    const history = (context.messages as Array<{ role: string; content: string }>) ?? [];
    const userMessage = message.text ?? '';

    // Query KB → inject context into system prompt
    const kbContext = await this.buildKbContext(agent.id, tenantId, userMessage);
    let effectiveSystem = config.systemPrompt;
    if (kbContext) {
      effectiveSystem = `${effectiveSystem}\n\nUse the following retrieved context to answer questions. If the context does not contain the answer, say so.\n\n${kbContext}`;
    }

    // Load MCP + built-in tools
    // @ts-ignore — dynamic import to avoid circular dependency at build time.
    // Same reason as the GraphExecutor import below. agent-studio imports this
    // file's sibling executors (./whatsapp-send-executor and the template one), so
    // this file is part of agent-studio's compile. When Nx builds agent-studio it
    // rewrites tsconfig `paths` to each dependency's dist/ output, which maps
    // @chatbot/agent-studio/server to dist/libs/agent-studio/server — that does not
    // exist yet, because it is the very project being built. Resolution succeeds at
    // runtime everywhere else (Next.js and the web-ui Dockerfile both resolve it from
    // source via tsconfig.base.json), so the build-time error is a false positive.
    const { buildMcpToolsForAgent } = await import('@chatbot/agent-studio/server');
    const { tools: mcpTools, cleanup: mcpCleanup } = await buildMcpToolsForAgent(agent.id, tenantId, this.prisma);
    try {
      const tenantConfigService = new TenantConfigService(tenantId);
      const builtInTools = await buildBuiltInTools(tenantId, {
        configResolver: { get: (key: string) => tenantConfigService.get(key) },
      });
      const allTools = { ...mcpTools, ...builtInTools };
      const hasTools = Object.keys(allTools).length > 0;

      // Build message array
      const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
        ...history.map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
      ];
      if (userMessage) {
        messages.push({ role: 'user' as const, content: userMessage });
      }

      logger.info({ agentId: agent.id, tenantId, toolCount: Object.keys(allTools).length }, 'Calling streamChat');
      const result = streamChat({
        provider: llmProvider,
        messages,
        system: effectiveSystem,
        model: config.model,
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
        ...(hasTools ? { tools: allTools, maxSteps: 5 } : {}),
      });
      const text = await result.text;
      logger.info({ agentId: agent.id, tenantId, textLength: text.length }, 'streamChat completed');
      return { text };
    } finally {
      await mcpCleanup();
    }
  }

  private async resolveLlmConfig(tenantId: string, modelId?: string) {
    if (!tenantId) return null;
    const llmProviderService = new LlmProviderService(tenantId);
    if (modelId) {
      const providers = await llmProviderService.list();
      for (const p of providers) {
        const models = (p.models as { models?: Array<{ id: string }> } | null)?.models ?? [];
        if (models.some((m: { id: string }) => m.id === modelId)) {
          return llmProviderService.getConfigById(p.id);
        }
      }
    }
    return (await llmProviderService.getDefaultConfig()) ?? (await new TenantConfigService(tenantId).get('llmConfig'));
  }

  private async buildKbContext(agentId: string, tenantId: string, query: string): Promise<string> {
    if (!query) return '';
    try {
      const attachments = await (this.prisma as any).agentKnowledgeBase.findMany({
        where: { agentId },
        include: { knowledgeBase: true },
      });
      if (!attachments?.length) return '';
      const { RetrievalService } = await import('@chatbot/knowledge-base');
      const retrieval = new RetrievalService(tenantId);
      const contexts: string[] = [];
      for (const att of attachments) {
        const kb = att.knowledgeBase;
        if (kb.status !== 'active') continue;
        try {
          const results = await retrieval.query(query, { knowledgeBaseId: kb.id, topK: 5 });
          if (results.length > 0) {
            contexts.push(`--- From ${kb.name} ---\n${results.map((r: any) => r.content).join('\n\n')}`);
          }
        } catch (error) {
          logger.warn({ agentId, tenantId, error }, 'KB retrieval failed');
        }
      }
      return contexts.join('\n\n');
    } catch {
      return '';
    }
  }

  private async executeGraphAgent(
    agent: { id: string; config: any },
    message: { text?: string; mediaId?: string; mediaType?: string },
    context: Record<string, unknown>,
  ): Promise<{ text: string }> {
    // @ts-ignore — dynamic import to avoid circular dependency at build time
    const { GraphExecutor, createNodeExecutors } = await import('@chatbot/agent-studio/server');

    const graphDef = agent.config as { nodes: any[]; edges: any[] };

    const entryNode =
      graphDef.nodes.find((n: any) => n.type === 'whatsapp_trigger') ??
      graphDef.nodes.find((n: any) => graphDef.edges.every((e: any) => e.target !== n.id));

    if (!entryNode) throw new Error(`Graph agent ${agent.id} has no entry node`);

    const initialState = {
      channels: {
        wa_sender_id: context['wa_sender_id'] ?? '',
        wa_message_text: message.text ?? '',
        wa_message_type: context['wa_message_type'] ?? 'text',
        wa_media_id: context['wa_media_id'] ?? null,
        wa_phone_number_id: context['wa_phone_number_id'] ?? '',
        wa_account_id: context['wa_account_id'] ?? '',
        wa_session_id: context['wa_session_id'] ?? '',
        wa_within_window: context['wa_within_window'] ?? false,
        messages: (context['messages'] as any[]) ?? [],
      },
      messages: [
        ...((context['messages'] as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) ?? []),
        ...(message.text ? [{ role: 'user' as const, content: message.text }] : []),
      ],
      currentNodeId: entryNode.id as string,
      metadata: {
        executionId: crypto.randomUUID(),
        agentId: agent.id,
        tenantId: (context['tenantId'] as string) ?? '',
        userId: 'whatsapp',
        startedAt: new Date(),
      },
    };

    const tenantId = (context['tenantId'] as string) ?? '';
    const executor = new GraphExecutor({
      llmProvider: async (_providerId?: string, modelId?: string) => {
        const llmConfig = await this.resolveLlmConfig(tenantId, modelId);
        return createLLMProvider(llmConfig);
      },
      prisma: this.prisma,
    });

    for (const nodeExecutor of createNodeExecutors()) {
      executor.register(nodeExecutor);
    }

    const finalState = await executor.executeFromState(
      graphDef,
      initialState,
      initialState.metadata,
    );

    if (finalState.channels['wa_last_sent_message_id']) {
      return { text: '' };
    }

    const responseText =
      String(finalState.channels['response'] ?? finalState.channels['llm_output'] ?? '');

    return { text: responseText };
  }
}
