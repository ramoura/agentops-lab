import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatPort, ChatResponse, LlmEngineConfig } from '@agentops/llm-engine';
import { mcpDefinitions } from '@agentops/llm-engine/testing';
import type { EvalCase, McpToolDefinition } from '@agentops/types';
import {
  CompareInvocationError,
  parseCompareArgs,
  renderCompareTable,
  runCompare,
} from './compare-runner.js';
import type { CompareEntry, CompareInvoker, CompareRow } from './compare-runner.js';
import { loadCases } from './runner.js';

const usage = {
  input_tokens: 100,
  output_tokens: 25,
  cache_creation_input_tokens: 4,
  cache_read_input_tokens: 6,
};

const successfulMarkdown = (evalCase: EvalCase): string => [
  '## Resumo executivo',
  'Investigação concluída.',
  '## Evidências encontradas',
  ...evalCase.expected_findings.map((finding) => `- ${Array.isArray(finding) ? finding[0] : finding}\n  Fonte: fake (fixture)`),
  '## Hipótese principal',
  'Hipótese baseada nas evidências.',
  '## Hipóteses alternativas',
  '- Outra hipótese possível.',
  '## Próximos passos seguros',
  '- Verificar os dados e comparar o diff.',
  '## Dados faltantes',
  '- Nenhum dado adicional.',
  '## Confiança da análise',
  'média',
].join('\n');

class FakeInvoker implements CompareInvoker {
  closed = false;

  async listTools(): Promise<McpToolDefinition[]> {
    return mcpDefinitions();
  }

  async invoke<TIn, TOut>(_tool: string, _params: TIn): Promise<TOut> {
    return {} as TOut;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function endTurn(markdown: string): ChatResponse {
  return { content: [{ type: 'text', text: markdown }], stop_reason: 'end_turn', usage };
}

function baseRow(overrides: Partial<CompareRow> = {}): CompareRow {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    status: 'ok',
    score: 0.92,
    criteria: [
      { name: 'cita_evidencias', passed: true },
      { name: 'proximos_passos_seguros', passed: true },
    ],
    completed: null,
    rounds: 4,
    usage: { inputTokens: 12100, outputTokens: 3800, cacheReadTokens: 18400, cacheCreationTokens: 0, rounds: 4 },
    ...overrides,
  };
}

describe('parseCompareArgs', () => {
  it('UT-044: parses eval entries in input order', () => {
    expect(parseCompareArgs(['--models=anthropic:claude-sonnet-5,openai:gpt-4o-mini'])).toEqual({
      entries: [
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        { provider: 'openai', model: 'gpt-4o-mini' },
      ],
      question: null,
    });
  });

  it('UT-045 and UT-049: parses and rejects an explicit empty ad-hoc question', () => {
    expect(parseCompareArgs(['--models=anthropic', 'Investigue os 5xx']).question).toBe('Investigue os 5xx');
    expect(() => parseCompareArgs(['--models=anthropic', ''])).toThrow(CompareInvocationError);
  });

  it('UT-046: splits only at the first colon and resolves the Anthropic default', () => {
    expect(parseCompareArgs(['--models=openrouter:deepseek/deepseek-chat:free,anthropic']).entries).toEqual([
      { provider: 'openrouter', model: 'deepseek/deepseek-chat:free' },
      { provider: 'anthropic', model: 'claude-sonnet-5' },
    ]);
  });

  it('UT-047/048: reports orientative invocation errors', () => {
    for (const argv of [[], ['--models='], ['--models=groq:x'], ['--models=openai']]) {
      expect(() => parseCompareArgs(argv)).toThrow(/--models=provider:modelo/);
    }
  });

  it('UT-050: preserves duplicate entries', () => {
    const result = parseCompareArgs(['--models=openai:gpt-test,openai:gpt-test']);
    expect(result.entries).toEqual([
      { provider: 'openai', model: 'gpt-test' },
      { provider: 'openai', model: 'gpt-test' },
    ]);
  });
});

describe('renderCompareTable', () => {
  it('UT-051: renders eval score, criteria, resources and total', () => {
    const table = renderCompareTable([baseRow(), baseRow({ provider: 'openai', model: 'gpt-test', score: 0.75 })], 'eval');
    expect(table).toContain('## Comparação (eval)');
    expect(table).toContain('Score');
    expect(table).toContain('cita_evidencias');
    expect(table).toContain('Tokens (in/out)');
    expect(table).toContain('Total:');
    expect(table).toContain('evidência de 1 execução por modelo');
  });

  it('UT-052: renders ad-hoc without any score column', () => {
    const table = renderCompareTable([baseRow({ score: null, criteria: null, completed: true })], 'adhoc');
    expect(table).toContain('## Comparação de recursos (ad-hoc) — sem score de qualidade');
    expect(table).not.toMatch(/\| Score \|/);
    expect(table).toContain('Concluiu');
  });

  it('UT-053: isolates failed row metrics', () => {
    const table = renderCompareTable([baseRow({ status: 'missing_api_key' }), baseRow()], 'eval');
    const failedLine = table.split('\n').find((line) => line.includes('missing_api_key')) ?? '';
    expect(failedLine).toContain('—');
    expect(failedLine).not.toContain('0.92');
    expect(table).toContain('claude-sonnet-5');
  });

  it('UT-054/055: supports one row and strips ANSI sequences', () => {
    const table = renderCompareTable([baseRow({ model: '\u001b[31mred\u001b[0m' })], 'eval');
    expect(table).toContain('| red |');
    expect(table).not.toContain('\u001b[');
  });
});

describe('runCompare', () => {
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  function testFactories(markdownsByModel: Map<string, string | ((call: number) => ChatResponse)>) {
    const invokers: FakeInvoker[] = [];
    const calls = new Map<string, number>();
    const chatPortFactory = (config: LlmEngineConfig): ChatPort => ({
      create: async () => {
        const call = (calls.get(config.model) ?? 0) + 1;
        calls.set(config.model, call);
        const scripted = markdownsByModel.get(config.model);
        if (typeof scripted === 'function') return scripted(call);
        return endTurn(scripted ?? '## Resumo executivo\n## Evidências encontradas\n## Hipótese principal\n## Hipóteses alternativas\n## Próximos passos seguros\n- Verificar\n## Dados faltantes\n- Nenhum\n## Confiança da análise\nbaixa');
      },
    });
    const invokerFactory = async (): Promise<CompareInvoker> => {
      const invoker = new FakeInvoker();
      invokers.push(invoker);
      return invoker;
    };
    return { chatPortFactory, invokerFactory, invokers, calls };
  }

  it('IT-004/012: runs eval entries sequentially and aggregates usage', async () => {
    const cases = await loadCases();
    const factories = testFactories(new Map([['claude-sonnet-5', successfulMarkdown(cases[0] as EvalCase)], ['gpt-test', successfulMarkdown(cases[0] as EvalCase)]]));
    // The same compact report is sufficient to exercise the orchestration; score criteria are deterministic.
    const output: string[] = [];
    const rows = await runCompare({
      entries: [{ provider: 'anthropic', model: 'claude-sonnet-5' }, { provider: 'openai', model: 'gpt-test' }],
      question: null,
      env: { ANTHROPIC_API_KEY: 'fake', OPENAI_API_KEY: 'fake' },
      chatPortFactory: factories.chatPortFactory,
      invokerFactory: factories.invokerFactory,
      out: (line) => output.push(line),
      err: () => {},
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'ok')).toBe(true);
    expect(rows[0]?.score).toBeDefined();
    expect(output[0]).toContain('Comparação (eval)');
    expect(factories.invokers.every((invoker) => invoker.closed)).toBe(true);
  }, 90_000);

  it('IT-005/006: confines missing credentials and API errors to their rows', async () => {
    const cases = await loadCases();
    const good = successfulMarkdown(cases[0] as EvalCase);
    let failingCalls = 0;
    const factories = testFactories(new Map<string, string | ((call: number) => ChatResponse)>([
      ['claude-sonnet-5', good],
      ['gpt-test', () => {
        failingCalls += 1;
        if (failingCalls === 2) throw new Error('provider down');
        return endTurn(good);
      }],
    ]));
    const rows = await runCompare({
      entries: [
        { provider: 'openai', model: 'gpt-test' },
        { provider: 'anthropic', model: 'claude-sonnet-5' },
      ],
      question: null,
      env: { ANTHROPIC_API_KEY: 'fake' },
      chatPortFactory: factories.chatPortFactory,
      invokerFactory: factories.invokerFactory,
      out: () => {},
      err: () => {},
    });
    expect(rows[0]?.status).toBe('missing_api_key');
    expect(rows[1]?.status).toBe('ok');
  }, 90_000);

  it('IT-007: ad-hoc rows never receive a score', async () => {
    const factories = testFactories(new Map([['claude-sonnet-5', '## Resumo executivo\ntexto']]));
    const rows = await runCompare({
      entries: [{ provider: 'anthropic', model: 'claude-sonnet-5' }],
      question: 'pergunta ambígua',
      env: { ANTHROPIC_API_KEY: 'fake' },
      chatPortFactory: factories.chatPortFactory,
      invokerFactory: factories.invokerFactory,
      out: () => {},
      err: () => {},
    });
    expect(rows[0]).toMatchObject({ status: 'ok', score: null, criteria: null, completed: true });
  });

  it('IT-007: isolates max_rounds_exceeded in ad-hoc mode', async () => {
    const loop = (): ChatResponse => ({
      content: [{ type: 'tool_use', id: 'call-1', name: 'get_error_summary', input: { service: 'checkout-api' } }],
      stop_reason: 'tool_use',
      usage,
    });
    const factories = testFactories(new Map<string, string | ((call: number) => ChatResponse)>([
      ['claude-sonnet-5', '## Resumo executivo\nfinal'],
      ['loop', loop],
    ]));
    const rows = await runCompare({
      entries: [{ provider: 'anthropic', model: 'claude-sonnet-5' }, { provider: 'openai', model: 'loop' }],
      question: 'pergunta ad-hoc',
      env: { ANTHROPIC_API_KEY: 'fake', OPENAI_API_KEY: 'fake', AGENTOPS_LLM_MAX_ROUNDS: '2' },
      chatPortFactory: factories.chatPortFactory,
      invokerFactory: factories.invokerFactory,
      out: () => {},
      err: () => {},
    });
    expect(rows[0]?.status).toBe('ok');
    expect(rows[1]).toMatchObject({ status: 'max_rounds_exceeded', score: null, usage: null });
  });

  it('IT-010: continues when connecting one invoker fails and closes opened invokers', async () => {
    const cases = await loadCases();
    const factories = testFactories(new Map([['claude-sonnet-5', successfulMarkdown(cases[0] as EvalCase)]]));
    let attempts = 0;
    const invokerFactory = async (): Promise<CompareInvoker> => {
      attempts += 1;
      if (attempts === 1) throw new Error('MCP unavailable');
      return factories.invokerFactory();
    };
    const rows = await runCompare({
      entries: [{ provider: 'anthropic', model: 'broken' }, { provider: 'anthropic', model: 'claude-sonnet-5' }],
      question: null,
      env: { ANTHROPIC_API_KEY: 'fake' },
      chatPortFactory: factories.chatPortFactory,
      invokerFactory,
      out: () => {},
      err: () => {},
    });
    expect(rows[0]?.status).toBe('api_error');
    expect(rows[1]?.status).toBe('ok');
    expect(factories.invokers.every((invoker) => invoker.closed)).toBe(true);
  });

  it('IT-012: renders six entries and sums their resource totals', async () => {
    const cases = await loadCases();
    const model = successfulMarkdown(cases[0] as EvalCase);
    const entries: CompareEntry[] = Array.from({ length: 6 }, (_, index) => ({ provider: 'anthropic', model: `model-${index}` }));
    const factories = testFactories(new Map(entries.map((entry) => [entry.model, model])));
    const output: string[] = [];
    const rows = await runCompare({
      entries,
      question: null,
      env: { ANTHROPIC_API_KEY: 'fake' },
      chatPortFactory: factories.chatPortFactory,
      invokerFactory: factories.invokerFactory,
      out: (line) => output.push(line),
      err: () => {},
    });
    expect(rows).toHaveLength(6);
    expect(output[0]?.split('\n').filter((line) => line.startsWith('| model-'))).toHaveLength(6);
    expect(output[0]).toContain('Total:');
  }, 90_000);

  it('IT-008/009/010: writes provider-distinct traces, runs duplicates, and closes every invoker', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'compare-runner-'));
    const tracePath = join(temporaryDirectory, 'trace.jsonl');
    const cases = await loadCases();
    const good = successfulMarkdown(cases[0] as EvalCase);
    const factories = testFactories(new Map([
      ['claude-sonnet-5', good],
      ['anthropic/claude-sonnet-5', good],
    ]));
    const rows = await runCompare({
      entries: [
        { provider: 'anthropic', model: 'claude-sonnet-5' },
        { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
        { provider: 'anthropic', model: 'claude-sonnet-5' },
      ],
      question: null,
      env: { ANTHROPIC_API_KEY: 'fake', OPENROUTER_API_KEY: 'fake' },
      traceLogPath: tracePath,
      chatPortFactory: factories.chatPortFactory,
      invokerFactory: factories.invokerFactory,
      out: () => {},
      err: () => {},
    });
    expect(rows).toHaveLength(3);
    expect(factories.invokers).toHaveLength(3);
    expect(factories.invokers.every((invoker) => invoker.closed)).toBe(true);
    const records = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { source: string; provider: string });
    expect(records.every((record) => record.source === 'compare')).toBe(true);
    expect(records.some((record) => record.provider === 'openrouter')).toBe(true);
  }, 90_000);
});
