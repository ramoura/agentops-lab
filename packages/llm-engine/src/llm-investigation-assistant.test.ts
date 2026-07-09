import { describe, expect, it } from 'vitest';
import { ToolInvocationError } from '@agentops/core';
import type { ToolName } from '@agentops/types';
import {
  endTurn,
  FakeAnthropicChat,
  mcpDefinitions,
  StubToolInvoker,
  toolUseBlock,
  toolUseRound,
} from './__fixtures__/testing.js';
import type { StubResponse } from './__fixtures__/testing.js';
import { LlmEngineError } from './engine-config.js';
import type { LlmEngineConfig } from './engine-config.js';
import { LlmInvestigationAssistant } from './llm-investigation-assistant.js';

// ---------------------------------------------------------------------------
// Test cases 1–13 da techspec V2 (loop agêntico)
// ---------------------------------------------------------------------------

const QUESTION = 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08';
const SYSTEM_PROMPT = 'system prompt de teste';
const WINDOW = { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' };
const MARKDOWN = '## Resumo executivo\nO checkout-api apresentou pico de 5xx…';

const CONFIG: LlmEngineConfig = {
  apiKey: 'sk-ant-teste',
  model: 'claude-sonnet-5',
  maxTokens: 4096,
  maxRounds: 16,
  temperature: 0,
};

function stubResponses(): Partial<Record<ToolName, StubResponse>> {
  return {
    get_error_summary: { totalRequests: 412, count5xx: 87 },
    get_top_exceptions: { exceptions: [{ exception: 'DatabaseTimeoutException', count: 78 }] },
    get_recent_logs: { logs: [], totalMatched: 0, truncated: false },
  };
}

function makeAssistant(chat: FakeAnthropicChat, config: LlmEngineConfig = CONFIG): LlmInvestigationAssistant {
  return new LlmInvestigationAssistant(chat, async () => mcpDefinitions(), config, SYSTEM_PROMPT);
}

describe('LlmInvestigationAssistant — loop agêntico', () => {
  // Teste 1
  it('resposta única end_turn sem tool_use → outcome markdown com o texto do modelo e audit vazio', async () => {
    const chat = new FakeAnthropicChat([endTurn(MARKDOWN)]);
    const stub = new StubToolInvoker({});

    const outcome = await makeAssistant(chat).investigate(QUESTION, stub);

    expect(outcome).toEqual({ kind: 'markdown', markdown: MARKDOWN, audit: [] });
    expect(stub.calls).toEqual([]);
    expect(chat.requests).toHaveLength(1);
  });

  // Teste 2
  it('uma rodada de tool_use → tool invocada com os argumentos exatos, tool_result com o tool_use_id correspondente e markdown da 2ª rodada', async () => {
    const args = { service: 'checkout-api', ...WINDOW };
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', args)]),
      endTurn(MARKDOWN),
    ]);
    const stub = new StubToolInvoker(stubResponses());

    const outcome = await makeAssistant(chat).investigate(QUESTION, stub);

    expect(stub.calls).toEqual([{ tool: 'get_error_summary', params: args }]);
    const secondRequest = chat.requests[1];
    expect(secondRequest?.messages).toHaveLength(3);
    expect(secondRequest?.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: JSON.stringify({ totalRequests: 412, count5xx: 87 }),
        },
      ],
    });
    expect(outcome).toMatchObject({ kind: 'markdown', markdown: MARKDOWN });
  });

  // Teste 3
  it('múltiplos blocos tool_use na mesma resposta → todas invocadas na ordem; um tool_result por id, na mesma mensagem user', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([
        toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' }),
        toolUseBlock('toolu_2', 'get_top_exceptions', { service: 'checkout-api' }),
      ]),
      endTurn(MARKDOWN),
    ]);
    const stub = new StubToolInvoker(stubResponses());

    await makeAssistant(chat).investigate(QUESTION, stub);

    expect(stub.calls.map((call) => call.tool)).toEqual(['get_error_summary', 'get_top_exceptions']);
    const followUp = chat.requests[1]?.messages[2];
    expect(followUp?.role).toBe('user');
    expect(followUp?.content.map((block) => (block.type === 'tool_result' ? block.tool_use_id : block.type))).toEqual([
      'toolu_1',
      'toolu_2',
    ]);
  });

  // Teste 4
  it('encadeamento multi-rodada (3+) → histórico cresce com assistant/user alternados e conteúdo preservado', async () => {
    const rounds = [
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' })]),
      toolUseRound([toolUseBlock('toolu_2', 'get_top_exceptions', { service: 'checkout-api' })]),
      toolUseRound([toolUseBlock('toolu_3', 'get_recent_logs', { service: 'checkout-api' })]),
    ];
    const chat = new FakeAnthropicChat([...rounds, endTurn(MARKDOWN)]);
    const stub = new StubToolInvoker(stubResponses());

    const outcome = await makeAssistant(chat).investigate(QUESTION, stub);

    expect(chat.requests).toHaveLength(4);
    const finalMessages = chat.requests[3]?.messages ?? [];
    // 1 user (pergunta) + 3 × (assistant tool_use + user tool_result)
    expect(finalMessages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    // Conteúdo preservado: cada turno assistant carrega os blocos tool_use da rodada
    expect(finalMessages[1]?.content).toEqual(rounds[0]?.content);
    expect(finalMessages[3]?.content).toEqual(rounds[1]?.content);
    expect(finalMessages[5]?.content).toEqual(rounds[2]?.content);
    expect(outcome.kind).toBe('markdown');
  });

  // Teste 5
  it('ToolInvocationError → tool_result com is_error: true e a mensagem; o loop continua e produz o outcome final (RF14)', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' })]),
      endTurn(MARKDOWN),
    ]);
    const stub = new StubToolInvoker({
      get_error_summary: new ToolInvocationError('get_error_summary', 'timeout do provider'),
    });

    const outcome = await makeAssistant(chat).investigate(QUESTION, stub);

    expect(chat.requests[1]?.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'timeout do provider', is_error: true },
    ]);
    expect(outcome).toMatchObject({ kind: 'markdown', markdown: MARKDOWN });
  });

  // Teste 6
  it('tool desconhecida pedida pelo modelo → tool_result is_error "tool desconhecida", sem invocar o ToolInvoker', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'delete_production_db', { confirm: true })]),
      endTurn(MARKDOWN),
    ]);
    const stub = new StubToolInvoker(stubResponses());

    const outcome = await makeAssistant(chat).investigate(QUESTION, stub);

    expect(stub.calls).toEqual([]);
    const result = chat.requests[1]?.messages[2]?.content[0];
    expect(result).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      is_error: true,
      content: expect.stringContaining('tool desconhecida'),
    });
    expect(outcome.kind).toBe('markdown');
  });

  // Teste 7
  it('auditoria por código: ToolCallRecord com seq incremental, params e durationMs; falha vira "ERRO: …" (RF7)', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([
        toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api', ...WINDOW }),
        toolUseBlock('toolu_2', 'get_top_exceptions', { service: 'checkout-api' }),
      ]),
      endTurn(MARKDOWN),
    ]);
    const stub = new StubToolInvoker({
      ...stubResponses(),
      get_top_exceptions: new ToolInvocationError('get_top_exceptions', 'provider indisponível'),
    });

    const outcome = await makeAssistant(chat).investigate(QUESTION, stub);

    expect(outcome.kind).toBe('markdown');
    if (outcome.kind !== 'markdown') {
      return;
    }
    expect(outcome.audit).toHaveLength(2);
    expect(outcome.audit.map((record) => record.seq)).toEqual([1, 2]);
    expect(outcome.audit[0]).toMatchObject({
      tool: 'get_error_summary',
      params: { service: 'checkout-api', ...WINDOW },
      resultSummary: '412 req, 87x 5xx',
    });
    expect(outcome.audit[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.audit[1]).toMatchObject({
      tool: 'get_top_exceptions',
      resultSummary: 'ERRO: provider indisponível',
    });
  });

  // Teste 8
  it('maxRounds excedido → LlmEngineError(max_rounds_exceeded) com o audit das rodadas executadas preservado', async () => {
    // O roteiro repete a última entrada: o fake sempre devolve tool_use
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_loop', 'get_error_summary', { service: 'checkout-api' })]),
    ]);
    const stub = new StubToolInvoker(stubResponses());
    const assistant = makeAssistant(chat, { ...CONFIG, maxRounds: 3 });

    expect.assertions(4);
    try {
      await assistant.investigate(QUESTION, stub);
    } catch (error) {
      expect(error).toBeInstanceOf(LlmEngineError);
      const engineError = error as LlmEngineError;
      expect(engineError.code).toBe('max_rounds_exceeded');
      expect(engineError.message).toContain('AGENTOPS_LLM_MAX_ROUNDS');
      // 3 rodadas executadas → 3 chamadas de tool auditadas, preservadas no erro
      expect(engineError.audit.map((record) => record.seq)).toEqual([1, 2, 3]);
    }
  });

  // Teste 9
  it("stop_reason 'max_tokens' → LlmEngineError(max_tokens_reached)", async () => {
    const chat = new FakeAnthropicChat([
      { content: [{ type: 'text', text: 'relatório trunca…' }], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 4096 } },
    ]);

    await expect(makeAssistant(chat).investigate(QUESTION, new StubToolInvoker({}))).rejects.toMatchObject({
      name: 'LlmEngineError',
      code: 'max_tokens_reached',
      message: expect.stringContaining('AGENTOPS_LLM_MAX_TOKENS'),
    });
  });

  // Teste 10
  it('end_turn sem bloco de texto → LlmEngineError(empty_response)', async () => {
    const chat = new FakeAnthropicChat([
      { content: [], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 0 } },
    ]);

    await expect(makeAssistant(chat).investigate(QUESTION, new StubToolInvoker({}))).rejects.toMatchObject({
      name: 'LlmEngineError',
      code: 'empty_response',
    });
  });

  // Teste 11
  it('erro da API (rejeição do port) → LlmEngineError(api_error) com a causa encadeada', async () => {
    const failure = new Error('500 internal server error');
    const chat = new FakeAnthropicChat([failure]);

    expect.assertions(3);
    try {
      await makeAssistant(chat).investigate(QUESTION, new StubToolInvoker({}));
    } catch (error) {
      expect(error).toBeInstanceOf(LlmEngineError);
      expect((error as LlmEngineError).code).toBe('api_error');
      expect((error as LlmEngineError).cause).toBe(failure);
    }
  });

  // Teste 12
  it('requisição enviada: model, max_tokens, temperature 0, system e tools conforme config/definições; tool_choice auto', async () => {
    const chat = new FakeAnthropicChat([endTurn(MARKDOWN)]);

    await makeAssistant(chat).investigate(QUESTION, new StubToolInvoker({}));

    const request = chat.requests[0];
    expect(request).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tool_choice: { type: 'auto' },
    });
    // Tools: as 9 definições MCP mapeadas (inputSchema → input_schema)
    const definitions = mcpDefinitions();
    expect(request?.tools.map((tool) => tool.name)).toEqual(definitions.map((definition) => definition.name));
    expect(request?.tools[0]?.input_schema).toEqual(definitions[0]?.inputSchema);
  });

  // Teste 13
  it('a pergunta do usuário entra como primeira mensagem user, crua (sem parser)', async () => {
    const chat = new FakeAnthropicChat([endTurn(MARKDOWN)]);

    await makeAssistant(chat).investigate(QUESTION, new StubToolInvoker({}));

    expect(chat.requests[0]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: QUESTION }] },
    ]);
  });

  // Agregação de usage (linha de custo em stderr — subtarefa 2.6) + hook de rodada
  it('agrega usage das rodadas em lastUsage e notifica onRound por rodada', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' })], {
        input_tokens: 1000,
        output_tokens: 200,
      }),
      endTurn(MARKDOWN, { input_tokens: 1500, output_tokens: 300 }),
    ]);
    const roundsSeen: Array<[number, number]> = [];
    const assistant = new LlmInvestigationAssistant(
      chat,
      async () => mcpDefinitions(),
      CONFIG,
      SYSTEM_PROMPT,
      { onRound: (round, maxRounds) => roundsSeen.push([round, maxRounds]) },
    );

    expect(assistant.lastUsage).toBeNull();
    await assistant.investigate(QUESTION, new StubToolInvoker(stubResponses()));

    expect(assistant.lastUsage).toEqual({ inputTokens: 2500, outputTokens: 500, rounds: 2 });
    expect(roundsSeen).toEqual([
      [1, 16],
      [2, 16],
    ]);
  });
});
