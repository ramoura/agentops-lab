import { describe, expect, it } from 'vitest';
import { ToolInvocationError } from '@agentops/core';
import type { ToolName } from '@agentops/types';
import {
  endTurn,
  FakeAnthropicChat,
  makeUsage,
  mcpDefinitions,
  StubToolInvoker,
  toolUseBlock,
  toolUseRound,
} from './__fixtures__/testing.js';
import type { StubResponse } from './__fixtures__/testing.js';
import type { AssistantContentBlock, ChatRequest, UserContentBlock } from './anthropic-chat.js';
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
  cacheEnabled: true,
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
          // Marker móvel da V2.5 (cache ligado no CONFIG): metadado do bloco,
          // o conteúdo do tool_result permanece intacto
          cache_control: { type: 'ephemeral' },
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
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'timeout do provider',
        is_error: true,
        cache_control: { type: 'ephemeral' },
      },
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
      { content: [{ type: 'text', text: 'relatório trunca…' }], stop_reason: 'max_tokens', usage: makeUsage({ input_tokens: 10, output_tokens: 4096 }) },
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
      { content: [], stop_reason: 'end_turn', usage: makeUsage({ input_tokens: 10, output_tokens: 0 }) },
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
  it('requisição enviada: model, max_tokens, system e tools conforme config/definições; tool_choice auto; sem sampling params', async () => {
    const chat = new FakeAnthropicChat([endTurn(MARKDOWN)]);

    await makeAssistant(chat).investigate(QUESTION, new StubToolInvoker({}));

    const request = chat.requests[0];
    expect(request).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      tool_choice: { type: 'auto' },
    });
    // temperature/top_p/top_k foram removidos da API (claude-sonnet-5+) — 400 se enviados
    expect(request).not.toHaveProperty('temperature');
    // Tools: as 9 definições MCP mapeadas (inputSchema → input_schema)
    const definitions = mcpDefinitions();
    expect(request?.tools.map((tool) => tool.name)).toEqual(definitions.map((definition) => definition.name));
    expect(request?.tools[0]?.input_schema).toEqual(definitions[0]?.inputSchema);
  });

  // Teste 13
  it('a pergunta do usuário entra como primeira mensagem user, crua (sem parser)', async () => {
    const chat = new FakeAnthropicChat([endTurn(MARKDOWN)]);

    await makeAssistant(chat).investigate(QUESTION, new StubToolInvoker({}));

    // Com cache ligado (default), o único bloco da pergunta carrega o marker
    // móvel — metadado do bloco; o texto permanece cru.
    expect(chat.requests[0]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: QUESTION, cache_control: { type: 'ephemeral' } }] },
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

    expect(assistant.lastUsage).toEqual({
      inputTokens: 2500,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      rounds: 2,
    });
    expect(roundsSeen).toEqual([
      [1, 16],
      [2, 16],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Testes da tarefa 1.0 (mini-spec trace-log): captura rodada a rodada em lastTrace
// ---------------------------------------------------------------------------

describe('LlmInvestigationAssistant — lastTrace (trace-log)', () => {
  it('lastTrace começa vazio antes da primeira investigação', () => {
    const chat = new FakeAnthropicChat([endTurn(MARKDOWN)]);
    const assistant = makeAssistant(chat);

    expect(assistant.lastTrace).toEqual([]);
  });

  it('uma entrada por rodada, na ordem; tool_use com toolResults correlacionado por tool_use_id; rodada final com toolResults vazio', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' })]),
      toolUseRound([toolUseBlock('toolu_2', 'get_top_exceptions', { service: 'checkout-api' })]),
      endTurn(MARKDOWN),
    ]);
    const assistant = makeAssistant(chat);

    await assistant.investigate(QUESTION, new StubToolInvoker(stubResponses()));

    expect(assistant.lastTrace.map((r) => r.round)).toEqual([1, 2, 3]);
    expect(assistant.lastTrace[0]).toMatchObject({
      round: 1,
      stopReason: 'tool_use',
      assistantContent: [{ type: 'tool_use', id: 'toolu_1', name: 'get_error_summary', input: { service: 'checkout-api' } }],
      toolResults: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: JSON.stringify({ totalRequests: 412, count5xx: 87 }) },
      ],
    });
    expect(assistant.lastTrace[1]).toMatchObject({
      round: 2,
      stopReason: 'tool_use',
      toolResults: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          content: JSON.stringify({ exceptions: [{ exception: 'DatabaseTimeoutException', count: 78 }] }),
        },
      ],
    });
    expect(assistant.lastTrace[2]).toMatchObject({ round: 3, stopReason: 'end_turn', toolResults: [] });
  });

  it('cache_control nunca aparece em assistantContent/toolResults de nenhum RoundTrace, mesmo com cacheEnabled: true (V2.5)', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' })]),
      endTurn(MARKDOWN),
    ]);
    const assistant = makeAssistant(chat, { ...CONFIG, cacheEnabled: true });

    await assistant.investigate(QUESTION, new StubToolInvoker(stubResponses()));

    expect(JSON.stringify(assistant.lastTrace)).not.toContain('cache_control');
  });
});

// ---------------------------------------------------------------------------
// Test cases 9–16 da techspec V2.5 (prompt caching no loop agêntico)
// ---------------------------------------------------------------------------

/** Total de markers `cache_control` de um request (system + mensagens). */
function markerCount(request: ChatRequest | undefined): number {
  if (request === undefined) {
    return -1;
  }
  const inSystem = request.system.filter((block) => block.cache_control !== undefined).length;
  const inMessages = request.messages
    .flatMap((message): Array<UserContentBlock | AssistantContentBlock> => message.content)
    .filter((block) => block.cache_control !== undefined).length;
  return inSystem + inMessages;
}

/** Cópia do request sem nenhum marker — para comparar byte a byte com o modo off. */
function stripMarkers(request: ChatRequest): ChatRequest {
  const clone = structuredClone(request);
  for (const block of clone.system) {
    delete block.cache_control;
  }
  for (const message of clone.messages) {
    for (const block of message.content) {
      delete block.cache_control;
    }
  }
  return clone;
}

describe('LlmInvestigationAssistant — prompt caching (V2.5)', () => {
  // Teste 9
  it('cache ligado, rodada 1: exatamente 2 breakpoints — último bloco do system e último bloco da pergunta', async () => {
    const chat = new FakeAnthropicChat([endTurn(MARKDOWN)]);

    await makeAssistant(chat).investigate(QUESTION, new StubToolInvoker({}));

    const request = chat.requests[0];
    expect(request?.system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(request?.messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(markerCount(request)).toBe(2);
  });

  // Teste 10
  it('cache ligado, rodada N: breakpoint móvel no último bloco da última mensagem; o da rodada anterior removido — nunca mais de 2 markers', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' })]),
      toolUseRound([toolUseBlock('toolu_2', 'get_top_exceptions', { service: 'checkout-api' })]),
      endTurn(MARKDOWN),
    ]);

    await makeAssistant(chat).investigate(QUESTION, new StubToolInvoker(stubResponses()));

    // Todo request carrega exatamente 2 markers (teto de 4 da API com folga)
    expect(chat.requests.map(markerCount)).toEqual([2, 2, 2]);

    const third = chat.requests[2];
    const lastMessage = third?.messages.at(-1);
    expect(lastMessage?.role).toBe('user');
    expect(lastMessage?.content.at(-1)).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_2',
      cache_control: { type: 'ephemeral' },
    });
    // Markers das rodadas anteriores removidos: nem a pergunta inicial nem o
    // tool_result da rodada 1 carregam cache_control no request da rodada 3
    expect(third?.messages[0]?.content.at(-1)?.cache_control).toBeUndefined();
    expect(third?.messages[2]?.content.at(-1)?.cache_control).toBeUndefined();
  });

  // Teste 11
  it('múltiplos tool_use na mesma rodada → marker móvel apenas no último tool_result da mensagem user seguinte', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([
        toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' }),
        toolUseBlock('toolu_2', 'get_top_exceptions', { service: 'checkout-api' }),
      ]),
      endTurn(MARKDOWN),
    ]);

    await makeAssistant(chat).investigate(QUESTION, new StubToolInvoker(stubResponses()));

    const followUp = chat.requests[1]?.messages.at(-1);
    expect(followUp?.role).toBe('user');
    expect(followUp?.content).toHaveLength(2);
    expect(followUp?.content[0]?.cache_control).toBeUndefined();
    expect(followUp?.content[1]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_2',
      cache_control: { type: 'ephemeral' },
    });
    expect(markerCount(chat.requests[1])).toBe(2);
  });

  // Teste 12
  it('cache desligado (cacheEnabled: false) → nenhum cache_control em nenhum request de nenhuma rodada', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' })]),
      endTurn(MARKDOWN),
    ]);
    const assistant = makeAssistant(chat, { ...CONFIG, cacheEnabled: false });

    await assistant.investigate(QUESTION, new StubToolInvoker(stubResponses()));

    expect(chat.requests).toHaveLength(2);
    expect(chat.requests.map(markerCount)).toEqual([0, 0]);
    // Nenhum campo extra enviado — request idêntico ao da V2
    expect(JSON.stringify(chat.requests)).not.toContain('cache_control');
  });

  // Teste 13
  it('agregação: cacheReadTokens/cacheCreationTokens somam as rodadas; inputTokens só a parcela não cacheada; rounds inalterado', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' })], {
        input_tokens: 15_000,
        output_tokens: 200,
        cache_creation_input_tokens: 3480,
        cache_read_input_tokens: 0,
      }),
      endTurn(MARKDOWN, {
        input_tokens: 812,
        output_tokens: 245,
        cache_creation_input_tokens: 1200,
        cache_read_input_tokens: 11_260,
      }),
    ]);
    const assistant = makeAssistant(chat);

    await assistant.investigate(QUESTION, new StubToolInvoker(stubResponses()));

    expect(assistant.lastUsage).toEqual({
      inputTokens: 15_812,
      outputTokens: 445,
      cacheReadTokens: 11_260,
      cacheCreationTokens: 4680,
      rounds: 2,
    });
  });

  // Teste 14
  it('system e mensagens byte-idênticos com cache ligado ou desligado — só os markers diferem', async () => {
    const script = () => [
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' })]),
      endTurn(MARKDOWN),
    ];
    const chatOn = new FakeAnthropicChat(script());
    const chatOff = new FakeAnthropicChat(script());

    await makeAssistant(chatOn).investigate(QUESTION, new StubToolInvoker(stubResponses()));
    await makeAssistant(chatOff, { ...CONFIG, cacheEnabled: false }).investigate(
      QUESTION,
      new StubToolInvoker(stubResponses()),
    );

    expect(chatOn.requests.map(stripMarkers)).toEqual(chatOff.requests);
  });

  // Teste 15
  it('regressão: audit log (seq, params, resultSummary) idêntico com cache ligado/desligado', async () => {
    const script = () => [
      toolUseRound([
        toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api', ...WINDOW }),
        toolUseBlock('toolu_2', 'get_top_exceptions', { service: 'checkout-api' }),
      ]),
      endTurn(MARKDOWN),
    ];

    const outcomeOn = await makeAssistant(new FakeAnthropicChat(script())).investigate(
      QUESTION,
      new StubToolInvoker(stubResponses()),
    );
    const outcomeOff = await makeAssistant(new FakeAnthropicChat(script()), { ...CONFIG, cacheEnabled: false }).investigate(
      QUESTION,
      new StubToolInvoker(stubResponses()),
    );

    expect(outcomeOn.kind).toBe('markdown');
    expect(outcomeOff).toEqual(expect.objectContaining({ kind: outcomeOn.kind }));
    if (outcomeOn.kind !== 'markdown' || outcomeOff.kind !== 'markdown') {
      return;
    }
    const project = (records: typeof outcomeOn.audit) =>
      records.map(({ seq, tool, params, resultSummary }) => ({ seq, tool, params, resultSummary }));
    expect(project(outcomeOn.audit)).toEqual(project(outcomeOff.audit));
    expect(outcomeOn.markdown).toBe(outcomeOff.markdown);
  });

  // Teste 16
  it('erro da API com cache ligado → LlmEngineError(api_error) com o mesmo envelope da V2', async () => {
    const failure = new Error('529 overloaded');
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api' })]),
      failure,
    ]);

    expect.assertions(4);
    try {
      await makeAssistant(chat).investigate(QUESTION, new StubToolInvoker(stubResponses()));
    } catch (error) {
      expect(error).toBeInstanceOf(LlmEngineError);
      const engineError = error as LlmEngineError;
      expect(engineError.code).toBe('api_error');
      expect(engineError.cause).toBe(failure);
      // Audit das rodadas já executadas preservado no envelope, como na V2
      expect(engineError.audit.map((record) => record.tool)).toEqual(['get_error_summary']);
    }
  });
});
