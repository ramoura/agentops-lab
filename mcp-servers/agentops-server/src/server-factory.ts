import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KnowledgeProvider, ObservabilityProvider } from '@agentops/types';
import { registerKnowledgeTools } from './knowledge/tools.js';
import { registerObservabilityTools } from './observability/tools.js';

export interface AgentopsServerOptions {
  observability: ObservabilityProvider;
  knowledge: KnowledgeProvider;
}

export const SERVER_NAME = 'agentops-server';
export const SERVER_VERSION = '0.1.0';

/**
 * Factory do MCP server único da v1 (fallback autorizado do RF8): compõe os
 * módulos `observability/` (5 tools) e `knowledge/` (4 tools) em um único
 * server. A separação futura em dois servers é criar um segundo entrypoint
 * chamando apenas o módulo correspondente — a factory e os módulos não mudam.
 */
export function createAgentopsServer(options: AgentopsServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerObservabilityTools(server, options.observability);
  registerKnowledgeTools(server, options.knowledge);
  return server;
}
