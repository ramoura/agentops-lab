import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolInvocationError } from '@agentops/core';
import { TOOL_NAMES } from '@agentops/types';
import type { McpToolDefinition, ToolInvoker, ToolName } from '@agentops/types';

export type { McpToolDefinition } from '@agentops/types';

/**
 * Único ponto de contato da CLI com o SDK MCP (lado consumidor): isola a
 * superfície do SDK v1.x para que a migração v2 fique localizada neste arquivo
 * (decisão da techspec / skill `desenvolver-mcp-tools`).
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** O server TypeScript é spawnado direto via tsx — sem etapa de build. */
const DEFAULT_SERVER_ARGS = [
  join(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
  join(repoRoot, 'mcp-servers/agentops-server/src/main.ts'),
];

/**
 * Falha ao iniciar/conectar o agentops-server (spawn ou handshake do
 * protocolo). A CLI converte em mensagem orientativa — nunca stack trace cru.
 */
export class McpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

export interface McpToolInvokerOptions {
  /** Destino do stderr do server (logs de diagnóstico). Default: `inherit`. */
  serverStderr?: 'inherit' | 'ignore';
  /**
   * Variáveis extras para o processo filho do server, mescladas sobre o ambiente
   * default seguro do SDK (`getDefaultEnvironment`). Usado pelo runner red-team
   * (V2.7) para injetar `AGENTOPS_DATASETS_DIR`/`AGENTOPS_KNOWLEDGE_BASE_DIR` e
   * servir as fixtures adversariais isoladas. Nunca propaga `ANTHROPIC_API_KEY`.
   */
  env?: Record<string, string>;
}

/**
 * Adapta `Client.callTool()` do SDK MCP para a interface `ToolInvoker` do
 * engine: sucesso devolve o `structuredContent` tipado; `isError: true` e
 * falhas de protocolo viram `ToolInvocationError`, que o engine degrada para
 * `missingData` sem abortar a investigação (RF14).
 */
export class McpToolInvoker implements ToolInvoker {
  private constructor(private readonly client: Client) {}

  /** Spawna o agentops-server como processo filho (MCP via stdio) e conecta. */
  static async connect(options: McpToolInvokerOptions = {}): Promise<McpToolInvoker> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: DEFAULT_SERVER_ARGS,
      stderr: options.serverStderr ?? 'inherit',
      env: options.env === undefined ? undefined : { ...getDefaultEnvironment(), ...options.env },
    });
    const client = new Client({ name: 'agentops-cli', version: '0.1.0' });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new McpConnectionError(
        `não foi possível iniciar o agentops-server via stdio: ${errorMessage(error)}`,
      );
    }
    return new McpToolInvoker(client);
  }

  async invoke<TIn, TOut>(tool: ToolName, params: TIn): Promise<TOut> {
    let result: CallToolResult;
    try {
      result = (await this.client.callTool({
        name: tool,
        arguments: params as Record<string, unknown>,
      })) as CallToolResult;
    } catch (error) {
      throw new ToolInvocationError(tool, `falha de protocolo MCP: ${errorMessage(error)}`);
    }

    if (result.isError === true) {
      throw new ToolInvocationError(tool, firstText(result) || 'a tool retornou erro sem mensagem');
    }
    if (result.structuredContent === undefined) {
      throw new ToolInvocationError(tool, 'resposta sem structuredContent');
    }
    return result.structuredContent as TOut;
  }

  /**
   * Descobre as definições das tools do server via `client.listTools()` do
   * SDK MCP (nome + descrição + JSON Schema), para consumo pelo motor LLM
   * (RF12/RF13). Nome fora de `TOOL_NAMES` → erro: o contrato de investigação
   * é fechado, tool desconhecida indica server/versão incompatível.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    let tools: Awaited<ReturnType<Client['listTools']>>['tools'];
    try {
      ({ tools } = await this.client.listTools());
    } catch (error) {
      throw new McpConnectionError(`falha ao listar as tools do agentops-server: ${errorMessage(error)}`);
    }

    return tools.map((tool) => {
      if (!isKnownToolName(tool.name)) {
        throw new McpConnectionError(
          `o agentops-server expôs uma tool desconhecida: "${tool.name}" (esperadas: ${TOOL_NAMES.join(', ')})`,
        );
      }
      return {
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      };
    });
  }

  /** Encerra a conexão e o processo filho do server. */
  async close(): Promise<void> {
    await this.client.close();
  }
}

function isKnownToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function firstText(result: CallToolResult): string {
  const first = result.content?.[0];
  return first?.type === 'text' ? first.text : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
