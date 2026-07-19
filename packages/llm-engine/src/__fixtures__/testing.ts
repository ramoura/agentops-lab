import { TOOL_NAMES } from '@agentops/types';
import type { McpToolDefinition, ToolInvoker, ToolName } from '@agentops/types';
import type { AssistantContentBlock, ChatPort, ChatRequest, ChatResponse, ChatUsage } from '../chat-port.js';

/**
 * Fakes/stubs do motor LLM: toda a lógica do loop agêntico é exercitada sem
 * rede e sem gastar tokens. `FakeAnthropicChat` roteiriza as respostas do
 * modelo; `StubToolInvoker` segue o padrão de `packages/core/src/engine.test.ts`.
 */

export const DEFAULT_USAGE: ChatUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/**
 * `ChatUsage` completo a partir de campos parciais — os de cache default em
 * `0`, como o adapter normaliza. Permite roteirizar respostas com usage de
 * cache: `endTurn(md, { cache_read_input_tokens: 44200 })`.
 */
export function makeUsage(partial: Partial<ChatUsage> = {}): ChatUsage {
  return { ...DEFAULT_USAGE, ...partial };
}

/**
 * Implementa `ChatPort` com um roteiro de respostas. Cada `create()`
 * consome a próxima entrada do roteiro (a última repete quando o roteiro
 * esgota — útil para "sempre devolve tool_use"); `Error` no roteiro rejeita a
 * chamada. As requisições recebidas ficam em `requests` (snapshot profundo,
 * pois o loop muta o array `messages` entre rodadas).
 */
export class FakeAnthropicChat implements ChatPort {
  readonly requests: ChatRequest[] = [];
  private cursor = 0;

  constructor(private readonly script: Array<ChatResponse | Error>) {}

  async create(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    const entry = this.script[Math.min(this.cursor, this.script.length - 1)];
    this.cursor += 1;
    if (entry === undefined) {
      throw new Error('FakeAnthropicChat: roteiro vazio');
    }
    if (entry instanceof Error) {
      throw entry;
    }
    return structuredClone(entry);
  }
}

/** Resposta final do modelo (`end_turn`) com um bloco de texto. */
export function endTurn(text: string, usage: Partial<ChatUsage> = {}): ChatResponse {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: makeUsage(usage) };
}

/** Rodada de tool use: um ou mais blocos `tool_use` (com texto opcional antes). */
export function toolUseRound(blocks: AssistantContentBlock[], usage: Partial<ChatUsage> = {}): ChatResponse {
  return { content: blocks, stop_reason: 'tool_use', usage: makeUsage(usage) };
}

export function toolUseBlock(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Extract<AssistantContentBlock, { type: 'tool_use' }> {
  return { type: 'tool_use', id, name, input };
}

/** Stub de `ToolInvoker` (padrão de `packages/core/src/engine.test.ts`). */
export type StubResponse = unknown | ((params: Record<string, unknown>) => unknown);

export class StubToolInvoker implements ToolInvoker {
  readonly calls: Array<{ tool: ToolName; params: Record<string, unknown> }> = [];

  constructor(private readonly responses: Partial<Record<ToolName, StubResponse>>) {}

  async invoke<TIn, TOut>(tool: ToolName, params: TIn): Promise<TOut> {
    this.calls.push({ tool, params: params as Record<string, unknown> });
    const response = this.responses[tool];
    if (response === undefined) {
      throw new Error(`stub sem resposta para ${tool}`);
    }
    const resolved = typeof response === 'function' ? response(params as Record<string, unknown>) : response;
    if (resolved instanceof Error) {
      throw resolved;
    }
    return resolved as TOut;
  }
}

/** As 9 definições MCP fake (formato de `listTools()`), todas read-only. */
export function mcpDefinitions(): McpToolDefinition[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: `Descrição da tool ${name}`,
    inputSchema: { type: 'object', properties: { service: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  }));
}
