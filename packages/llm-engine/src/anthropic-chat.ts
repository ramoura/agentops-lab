import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicToolDefinition } from './tool-mapping.js';

/**
 * Porta fina sobre `client.messages.create()` do `@anthropic-ai/sdk` — único
 * ponto de contato do lab com o SDK da Anthropic (mesmo padrão de isolamento
 * do `mcp-tool-invoker.ts`): o loop agêntico enxerga apenas `AnthropicChatPort`
 * e os tipos `ChatRequest`/`ChatResponse`, substituíveis por fake nos testes
 * (nenhum teste da suíte default toca rede ou gasta tokens).
 */

/** Bloco de conteúdo produzido pelo modelo (assistant). */
export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/** Bloco de conteúdo enviado pelo usuário (pergunta crua ou tool_result). */
export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type ChatMessage =
  | { role: 'user'; content: UserContentBlock[] }
  | { role: 'assistant'; content: AssistantContentBlock[] };

/** Espelho tipado dos parâmetros de `messages.create()` usados pelo motor. */
export interface ChatRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  system: string;
  tools: AnthropicToolDefinition[];
  tool_choice: { type: 'auto' };
  messages: ChatMessage[];
}

/** Uso de tokens de uma rodada (campo `usage` da resposta). */
export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Espelho tipado da resposta de `messages.create()` usada pelo motor. */
export interface ChatResponse {
  content: AssistantContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | (string & {}) | null;
  usage: ChatUsage;
}

/** Única superfície do @anthropic-ai/sdk — substituível por fake nos testes. */
export interface AnthropicChatPort {
  create(request: ChatRequest): Promise<ChatResponse>;
}

/** Fatia do SDK consumida pelo adapter (injetável nos testes do adapter). */
export interface MessagesApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

/**
 * Adapter do SDK oficial. Retries/backoff ficam delegados ao SDK (default de
 * 2 retries para 429/5xx); erros esgotados propagam para o loop, que os
 * converte em `LlmEngineError('api_error')`. A API key vive apenas dentro do
 * client — nunca em logs ou mensagens de erro.
 */
export class AnthropicChatAdapter implements AnthropicChatPort {
  constructor(private readonly messages: MessagesApi) {}

  static fromApiKey(apiKey: string): AnthropicChatAdapter {
    return new AnthropicChatAdapter(new Anthropic({ apiKey }).messages);
  }

  async create(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.messages.create({
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      system: request.system,
      tools: request.tools as unknown as Anthropic.ToolUnion[],
      tool_choice: request.tool_choice,
      messages: request.messages as unknown as Anthropic.MessageParam[],
    });

    return {
      // Só texto e tool_use interessam ao loop; outros tipos de bloco
      // (ex.: thinking) são ignorados no mapeamento.
      content: response.content.flatMap<AssistantContentBlock>((block) => {
        if (block.type === 'text') {
          return [{ type: 'text', text: block.text }];
        }
        if (block.type === 'tool_use') {
          return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input as Record<string, unknown> }];
        }
        return [];
      }),
      stop_reason: response.stop_reason,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }
}
