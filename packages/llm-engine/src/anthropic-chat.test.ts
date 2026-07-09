import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicChatAdapter } from './anthropic-chat.js';
import type { ChatRequest, MessagesApi } from './anthropic-chat.js';

/**
 * Testes do adapter do SDK com um `MessagesApi` fake injetado — nenhuma
 * chamada de rede. O que se valida é o mapeamento requisição/resposta entre a
 * porta (`ChatRequest`/`ChatResponse`) e a superfície do `@anthropic-ai/sdk`.
 */

const REQUEST: ChatRequest = {
  model: 'claude-sonnet-5',
  max_tokens: 4096,
  temperature: 0,
  system: 'prompt de sistema',
  tools: [{ name: 'get_error_summary', description: 'desc', input_schema: { type: 'object' } }],
  tool_choice: { type: 'auto' },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'pergunta' }] }],
};

function fakeMessages(response: Partial<Anthropic.Message>): MessagesApi & { params: unknown[] } {
  const params: unknown[] = [];
  return {
    params,
    async create(p) {
      params.push(p);
      return {
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
        ...response,
      } as Anthropic.Message;
    },
  };
}

describe('AnthropicChatAdapter', () => {
  it('repassa os parâmetros da requisição para messages.create() sem alteração', async () => {
    const messages = fakeMessages({});
    await new AnthropicChatAdapter(messages).create(REQUEST);

    expect(messages.params[0]).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      temperature: 0,
      system: 'prompt de sistema',
      tools: REQUEST.tools,
      tool_choice: { type: 'auto' },
      messages: REQUEST.messages,
    });
  });

  it('mapeia blocos text e tool_use da resposta, ignorando tipos desconhecidos', async () => {
    const messages = fakeMessages({
      content: [
        { type: 'thinking', thinking: 'raciocínio interno', signature: 'sig' } as unknown as Anthropic.ContentBlock,
        { type: 'text', text: 'vou consultar os erros', citations: null } as Anthropic.ContentBlock,
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'get_error_summary',
          input: { service: 'checkout-api' },
        } as Anthropic.ContentBlock,
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 321, output_tokens: 45 } as Anthropic.Usage,
    });

    const response = await new AnthropicChatAdapter(messages).create(REQUEST);

    expect(response).toEqual({
      content: [
        { type: 'text', text: 'vou consultar os erros' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_error_summary', input: { service: 'checkout-api' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 321, output_tokens: 45 },
    });
  });

  it('propaga erros do SDK sem embrulhar (retries são responsabilidade do SDK; api_error é do loop)', async () => {
    const failure = new Error('429 rate limited');
    const messages: MessagesApi = {
      create: async () => {
        throw failure;
      },
    };
    await expect(new AnthropicChatAdapter(messages).create(REQUEST)).rejects.toBe(failure);
  });
});
