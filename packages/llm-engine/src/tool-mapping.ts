import { TOOL_NAMES } from '@agentops/types';
import type { McpToolDefinition } from '@agentops/types';
import { LlmEngineError } from './engine-config.js';
import type { ChatToolDefinition } from './chat-port.js';

/**
 * Mapeamento das definições MCP (`client.listTools()`) para o formato de tool
 * da porta de chat. MCP e os providers usam JSON Schema no mesmo
 * formato — o mapeamento é passthrough; o motor NÃO duplica contratos (as
 * descrições ricas vêm do server em runtime, princípio da skill
 * desenvolver-mcp-tools: o agente escolhe a tool pela descrição).
 */

/**
 * Valida e mapeia as definições descobertas via MCP:
 * - nome fora de `TOOL_NAMES` → erro de inicialização (contrato fechado);
 * - qualquer uma das 9 tools ausente → erro orientativo (contrato de
 *   investigação incompleto);
 * - `annotations.readOnlyHint !== true` → erro (reforço em runtime da
 *   garantia read-only — RF10);
 * - `inputSchema` → `input_schema` por referência (passthrough).
 */
export function mapMcpToolsToChatTools(definitions: McpToolDefinition[]): ChatToolDefinition[] {
  for (const definition of definitions) {
    if (!(TOOL_NAMES as readonly string[]).includes(definition.name)) {
      throw new LlmEngineError(
        'invalid_config',
        `tool desconhecida na inicialização do motor LLM: "${definition.name}" ` +
          `(esperadas: ${TOOL_NAMES.join(', ')}). Verifique a versão do agentops-server.`,
      );
    }
    if (definition.annotations?.readOnlyHint !== true) {
      throw new LlmEngineError(
        'invalid_config',
        `a tool "${definition.name}" não declara annotations.readOnlyHint === true. ` +
          'Todas as tools do agentops-server devem ser read-only (RF10) — verifique a versão do server.',
      );
    }
  }

  const present = new Set(definitions.map((definition) => definition.name));
  const missing = TOOL_NAMES.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new LlmEngineError(
      'invalid_config',
      `o agentops-server não expôs todas as tools do contrato de investigação — faltando: ${missing.join(', ')}. ` +
        'O motor LLM requer as 9 tools; verifique a versão do server.',
    );
  }

  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    input_schema: definition.inputSchema,
  }));
}
