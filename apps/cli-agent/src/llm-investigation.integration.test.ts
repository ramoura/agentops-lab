import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmInvestigationAssistant } from '@agentops/llm-engine';
import type { LlmEngineConfig } from '@agentops/llm-engine';
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
  apiKey: 'sk-ant-fake-integracao',
  model: 'claude-sonnet-5',
  maxTokens: 4096,
  maxRounds: 16,
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
});
