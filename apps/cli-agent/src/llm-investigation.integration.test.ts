import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmInvestigationAssistant } from '@agentops/llm-engine';
import type { AssistantContentBlock, LlmEngineConfig, UserContentBlock } from '@agentops/llm-engine';
import { endTurn, FakeAnthropicChat, toolUseBlock, toolUseRound } from '@agentops/llm-engine/testing';
import { McpToolInvoker } from './mcp-tool-invoker.js';

/**
 * Integração do loop LLM com o MCP real e modelo fake (techspec V2): o
 * `FakeAnthropicChat` roteiriza o modelo pedindo `get_error_summary` e
 * `get_top_exceptions` do cenário checkout-api, e o `McpToolInvoker` real
 * (agentops-server via stdio) responde com os dados dos datasets versionados.
 * Prova a integração loop ↔ MCP sem custo de tokens.
 */

const QUESTION = 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08';
const WINDOW = { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' };
const MARKDOWN = '## Resumo executivo\nPico de 5xx no checkout-api correlacionado ao deploy 2026.07.08-1.';

const CONFIG: LlmEngineConfig = {
  provider: 'anthropic',
  baseUrl: null,
  apiKey: 'sk-ant-fake-integracao',
  model: 'claude-sonnet-5',
  maxTokens: 4096,
  maxRounds: 16,
  cacheEnabled: true,
};

let invoker: McpToolInvoker;

beforeAll(async () => {
  invoker = await McpToolInvoker.connect({ serverStderr: 'inherit' });
}, 60_000);

afterAll(async () => {
  await invoker?.close();
});

describe('loop LLM com MCP real e modelo fake', () => {
  it('tool_results carregam dados reais dos datasets, audit tem 2 registros e o markdown final é gerado', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([
        toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api', ...WINDOW }),
        toolUseBlock('toolu_2', 'get_top_exceptions', { service: 'checkout-api', ...WINDOW }),
      ]),
      endTurn(MARKDOWN),
    ]);
    const assistant = new LlmInvestigationAssistant(chat, () => invoker.listTools(), CONFIG, 'system prompt de teste');

    const outcome = await assistant.investigate(QUESTION, invoker);

    // tools da requisição vieram do listTools() real (9 definições com descrição do server)
    expect(chat.requests[0]?.tools).toHaveLength(9);

    // V2.5: cache ligado (default) → todo request carrega exatamente 2
    // breakpoints — o estável no último bloco do system e o móvel no último
    // bloco da última mensagem — mesmo com as definições reais das 9 tools.
    for (const request of chat.requests) {
      expect(request.system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
      expect(request.messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
      const markers = [
        ...request.system.filter((block) => block.cache_control !== undefined),
        ...request.messages
          .flatMap((message): Array<UserContentBlock | AssistantContentBlock> => message.content)
          .filter((block) => block.cache_control !== undefined),
      ];
      expect(markers).toHaveLength(2);
    }
    // Rodada 2: o marker móvel migrou para o último tool_result (toolu_2);
    // o da pergunta inicial foi removido
    expect(chat.requests[1]?.messages[0]?.content.at(-1)?.cache_control).toBeUndefined();
    expect(chat.requests[1]?.messages.at(-1)?.content.at(-1)).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_2',
      cache_control: { type: 'ephemeral' },
    });

    // tool_results da 2ª rodada contêm os dados reais dos datasets (case-001)
    const followUp = chat.requests[1]?.messages[2];
    expect(followUp?.role).toBe('user');
    const [errorSummaryResult, topExceptionsResult] = (followUp?.content ?? []).map((block) =>
      block.type === 'tool_result' ? block : undefined,
    );
    expect(errorSummaryResult?.tool_use_id).toBe('toolu_1');
    expect(errorSummaryResult?.is_error).toBeUndefined();
    const errorSummary = JSON.parse(errorSummaryResult?.content ?? '{}') as Record<string, unknown>;
    expect(errorSummary['hasData']).toBe(true);
    expect(errorSummary['service']).toBe('checkout-api');
    expect(errorSummary['count5xx'] as number).toBeGreaterThan(0);

    expect(topExceptionsResult?.tool_use_id).toBe('toolu_2');
    expect(topExceptionsResult?.content).toContain('DatabaseTimeoutException');

    // Audit com 2 registros, na ordem das chamadas (RF7 coletado por código)
    expect(outcome.kind).toBe('markdown');
    if (outcome.kind !== 'markdown') {
      return;
    }
    expect(outcome.audit.map((record) => ({ seq: record.seq, tool: record.tool }))).toEqual([
      { seq: 1, tool: 'get_error_summary' },
      { seq: 2, tool: 'get_top_exceptions' },
    ]);
    expect(outcome.markdown).toBe(MARKDOWN);
  }, 30_000);

  // V2.5 (regressão): cache desligado → requests idênticos aos da V2, mesmo
  // audit e mesmo outcome — ligar/desligar cache não muda o comportamento.
  it('com cacheEnabled: false, nenhum request carrega cache_control e audit/outcome permanecem os da V2', async () => {
    const chat = new FakeAnthropicChat([
      toolUseRound([toolUseBlock('toolu_1', 'get_error_summary', { service: 'checkout-api', ...WINDOW })]),
      endTurn(MARKDOWN),
    ]);
    const assistant = new LlmInvestigationAssistant(
      chat,
      () => invoker.listTools(),
      { ...CONFIG, cacheEnabled: false },
      'system prompt de teste',
    );

    const outcome = await assistant.investigate(QUESTION, invoker);

    expect(chat.requests).toHaveLength(2);
    expect(JSON.stringify(chat.requests)).not.toContain('cache_control');
    expect(outcome.kind).toBe('markdown');
    if (outcome.kind !== 'markdown') {
      return;
    }
    expect(outcome.audit.map((record) => ({ seq: record.seq, tool: record.tool }))).toEqual([
      { seq: 1, tool: 'get_error_summary' },
    ]);
    expect(outcome.markdown).toBe(MARKDOWN);
  }, 30_000);
});
