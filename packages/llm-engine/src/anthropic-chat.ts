import Anthropic from '@anthropic-ai/sdk';
import type {
  AssistantContentBlock,
  ChatPort,
  ChatRequest,
  ChatResponse,
} from './chat-port.js';

/**
 * Porta fina sobre `client.messages.create()` do `@anthropic-ai/sdk` — único
 * ponto de contato do lab com o SDK da Anthropic (mesmo padrão de isolamento
 * do `mcp-tool-invoker.ts`): o loop agêntico enxerga apenas `ChatPort`
 * e os tipos `ChatRequest`/`ChatResponse`, substituíveis por fake nos testes
 * (nenhum teste da suíte default toca rede ou gasta tokens).
 */

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
export class AnthropicChatAdapter implements ChatPort {
  constructor(private readonly messages: MessagesApi) {}

  /* c8 ignore next — SDK client construction is an injected composition seam. */
  static fromApiKey(apiKey: string): AnthropicChatAdapter {
    return new AnthropicChatAdapter(new Anthropic({ apiKey }).messages);
  }

  async create(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.messages.create({
      // system e messages são passthrough — inclusive `cache_control`, que o
      // SDK aceita nativamente (recurso GA, sem beta header).
      model: request.model,
      max_tokens: request.max_tokens,
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
        // Ausentes/null no upstream (fake antigo, modelos sem cache) → 0.
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
