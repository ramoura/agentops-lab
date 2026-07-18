import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicChatAdapter } from './anthropic-chat.js';
import type { MessagesApi } from './anthropic-chat.js';
import type { ChatRequest } from './chat-port.js';

/**
 * Testes do adapter do SDK com um `MessagesApi` fake injetado — nenhuma
 * chamada de rede. O que se valida é o mapeamento requisição/resposta entre a
 * porta (`ChatRequest`/`ChatResponse`) e a superfície do `@anthropic-ai/sdk`.
 */

const REQUEST: ChatRequest = {
  model: 'claude-sonnet-5',
  max_tokens: 4096,
  system: [{ type: 'text', text: 'prompt de sistema' }],
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
  it('repassa os parâmetros da requisição para messages.create() sem alteração (e sem sampling params)', async () => {
    const messages = fakeMessages({});
    await new AnthropicChatAdapter(messages).create(REQUEST);

    expect(messages.params[0]).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: [{ type: 'text', text: 'prompt de sistema' }],
      tools: REQUEST.tools,
      tool_choice: { type: 'auto' },
      messages: REQUEST.messages,
    });
    // temperature/top_p/top_k retornam 400 nos modelos atuais — nunca enviados
    expect(messages.params[0]).not.toHaveProperty('temperature');
  });

  // ---------------------------------------------------------------------------
  // Test cases 5–8 da techspec V2.5 (prompt caching)
  // ---------------------------------------------------------------------------

  // Teste 5
  it('system como array de blocos é repassado sem alteração, incluindo cache_control (passthrough)', async () => {
    const messages = fakeMessages({});
    const system: ChatRequest['system'] = [
      { type: 'text', text: 'parte estável' },
      { type: 'text', text: 'fim do system', cache_control: { type: 'ephemeral' } },
    ];

    await new AnthropicChatAdapter(messages).create({ ...REQUEST, system });

    expect((messages.params[0] as { system: unknown }).system).toEqual(system);
  });

  // Teste 6
  it('cache_control em bloco de mensagem (tool_result/text) é repassado sem alteração', async () => {
    const messages = fakeMessages({});
    const request: ChatRequest = {
      ...REQUEST,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'pergunta', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_error_summary', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '{}', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    };

    await new AnthropicChatAdapter(messages).create(request);

    expect((messages.params[0] as { messages: unknown }).messages).toEqual(request.messages);
  });

  // Teste 7 — campos de cache mapeados; ausentes → 0, nunca undefined
  it('usage com campos de cache da resposta → mapeados para ChatUsage', async () => {
    const messages = fakeMessages({
      usage: {
        input_tokens: 812,
        output_tokens: 245,
        cache_creation_input_tokens: 3480,
        cache_read_input_tokens: 11260,
      } as Anthropic.Usage,
    });

    const response = await new AnthropicChatAdapter(messages).create(REQUEST);

    expect(response.usage).toEqual({
      input_tokens: 812,
      output_tokens: 245,
      cache_creation_input_tokens: 3480,
      cache_read_input_tokens: 11260,
    });
  });

  it('usage sem campos de cache (upstream antigo/sem cache) → normalizados para 0, nunca undefined', async () => {
    const messages = fakeMessages({
      usage: { input_tokens: 321, output_tokens: 45 } as Anthropic.Usage,
    });

    const response = await new AnthropicChatAdapter(messages).create(REQUEST);

    expect(response.usage).toEqual({
      input_tokens: 321,
      output_tokens: 45,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(response.usage.cache_creation_input_tokens).not.toBeUndefined();
    expect(response.usage.cache_read_input_tokens).not.toBeUndefined();
  });

  // Teste 8 — regressão: modo off é idêntico à V2, nenhum campo extra
  it('requisição sem nenhum cache_control (modo off) não envia nenhum campo extra (regressão V2)', async () => {
    const messages = fakeMessages({});
    await new AnthropicChatAdapter(messages).create(REQUEST);

    expect(JSON.stringify(messages.params[0])).not.toContain('cache_control');
    expect(Object.keys(messages.params[0] as Record<string, unknown>).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'system',
      'tool_choice',
      'tools',
    ]);
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
      usage: { input_tokens: 321, output_tokens: 45, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
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
