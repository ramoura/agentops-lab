import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LlmEngineError } from '@agentops/llm-engine';
import type { LlmUsage } from '@agentops/llm-engine';
import { investigationTraceRecordSchema } from '@agentops/types';
import type { InvestigationAssistant, InvestigationOutcome, ToolCallRecord, ToolName } from '@agentops/types';
import { auditFromOutcome, loadCases, runEvals } from './runner.js';
import type { EvalRunSummary } from './runner.js';

/**
 * Integração do runner (teste 70 da techspec V1 + testes 36–38 da V2):
 * `runEvals()` executa os 3 casos reais pelo client MCP real (server spawnado
 * via stdio); o modo default permanece o da V1 e o modo llm aplica o
 * `TextReportScorer` sobre o markdown do assistant (aqui, um fake — nenhum
 * teste da suíte gasta tokens).
 */

describe('runEvals() sobre os 3 casos', () => {
  let summary: EvalRunSummary;
  const outLines: string[] = [];
  const errLines: string[] = [];

  it('executa os casos com case-001 em score 1.0 e 0 termos proibidos', async () => {
    summary = await runEvals({
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    });

    expect(summary.results).toHaveLength(3);
    expect(summary.passedCount).toBe(3);
    expect(summary.averageScore).toBe(1);
    expect(summary.averageTrajectoryScore).toBe(1);
    expect(summary.results.map((result) => result.outcome.caseId)).toEqual([
      'case-001-database-timeout',
      'case-002-payment-api-timeout',
      'case-003-missing-data',
    ]);

    const case001 = summary.results[0];
    expect(case001?.outcome.score).toBe(1);
    expect(case001?.outcome.passed).toBe(true);
    expect(case001?.trajectory?.passed).toBe(true);
    expect(case001?.trajectory?.metrics.total_calls).toBeGreaterThan(0);
    // 0 termos proibidos: todos os critérios `proibido:*` aprovados
    const forbidden = case001?.outcome.criteria.filter((criterion) => criterion.name.startsWith('proibido:')) ?? [];
    expect(forbidden.length).toBeGreaterThan(0);
    expect(forbidden.every((criterion) => criterion.passed)).toBe(true);

    // Breakdown de critérios por caso na saída (RF27), não apenas o agregado
    const output = outLines.join('\n');
    expect(output).toContain('case-001-database-timeout — outcome 1.00');
    expect(output).toContain('Trajetória — score 1.00');
    expect(output).toContain('trajectory:required:latency_baseline');
    expect(output).toContain('trajectory:no_exact_duplicates');
    expect(output).toContain('Métricas:');
    expect(output).toContain('[OK] finding:DatabaseTimeoutException');
    expect(output).toContain('[OK] proibido:certeza absoluta');
    expect(output).toContain('[OK] cita_evidencias');
    expect(output).toContain('[OK] separa_fato_de_hipotese');
    expect(output).toContain('[OK] proximos_passos_seguros');
    expect(output).toContain('Resumo:');

    // Progresso separado dos resultados (stderr ≠ stdout)
    expect(errLines.join('\n')).toContain('case-001-database-timeout');
    // Teste 21 (V2.5): modo deterministic não emite linha de cache
    expect(errLines.join('\n')).not.toContain('Cache:');
  }, 90_000);
});

/** Markdown roteirizado por caso: contrato de formato + findings do cenário. */
function scriptedMarkdown(question: string): string {
  if (question.includes('checkout-api')) {
    return [
      '## Resumo executivo',
      'Pico de 5xx no checkout-api correlacionado ao deploy 2026.07.08-1 (esgotamento do connection pool).',
      '## Evidências encontradas',
      '1. DatabaseTimeoutException dominante em POST /checkout; p99 elevado após o deploy.',
      '   Fonte: get_top_exceptions (exceptions[0])',
      '## Hipótese principal',
      'Regressão do deploy afetando o connection pool.',
      '## Hipóteses alternativas',
      '- Degradação do banco.',
      '## Próximos passos seguros',
      '1. Comparar o diff do deploy com a versão anterior.',
      '## Dados faltantes',
      '- Métricas internas do banco.',
      '## Confiança da análise',
      'alta',
    ].join('\n');
  }
  if (question.includes('payment-api')) {
    return [
      '## Resumo executivo',
      'Timeouts no payment-api causados por dependência externa.',
      '## Evidências encontradas',
      '1. PaymentGatewayTimeoutException em POST /payments; p99 acima do normal.',
      '   Fonte: get_top_exceptions (exceptions[0])',
      '## Hipótese principal',
      'Instabilidade da dependência externa (gateway de pagamento).',
      '## Hipóteses alternativas',
      '- Saturação de rede.',
      '## Próximos passos seguros',
      '1. Verificar o status page do gateway.',
      '## Dados faltantes',
      '- Métricas do lado do gateway.',
      '## Confiança da análise',
      'media',
    ].join('\n');
  }
  return [
    '## Resumo executivo',
    'Não há registros de erro para o inventory-api na janela consultada.',
    '## Evidências encontradas',
    '## Hipótese principal',
    'Nenhuma hipótese pôde ser formulada.',
    '## Hipóteses alternativas',
    'Nenhuma.',
    '## Próximos passos seguros',
    '1. Confirmar o nome do serviço e a janela consultada.',
    '## Dados faltantes',
    '- Não há registros de erro para o inventory-api.',
    '- Não há métricas de latência para a janela.',
    '## Confiança da análise',
    'baixa',
  ].join('\n');
}

class FakeLlmAssistant implements InvestigationAssistant {
  async investigate(question: string): Promise<InvestigationOutcome> {
    return { kind: 'markdown', markdown: scriptedMarkdown(question), audit: scriptedAudit(question) };
  }
}

function scriptedAudit(question: string): ToolCallRecord[] {
  const service = question.includes('checkout-api')
    ? 'checkout-api'
    : question.includes('payment-api')
      ? 'payment-api'
      : 'inventory-api';
  const incidentFrom = question.includes('payment-api')
    ? '2026-07-08T14:00:00-03:00'
    : '2026-07-08T10:00:00-03:00';
  const incidentTo = question.includes('payment-api')
    ? '2026-07-08T14:20:00-03:00'
    : '2026-07-08T10:30:00-03:00';
  const baselineFrom = question.includes('payment-api')
    ? '2026-07-08T13:40:00-03:00'
    : '2026-07-08T09:30:00-03:00';
  const calls: Array<{ tool: ToolName; params: Record<string, unknown> }> = [
    { tool: 'get_error_summary', params: { service } },
    { tool: 'get_top_exceptions', params: { service } },
    { tool: 'get_recent_logs', params: { service, level: 'ERROR' } },
    { tool: 'get_latency_summary', params: { service, from: incidentFrom, to: incidentTo } },
    { tool: 'get_latency_summary', params: { service, from: baselineFrom, to: incidentFrom } },
    { tool: 'get_deployment_events', params: { service } },
  ];
  if (service === 'checkout-api') {
    calls.push({ tool: 'search_runbooks', params: { query: 'checkout-api 5xx' } });
    calls.push({ tool: 'get_runbook', params: { name: 'checkout-api-high-5xx' } });
  }
  return calls.map((call, index) => ({
    seq: index + 1,
    tool: call.tool,
    params: call.params,
    resultSummary: 'OK',
    durationMs: 1,
  }));
}

class RedundantFakeLlmAssistant extends FakeLlmAssistant {
  override async investigate(question: string): Promise<InvestigationOutcome> {
    const outcome = await super.investigate(question);
    if (outcome.kind !== 'markdown') return outcome;
    const first = outcome.audit[0];
    return first === undefined
      ? outcome
      : { ...outcome, audit: [...outcome.audit, { ...first, seq: outcome.audit.length + 1 }] };
  }
}

// Testes 36 (modo llm) e 37 + integração "eval runner com engine fake"
// + teste 22 (V2.5): fake sem `lastUsage` → runner não quebra, linha omitida
describe('runEvals({ engine: "llm", assistant: fake }) sobre os 3 casos', () => {
  it('aplica o TextReportScorer, imprime o breakdown e o resumo indica engine: llm', async () => {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const summary = await runEvals({
      engine: 'llm',
      assistant: new FakeLlmAssistant(),
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    });

    expect(summary.engine).toBe('llm');
    expect(summary.results).toHaveLength(3);
    expect(summary.passedCount).toBe(3);
    expect(summary.averageScore).toBe(1);
    expect(summary.averageTrajectoryScore).toBe(1);

    const output = outLines.join('\n');
    // Breakdown por critério (RF27) vindo do TextReportScorer (linha "Fonte:")
    expect(output).toContain('[OK] finding:DatabaseTimeoutException');
    expect(output).toContain('[OK] finding:Sem registros — encontrado no relatório via variante "Não há registros"');
    expect(output).toContain(
      '[OK] finding:Sem métricas de latência — encontrado no relatório via variante "não há métricas de latência"',
    );
    expect(output).toContain('[OK] cita_evidencias');
    expect(output).toContain('[OK] proximos_passos_seguros');
    // Resumo indica o engine usado
    expect(output).toContain('Resumo: 3/3 outcome(s) aprovado(s) · score médio 1.00');

    // Teste 22 (V2.5): instrumentação opcional — fake sem `lastUsage` não
    // quebra o runner e a linha de cache é simplesmente omitida.
    expect(errLines.join('\n')).not.toContain('Cache:');
  }, 90_000);

  it('mantém outcome aprovado quando redundância reprova apenas a trajetória', async () => {
    const summary = await runEvals({
      engine: 'llm',
      assistant: new RedundantFakeLlmAssistant(),
      out: () => {},
      err: () => {},
    });
    expect(summary.passedCount).toBe(3);
    expect(summary.averageScore).toBe(1);
    expect(summary.results.every((result) => result.outcome.passed)).toBe(true);
    expect(summary.results.every((result) => result.trajectory?.passed === false)).toBe(true);
    expect(summary.averageTrajectoryScore).toBeLessThan(1);
  }, 90_000);
});

/** Fake llm que expõe `lastUsage` (mesma superfície do assistant concreto). */
class FakeLlmAssistantWithUsage extends FakeLlmAssistant {
  readonly lastUsage: LlmUsage = {
    inputTokens: 3900,
    outputTokens: 5100,
    cacheReadTokens: 44200,
    cacheCreationTokens: 9200,
    rounds: 5,
  };
}

// Teste 20 (V2.5): linha de cache por caso em stderr; stdout inalterado
describe('runEvals({ engine: "llm" }) com assistant expondo lastUsage', () => {
  it('emite a linha Cache por caso em stderr e mantém o stdout de scores intacto', async () => {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const summary = await runEvals({
      engine: 'llm',
      assistant: new FakeLlmAssistantWithUsage(),
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    });

    // Uma linha de cache por caso, no formato da techspec
    const cacheLines = errLines.filter((line) => line.includes('Cache:'));
    expect(cacheLines).toHaveLength(3);
    for (const line of cacheLines) {
      expect(line).toBe('  Cache: 44.2k lido · 9.2k escrito · 3.9k sem cache');
    }

    // stdout byte-idêntico ao da V2: scores/resumo sem nenhuma linha de cache
    const output = outLines.join('\n');
    expect(output).not.toContain('Cache:');
    expect(output).toContain('Resumo: 3/3 outcome(s) aprovado(s) · score médio 1.00');
    expect(summary.passedCount).toBe(3);
  }, 90_000);
});

// Teste 36 (modo llm sem key): validação antes de qualquer spawn
describe('runEvals({ engine: "llm" }) sem ANTHROPIC_API_KEY', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falha rápido com missing_api_key, sem montar o assistant real', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    await expect(runEvals({ engine: 'llm', out: () => {}, err: () => {} })).rejects.toSatisfy(
      (error: unknown) => error instanceof LlmEngineError && error.code === 'missing_api_key',
    );
  });
});

// Teste 38: clarification num caso (modo deterministic) → erro apontando o caso
describe('outcome clarification num caso', () => {
  it('gera erro orientativo apontando o caso e o campo faltante', async () => {
    const clarifying: InvestigationAssistant = {
      async investigate(): Promise<InvestigationOutcome> {
        return { kind: 'clarification', missing: [{ field: 'window', hint: 'informe o período' }] };
      },
    };

    await expect(runEvals({ assistant: clarifying, out: () => {}, err: () => {} })).rejects.toThrow(
      /caso case-001-database-timeout: .*faltou: window.*corrija o campo "question"/,
    );
  }, 90_000);
});

describe('loadCases()', () => {
  it('carrega os 3 casos válidos em ordem determinística (RF24/RF25)', async () => {
    const cases = await loadCases();

    expect(cases.map((evalCase) => evalCase.id)).toEqual([
      'case-001-database-timeout',
      'case-002-payment-api-timeout',
      'case-003-missing-data',
    ]);
    for (const evalCase of cases) {
      expect(evalCase.question.length).toBeGreaterThan(0);
      expect(evalCase.expected_findings.length).toBeGreaterThan(0);
      expect(evalCase.must_not_include.length).toBeGreaterThan(0);
      expect(evalCase.expected_trajectory).toBeDefined();
    }

    const missingDataCase = cases[2];
    expect(missingDataCase?.expected_findings).toContainEqual([
      'Sem registros',
      'Não há registros',
      'nenhum registro',
    ]);
    expect(missingDataCase?.expected_findings).toContainEqual([
      'Sem métricas de latência',
      'sem dados de latência',
      'não há métricas de latência',
    ]);
  });

  it('rejeita expectativa semanticamente inválida durante o carregamento', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentops-invalid-trajectory-'));
    try {
      await writeFile(
        join(dir, 'invalid.json'),
        JSON.stringify({
          id: 'invalid',
          question: 'Investigue timeout no checkout-api entre 10h e 10h30 em 2026-07-08',
          expected_findings: ['timeout'],
          must_not_include: [],
          expected_trajectory: {
            required_calls: [{ id: 'errors', tool: 'get_error_summary' }],
            order_constraints: [{ before: 'errors', after: 'missing' }],
          },
        }),
      );
      await expect(loadCases(dir)).rejects.toThrow(/required_call inexistente/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('compatibilidade e composição da trajetória', () => {
  it('extrai somente o audit contido no outcome markdown e retorna vazio para clarification', () => {
    const audit = [{ seq: 1, tool: 'get_error_summary' as const, params: {}, resultSummary: 'ok', durationMs: 1 }];
    expect(auditFromOutcome({ kind: 'markdown', markdown: '# relatório', audit })).toBe(audit);
    expect(auditFromOutcome({ kind: 'clarification', missing: [] })).toEqual([]);
  });

  it('caso legado retorna trajectory null, omite bloco e média informativa', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentops-legacy-eval-'));
    try {
      await writeFile(
        join(dir, 'legacy.json'),
        JSON.stringify({
          id: 'legacy',
          question: 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08',
          expected_findings: ['DatabaseTimeoutException'],
          must_not_include: ['drop table'],
        }),
      );
      const output: string[] = [];
      const summary = await runEvals({ casesDir: dir, out: (line) => output.push(line), err: () => {} });
      expect(summary.results[0]?.trajectory).toBeNull();
      expect(summary.averageTrajectoryScore).toBeNull();
      expect(output.join('\n')).not.toContain('Trajetória');
      expect(output.join('\n')).not.toContain('trajetória média');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

const CASE_IDS = ['case-001-database-timeout', 'case-002-payment-api-timeout', 'case-003-missing-data'];

async function readTraceLines(path: string): Promise<unknown[]> {
  const content = await readFile(path, 'utf8');
  return content
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

// Tarefa 2.0 (trace-log): AGENTOPS_TRACE_LOG opt-in em `runEvals()`
describe('runEvals({ traceLogPath }) — trace opt-in', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentops-eval-trace-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('motor deterministic, 3 casos reais → 3 linhas válidas, mesmo runId, caseId por linha, rounds/usage/model null', async () => {
    const traceLogPath = join(dir, 'deterministic.jsonl');

    await runEvals({ traceLogPath, out: () => {}, err: () => {} });

    const records = await readTraceLines(traceLogPath);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(investigationTraceRecordSchema.safeParse(record).success).toBe(true);
    }
    const parsed = records.map((record) => investigationTraceRecordSchema.parse(record));
    expect(parsed.map((record) => record.caseId)).toEqual(CASE_IDS);
    expect(new Set(parsed.map((record) => record.runId)).size).toBe(1);
    for (const record of parsed) {
      expect(record.source).toBe('eval');
      expect(record.engine).toBe('deterministic');
      expect(record.model).toBeNull();
      expect(record.rounds).toBeNull();
      expect(record.usage).toBeNull();
      expect(record.eval?.caseId).toBe(record.caseId);
    }
  }, 90_000);

  it('motor llm com assistant fake, 3 casos → 3 registros, mesmo runId, eval igual ao EvalCaseResult do caso', async () => {
    const traceLogPath = join(dir, 'llm-fake.jsonl');

    const summary = await runEvals({
      engine: 'llm',
      assistant: new FakeLlmAssistant(),
      traceLogPath,
      out: () => {},
      err: () => {},
    });

    const records = (await readTraceLines(traceLogPath)).map((record) => investigationTraceRecordSchema.parse(record));
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.caseId)).toEqual(CASE_IDS);
    expect(new Set(records.map((record) => record.runId)).size).toBe(1);
    records.forEach((record, index) => {
      expect(record.source).toBe('eval');
      expect(record.engine).toBe('llm');
      expect(record.eval).toEqual(summary.results[index]?.outcome);
    });
  }, 90_000);

  it('sem traceLogPath → nenhum arquivo criado (comportamento default inalterado)', async () => {
    const untouchedPath = join(dir, 'nao-deve-existir.jsonl');

    await runEvals({ out: () => {}, err: () => {} });

    await expect(readFile(untouchedPath, 'utf8')).rejects.toThrow(/ENOENT/);
  }, 90_000);

  it('falha ao gravar o trace (diretório bloqueado por um arquivo) → aviso em stderr, summary inalterado', async () => {
    const blockerFile = join(dir, 'blocker-file');
    await writeFile(blockerFile, 'não é um diretório', 'utf8');
    const brokenTraceLogPath = join(blockerFile, 'nested', 'trace.jsonl');
    const errLines: string[] = [];

    const summary = await runEvals({ traceLogPath: brokenTraceLogPath, out: () => {}, err: (line) => errLines.push(line) });

    expect(summary.results).toHaveLength(3);
    expect(summary.passedCount).toBe(summary.results.filter((result) => result.outcome.passed).length);
    expect(errLines.filter((line) => line.includes('Aviso: falha ao gravar o trace do caso'))).toHaveLength(3);
  }, 90_000);
});
