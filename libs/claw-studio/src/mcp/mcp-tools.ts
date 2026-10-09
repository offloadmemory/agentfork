import { tool, type StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
// Deep subpaths are deliberate: the barrel would pull agent-studio's WhatsApp and
// Telegram node executors (and their transitive deps) into claw-studio's test graph
// — see the alias rationale in vitest.config.ts.
//
// @ts-ignore on each — same false positive as
// libs/whatsapp/src/processor/agent-executor.ts. When Nx builds this project it
// rewrites tsconfig `paths` to each dependency's dist/ output, turning these into
// dist/libs/agent-studio/<subpath>, which cannot resolve because agent-studio's
// compiled tree nests under dist/libs/agent-studio/libs/agent-studio/src/. The
// imports resolve correctly everywhere they actually run: `tsc -p
// tsconfig.lib.json` passes clean (which is what apps/workers/Dockerfile uses),
// and Next.js resolves them from source. The nx build target is the only context
// where they fail, and nothing consumes its output.
// @ts-ignore
import { McpServerService } from '@chatbot/agent-studio/services/mcp-server-service';
// @ts-ignore
import { McpClientService } from '@chatbot/agent-studio/services/mcp-client.service';
// @ts-ignore
import type { McpServer, McpServerConfig } from '@chatbot/agent-studio/types/mcp-server';
import { getPrismaClient, createLogger } from '@chatbot/shared';

const logger = createLogger('claw-studio:mcp-tools');

function jsonSchemaPropertyToZod(prop: any, required: boolean): z.ZodTypeAny {
  let zodType: z.ZodTypeAny;
  switch (prop?.type) {
    case 'string':
      zodType = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
      break;
    case 'number':
    case 'integer':
      zodType = z.number();
      break;
    case 'boolean':
      zodType = z.boolean();
      break;
    case 'array':
      zodType = prop.items ? z.array(jsonSchemaPropertyToZod(prop.items, true)) : z.array(z.any());
      break;
    case 'object':
      zodType = prop.properties ? jsonSchemaToZodObject(prop) : z.record(z.string(), z.any());
      break;
    default:
      zodType = z.any();
  }
  if (prop?.description) zodType = zodType.describe(prop.description);
  return required ? zodType : zodType.optional();
}

function jsonSchemaToZodObject(schema: any): z.ZodObject<any> {
  if (!schema?.properties) return z.object({});
  const required: string[] = schema.required || [];
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
    shape[key] = jsonSchemaPropertyToZod(prop, required.includes(key));
  }
  return z.object(shape);
}

function slugForName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** The outcome of trying to reach one registered MCP server. */
export interface McpServerStatus {
  name: string;
  /** The `mcp_<slug>_` prefix every tool from this server carries. */
  slug: string;
  description: string | null;
  connected: boolean;
  toolCount: number;
  /**
   * The namespaced names of the tools discovered on this server.
   *
   * Carried so `connectedCapabilitiesSection` can spell them out in the prompt.
   * A count and a prefix told the model a server existed but not what it was
   * FOR — this tenant's server has an empty description, so "show me my
   * holdings" had nothing to match on and reached `get_holdings_data` in one run
   * out of six. Empty when `connected` is false.
   */
  toolNames: string[];
  /** Why it could not be reached. Present only when `connected` is false. */
  error?: string;
}

export interface McpToolsResult {
  tools: StructuredTool[];
  /**
   * Every ACTIVE server the tenant has registered, connected or not.
   *
   * Returning the failures is the point. A server that cannot be reached used to
   * be logged as a warn and dropped, so it contributed no tools and left no trace
   * anywhere the user or the model could see — a connected-but-unreachable Grafana
   * was indistinguishable from no Grafana at all, and the model would go and
   * improvise with web browsing instead of saying the integration was down.
   */
  servers: McpServerStatus[];
  cleanup: () => Promise<void>;
}

/**
 * Bridges the tenant's registered MCP servers (shared with Agent Studio via
 * @chatbot/agent-studio's McpServer registry) into LangChain tools for Claw's
 * executor graph. Connects fresh McpClientService instances per call — the
 * returned cleanup() must be invoked when the run ends (success, error, or
 * cancel) so connections don't outlive the request.
 */
export async function createMcpTools(tenantId: string): Promise<McpToolsResult> {
  const db = getPrismaClient();
  const service = new McpServerService(tenantId, db as any);

  let servers: McpServer[] = [];
  try {
    const result = await service.findMany({ status: 'active' });
    servers = result.items;
  } catch (error) {
    logger.error({ error, tenantId }, 'Failed to list MCP servers — returning no MCP tools');
    return { tools: [], servers: [], cleanup: async () => {} };
  }

  const clients: McpClientService[] = [];
  const tools: StructuredTool[] = [];
  const statuses: McpServerStatus[] = [];

  for (const server of servers) {
    const client = new McpClientService();
    const slug = slugForName(server.name);
    try {
      const config = server.config as McpServerConfig;
      const discovered = await client.discoverTools(config);
      clients.push(client);

      for (const t of discovered) {
        const namespacedName = `mcp_${slugForName(server.name)}_${t.name}`.slice(0, 64);
        let zodSchema: z.ZodObject<any>;
        try {
          zodSchema = jsonSchemaToZodObject(t.inputSchema || {});
        } catch {
          zodSchema = z.object({}).passthrough();
        }

        tools.push(
          tool(
            async (input: Record<string, unknown>) => {
              try {
                const result = await client.executeTool(t.name, input);
                return typeof result === 'string' ? result : JSON.stringify(result);
              } catch (error: any) {
                logger.error({ error, server: server.name, tool: t.name }, '[mcp] tool execution failed');
                return `Error executing MCP tool "${t.name}": ${error.message}`;
              }
            },
            { name: namespacedName, description: `[MCP: ${server.name}] ${t.description || t.name}`, schema: zodSchema },
          ),
        );
      }
      statuses.push({
        name: server.name,
        slug,
        description: server.description ?? null,
        connected: true,
        toolCount: discovered.length,
        // The namespaced form, matching what is actually bound — a bare
        // `get_holdings_data` in the prompt is a name the model cannot call.
        // `t` is annotated because the @ts-ignore above leaves `discovered` as any,
        // which otherwise makes this parameter implicitly any. Mirrors McpDiscoveredTool.
        toolNames: discovered.map((t: { name: string }) => `mcp_${slug}_${t.name}`.slice(0, 64)),
      });
      logger.info({ tenantId, server: server.name, toolCount: discovered.length }, '[mcp] connected and discovered tools');
    } catch (error: any) {
      // ERROR, not warn. A server the operator deliberately registered and marked
      // active failing to connect is a broken configuration, not a routine event —
      // it was previously indistinguishable from normal operation in the logs.
      logger.error(
        { error: error?.message, tenantId, server: server.name },
        '[mcp] failed to connect — its tools are unavailable for this run',
      );
      statuses.push({
        name: server.name,
        slug,
        description: server.description ?? null,
        connected: false,
        toolCount: 0,
        toolNames: [],
        error: error?.message ? String(error.message) : 'Could not connect',
      });
    }
  }

  const cleanup = async () => {
    await Promise.allSettled(clients.map((c) => c.disconnect()));
  };

  return { tools, servers: statuses, cleanup };
}
