import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InvestigationOutcome, InvestigationTraceRecord } from '@agentops/types';
import { EngineArgError, formatTokenCount, formatUsageLine, resolveEngineArgs, writeInvestigateTrace } from './main.js';
import { appendTraceRecord, buildTraceRecord, generateRunId } from './trace-log.js';

vi.mock('./trace-log.js', () => ({
  appendTraceRecord: vi.fn(),
  buildTraceRecord: vi.fn(),
  generateRunId: vi.fn(() => 'run-fixed-id'),
}));

/**
 * Unitários de `resolveEngineArgs` (teste 23 da techspec V2): seleção de motor
 * por flag + env, com a flag removida dos args restantes (o que sobra é a
 * pergunta). Importar `main.ts` é seguro: o entrypoint só roda quando o módulo
 * é invocado diretamente.
 */

const QUESTION = ['Investigue', 'o', 'checkout-api'];

// Teste 23
describe('resolveEngineArgs', () => {
  it('sem flag e sem env → deterministic (default, custo zero)', () => {
    const { engine, rest } = resolveEngineArgs(QUESTION, {});

    expect(engine).toBe('deterministic');
    expect(rest).toEqual(QUESTION);
  });

  it('--engine=llm → llm, com a flag removida do rest', () => {
    const { engine, rest } = resolveEngineArgs(['--engine=llm', ...QUESTION], {});

    expect(engine).toBe('llm');
    expect(rest).toEqual(QUESTION);
  });

  it('--engine=deterministic explícito também é removido do rest', () => {
    const { engine, rest } = resolveEngineArgs([...QUESTION, '--engine=deterministic'], {});

    expect(engine).toBe('deterministic');
    expect(rest).toEqual(QUESTION);
  });

  it('AGENTOPS_ENGINE=llm sem flag → llm', () => {
    const { engine, rest } = resolveEngineArgs(QUESTION, { AGENTOPS_ENGINE: 'llm' });

    expect(engine).toBe('llm');
    expect(rest).toEqual(QUESTION);
  });

  it('flag vence a env', () => {
    const { engine } = resolveEngineArgs(['--engine=deterministic', ...QUESTION], { AGENTOPS_ENGINE: 'llm' });

    expect(engine).toBe('deterministic');
  });

  it('--engine=foo → erro de uso citando os valores aceitos', () => {
    expect(() => resolveEngineArgs(['--engine=foo', ...QUESTION], {})).toThrow(EngineArgError);
    expect(() => resolveEngineArgs(['--engine=foo'], {})).toThrow(/deterministic, llm/);
  });

  it('--engine sem valor → erro de uso', () => {
    expect(() => resolveEngineArgs(['--engine', ...QUESTION], {})).toThrow(EngineArgError);
  });

  it('AGENTOPS_ENGINE inválida → erro orientativo citando a variável', () => {
    expect(() => resolveEngineArgs(QUESTION, { AGENTOPS_ENGINE: 'foo' })).toThrow(/AGENTOPS_ENGINE inválida/);
  });

  it('AGENTOPS_ENGINE vazia é ignorada (default deterministic)', () => {
    expect(resolveEngineArgs(QUESTION, { AGENTOPS_ENGINE: '  ' }).engine).toBe('deterministic');
  });
});

describe('formatTokenCount', () => {
  it('formata milhares com 1 casa e mantém valores pequenos inteiros', () => {
    expect(formatTokenCount(12437)).toBe('12.4k');
    expect(formatTokenCount(1800)).toBe('1.8k');
    expect(formatTokenCount(999)).toBe('999');
  });
});

// Testes 17–19 (techspec V2.5): linha de custo com detalhe de cache
describe('formatUsageLine', () => {
  // Teste 17
  it('cache > 0 → detalhe de cache lido/escrito entre parênteses', () => {
    const line = formatUsageLine({
      inputTokens: 3900,
      outputTokens: 5100,
      cacheReadTokens: 44200,
      cacheCreationTokens: 9200,
      rounds: 5,
    });

    expect(line).toBe('Tokens: 3.9k entrada (44.2k cache lido · 9.2k cache escrito) · 5.1k saída · 5 rodada(s)');
  });

  // Teste 18
  it('UT-040: provider openai com cache write 0 usa a linha uniforme, sem caminho especial', () => {
    const line = formatUsageLine({
      inputTokens: 57300,
      outputTokens: 5100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      rounds: 5,
    });

    expect(line).toBe('Tokens: 57.3k entrada · 5.1k saída · 5 rodada(s)');
  });

  // Teste 19
  it('campos de cache usam a mesma formatação de formatTokenCount (12.4k)', () => {
    const line = formatUsageLine({
      inputTokens: 500,
      outputTokens: 900,
      cacheReadTokens: 12437,
      cacheCreationTokens: 999,
      rounds: 2,
    });

    expect(line).toContain(`(${formatTokenCount(12437)} cache lido · ${formatTokenCount(999)} cache escrito)`);
    expect(line).toBe('Tokens: 500 entrada (12.4k cache lido · 999 cache escrito) · 900 saída · 2 rodada(s)');
  });
});

const MARKDOWN_OUTCOME: InvestigationOutcome = { kind: 'markdown', markdown: 'texto', audit: [] };
const CLARIFICATION_OUTCOME: InvestigationOutcome = {
  kind: 'clarification',
  missing: [{ field: 'service', hint: 'informe o serviço' }],
};

function fakeRecord(overrides: Partial<InvestigationTraceRecord> = {}): InvestigationTraceRecord {
  return {
    traceId: 'internal-id-descartado',
    runId: 'run-fixed-id',
    timestamp: '2026-07-11T00:00:00.000Z',
    source: 'investigate',
    caseId: null,
    question: 'Investigue o checkout-api',
    engine: 'deterministic',
    model: null,
    outcome: MARKDOWN_OUTCOME,
    audit: [],
    rounds: null,
    usage: null,
    eval: null,
    ...overrides,
  };
}

// Tarefa 2.0: wiring de AGENTOPS_TRACE_LOG em `investigate` (main.ts)
describe('writeInvestigateTrace', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('tracePath ausente (AGENTOPS_TRACE_LOG não definida) → appendTraceRecord não é chamado', async () => {
    await writeInvestigateTrace({
      tracePath: undefined,
      outcome: MARKDOWN_OUTCOME,
      question: 'Investigue o checkout-api',
      engine: 'deterministic',
      model: null,
      llmAssistant: null,
    });

    expect(buildTraceRecord).not.toHaveBeenCalled();
    expect(appendTraceRecord).not.toHaveBeenCalled();
  });

  it('outcome "clarification" → appendTraceRecord não é chamado mesmo com tracePath definido (RF3 fora de escopo)', async () => {
    await writeInvestigateTrace({
      tracePath: '/tmp/trace.jsonl',
      outcome: CLARIFICATION_OUTCOME,
      question: 'por que deu erro?',
      engine: 'deterministic',
      model: null,
      llmAssistant: null,
    });

    expect(buildTraceRecord).not.toHaveBeenCalled();
    expect(appendTraceRecord).not.toHaveBeenCalled();
  });

  it('tracePath definido + outcome não-clarification → grava registro com runId === traceId (uma investigação avulsa é seu próprio run)', async () => {
    vi.mocked(buildTraceRecord).mockReturnValueOnce(fakeRecord({ engine: 'llm', model: 'claude-sonnet-5' }));

    await writeInvestigateTrace({
      tracePath: '/tmp/trace.jsonl',
      outcome: MARKDOWN_OUTCOME,
      question: 'Investigue o checkout-api',
      engine: 'llm',
      model: 'claude-sonnet-5',
      llmAssistant: null,
    });

    expect(generateRunId).toHaveBeenCalledTimes(1);
    expect(buildTraceRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'investigate',
        runId: 'run-fixed-id',
        caseId: null,
        engine: 'llm',
        model: 'claude-sonnet-5',
        evalResult: null,
      }),
    );
    expect(appendTraceRecord).toHaveBeenCalledTimes(1);
    const [path, record] = vi.mocked(appendTraceRecord).mock.calls[0] ?? [];
    expect(path).toBe('/tmp/trace.jsonl');
    expect(record?.traceId).toBe('run-fixed-id');
    expect(record?.runId).toBe('run-fixed-id');
  });

  it('falha ao gravar (appendTraceRecord rejeita) → aviso em stderr, sem lançar', async () => {
    vi.mocked(buildTraceRecord).mockReturnValueOnce(fakeRecord());
    vi.mocked(appendTraceRecord).mockRejectedValueOnce(new Error('disk full'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      writeInvestigateTrace({
        tracePath: '/tmp/trace.jsonl',
        outcome: MARKDOWN_OUTCOME,
        question: 'q',
        engine: 'deterministic',
        model: null,
        llmAssistant: null,
      }),
    ).resolves.toBeUndefined();

    expect(stderrSpy.mock.calls.some(([chunk]) => String(chunk).includes('Aviso: falha ao gravar o trace'))).toBe(true);
    stderrSpy.mockRestore();
  });
});
