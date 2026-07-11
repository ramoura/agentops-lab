import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InvestigationOutcome, InvestigationTraceRecord } from '@agentops/types';
import { buildTraceRecord } from './trace-log.js';
import {
  TraceViewArgError,
  loadTraceRecords,
  parseArgs,
  renderRecord,
  selectRecords,
  usage,
} from './trace-view.js';

/**
 * Testes do leitor humano do trace (`npm run trace:view`): parsing de
 * argumentos, seleção de registros (por caso/run/trace/último) e leitura
 * tolerante a linhas inválidas. `renderRecord` é coberto por um smoke test —
 * o conteúdo exato já é exercitado pelos testes de `renderReport`/
 * `formatUsageLine` que ele reaproveita.
 */

function record(overrides: Partial<InvestigationTraceRecord> = {}, outcome?: InvestigationOutcome): InvestigationTraceRecord {
  const base = buildTraceRecord({
    source: 'eval',
    runId: 'run-1',
    caseId: 'case-001-database-timeout',
    question: 'Investigue o checkout-api',
    engine: 'llm',
    model: 'claude-sonnet-5',
    outcome: outcome ?? { kind: 'markdown', markdown: '## Resumo executivo\ntexto', audit: [] },
    rounds: [],
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1 },
    evalResult: {
      caseId: 'case-001-database-timeout',
      score: 1,
      passed: true,
      criteria: [{ name: 'finding:x', passed: true, details: 'ok' }],
    },
  });
  return { ...base, ...overrides };
}

describe('parseArgs', () => {
  it('caminho sem opções → seletor "last"', () => {
    expect(parseArgs(['trace.jsonl'])).toEqual({ path: 'trace.jsonl', selector: { kind: 'last' }, all: false });
  });

  it('--case=<id> → seletor "case"', () => {
    expect(parseArgs(['trace.jsonl', '--case=case-001-database-timeout']).selector).toEqual({
      kind: 'case',
      caseId: 'case-001-database-timeout',
    });
  });

  it('--run=<id> → seletor "run"', () => {
    expect(parseArgs(['trace.jsonl', '--run=run-1']).selector).toEqual({ kind: 'run', runId: 'run-1' });
  });

  it('--trace=<id> → seletor "trace"', () => {
    expect(parseArgs(['trace.jsonl', '--trace=trace-1']).selector).toEqual({ kind: 'trace', traceId: 'trace-1' });
  });

  it('--all fica true e não interfere no seletor', () => {
    const options = parseArgs(['trace.jsonl', '--case=x', '--all']);
    expect(options.all).toBe(true);
    expect(options.selector).toEqual({ kind: 'case', caseId: 'x' });
  });

  it('sem caminho → EngineArgError-like (TraceViewArgError)', () => {
    expect(() => parseArgs(['--case=x'])).toThrow(TraceViewArgError);
    expect(() => parseArgs([])).toThrow(/caminho do arquivo de trace é obrigatório/);
  });

  it('opção desconhecida → TraceViewArgError', () => {
    expect(() => parseArgs(['trace.jsonl', '--foo=bar'])).toThrow(TraceViewArgError);
  });

  it('argumento posicional extra → TraceViewArgError', () => {
    expect(() => parseArgs(['trace.jsonl', 'outro.jsonl'])).toThrow(/argumento inesperado/);
  });
});

describe('usage()', () => {
  it('cita o comando e as opções disponíveis', () => {
    const text = usage();
    expect(text).toContain('npm run trace:view');
    expect(text).toContain('--case=');
    expect(text).toContain('--run=');
    expect(text).toContain('--trace=');
    expect(text).toContain('--all');
  });
});

describe('selectRecords', () => {
  const case001a = record({ caseId: 'case-001-database-timeout', runId: 'run-1' });
  const case001b = record({ caseId: 'case-001-database-timeout', runId: 'run-2' });
  const case002 = record({ caseId: 'case-002-payment-api-timeout', runId: 'run-2' });
  const records = [case001a, case001b, case002];

  it('"last" → só o último registro do arquivo', () => {
    expect(selectRecords(records, { path: 'x', selector: { kind: 'last' }, all: false })).toEqual([case002]);
  });

  it('"last" com arquivo vazio → nenhum registro', () => {
    expect(selectRecords([], { path: 'x', selector: { kind: 'last' }, all: false })).toEqual([]);
  });

  it('"case" sem --all → só a ocorrência mais recente daquele caso', () => {
    expect(selectRecords(records, { path: 'x', selector: { kind: 'case', caseId: 'case-001-database-timeout' }, all: false })).toEqual([
      case001b,
    ]);
  });

  it('"case" com --all → todas as ocorrências, na ordem do arquivo', () => {
    expect(selectRecords(records, { path: 'x', selector: { kind: 'case', caseId: 'case-001-database-timeout' }, all: true })).toEqual([
      case001a,
      case001b,
    ]);
  });

  it('"run" → sempre o grupo inteiro, mesmo sem --all', () => {
    expect(selectRecords(records, { path: 'x', selector: { kind: 'run', runId: 'run-2' }, all: false })).toEqual([case001b, case002]);
  });

  it('"trace" → registro exato por traceId', () => {
    expect(selectRecords(records, { path: 'x', selector: { kind: 'trace', traceId: case002.traceId }, all: false })).toEqual([case002]);
  });

  it('filtro sem correspondência → array vazio', () => {
    expect(selectRecords(records, { path: 'x', selector: { kind: 'case', caseId: 'inexistente' }, all: false })).toEqual([]);
  });
});

describe('loadTraceRecords', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentops-trace-view-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lê todos os registros válidos do JSONL compacto (uma linha por registro)', async () => {
    const path = join(dir, 'trace.jsonl');
    const r1 = record({ caseId: 'case-001-database-timeout' });
    const r2 = record({ caseId: 'case-002-payment-api-timeout' });
    await writeFile(path, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`, 'utf8');

    const loaded = await loadTraceRecords(path);

    expect(loaded).toHaveLength(2);
    expect(loaded.map((r) => r.caseId)).toEqual(['case-001-database-timeout', 'case-002-payment-api-timeout']);
  });

  it('lê também quando o arquivo foi reformatado com pretty-print (multi-linha por registro)', async () => {
    const path = join(dir, 'trace.jsonl');
    const r1 = record({ caseId: 'case-001-database-timeout' });
    const r2 = record({ caseId: 'case-002-payment-api-timeout' });
    // `jq .` (sem -c) ou um editor reformatando o arquivo quebra o "uma linha
    // por registro", mas continua sendo uma sequência de valores JSON válidos.
    await writeFile(path, `${JSON.stringify(r1, null, 2)}\n${JSON.stringify(r2, null, 2)}\n`, 'utf8');

    const loaded = await loadTraceRecords(path);

    expect(loaded).toHaveLength(2);
    expect(loaded.map((r) => r.caseId)).toEqual(['case-001-database-timeout', 'case-002-payment-api-timeout']);
  });

  it('ignora JSON malformado e registros fora do schema, sem lançar', async () => {
    const path = join(dir, 'trace.jsonl');
    const valid = record();
    // texto solto sem chaves/colchetes é ruído entre valores (ignorado em silêncio);
    // `{"traceId": }` é sintaticamente inválido mas com chaves balanceadas (gera aviso);
    // `{"foo":"bar"}` é JSON válido, mas fora do schema do trace (gera aviso).
    await writeFile(
      path,
      `${JSON.stringify(valid)}\nnão é json, sem chaves\n{"traceId": }\n${JSON.stringify({ foo: 'bar' })}\n`,
      'utf8',
    );
    const stderrSpy: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderrSpy.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const loaded = await loadTraceRecords(path);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.traceId).toBe(valid.traceId);
      expect(stderrSpy.some((line) => line.includes('não é JSON válido'))).toBe(true);
      expect(stderrSpy.some((line) => line.includes('não corresponde ao schema'))).toBe(true);
    } finally {
      process.stderr.write = original;
    }
  });

  it('arquivo vazio → lista vazia', async () => {
    const path = join(dir, 'vazio.jsonl');
    await writeFile(path, '', 'utf8');

    expect(await loadTraceRecords(path)).toEqual([]);
  });
});

describe('renderRecord (smoke test)', () => {
  it('inclui cabeçalho, critérios do eval e o outcome final, sem cores quando useColor=false', () => {
    const r = record();
    const output = renderRecord(r, false);

    expect(output).toContain(r.traceId);
    expect(output).toContain(r.runId);
    expect(output).toContain('Investigue o checkout-api');
    expect(output).toContain('Score: 1.00');
    expect(output).toContain('[OK] finding:x — ok');
    expect(output).toContain('Resultado final');
    expect(output).toContain('## Resumo executivo');
    expect(output).not.toContain('\x1b[');
  });

  it('outcome "report" reaproveita renderReport (seções do relatório estruturado aparecem)', () => {
    const r = record(
      {},
      {
        kind: 'report',
        report: {
          context: {
            question: 'q',
            service: 'checkout-api',
            window: { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' },
            symptom: null,
          },
          summary: 'resumo do incidente',
          evidences: [],
          primaryHypothesis: null,
          alternativeHypotheses: [],
          safeNextSteps: [],
          missingData: [],
          confidence: 'baixa',
          audit: [],
        },
      },
    );

    const output = renderRecord(r, false);

    expect(output).toContain('resumo do incidente');
  });
});
