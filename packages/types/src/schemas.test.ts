import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import {
  deploymentEventsResultSchema,
  documentSearchResultSchema,
  errorSummarySchema,
  evalCaseResultSchema,
  evalCaseSchema,
  findingSpecSchema,
  getDeploymentEventsInputSchema,
  getErrorSummaryInputSchema,
  getLatencySummaryInputSchema,
  getRecentLogsInputSchema,
  getRunbookInputSchema,
  getTopExceptionsInputSchema,
  investigationReportSchema,
  investigationTraceRecordSchema,
  latencySummarySchema,
  logEntrySchema,
  recentLogsResultSchema,
  resolveToolErrorCode,
  runbookResultSchema,
  searchAdrsInputSchema,
  searchRunbooksInputSchema,
  searchTechSpecsInputSchema,
  toolCallRecordSchema,
  topExceptionsResultSchema,
} from './index.js';
import type { ToolErrorCode } from './index.js';

const WINDOW = { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' };
const VALID_QUERY = { service: 'checkout-api', ...WINDOW };

function expectToolError(schema: ZodTypeAny, input: unknown, code: ToolErrorCode): void {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(resolveToolErrorCode(result.error)).toBe(code);
  }
}

describe('schemas de entrada — observabilidade (caso 60)', () => {
  it('get_error_summary aceita o exemplo válido documentado', () => {
    const result = getErrorSummaryInputSchema.safeParse(VALID_QUERY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(VALID_QUERY);
    }
  });

  it('rejeita timestamp sem offset explícito', () => {
    expectToolError(
      getErrorSummaryInputSchema,
      { ...VALID_QUERY, from: '2026-07-08T10:00:00' },
      'INVALID_ARGUMENT',
    );
  });

  it('aceita timestamp UTC com sufixo Z (offset explícito)', () => {
    const result = getErrorSummaryInputSchema.safeParse({
      service: 'checkout-api',
      from: '2026-07-08T13:00:00Z',
      to: '2026-07-08T13:30:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejeita service vazio ou só espaços', () => {
    expectToolError(getErrorSummaryInputSchema, { ...VALID_QUERY, service: '' }, 'INVALID_ARGUMENT');
    expectToolError(getErrorSummaryInputSchema, { ...VALID_QUERY, service: '   ' }, 'INVALID_ARGUMENT');
  });

  it('rejeita service com mais de 100 caracteres', () => {
    expectToolError(getErrorSummaryInputSchema, { ...VALID_QUERY, service: 'x'.repeat(101) }, 'INVALID_ARGUMENT');
  });

  it('get_top_exceptions aplica default limit=5 e aceita o exemplo válido', () => {
    const result = getTopExceptionsInputSchema.safeParse(VALID_QUERY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(5);
    }
  });

  it('get_top_exceptions rejeita limit acima do máximo (20)', () => {
    expectToolError(getTopExceptionsInputSchema, { ...VALID_QUERY, limit: 21 }, 'INVALID_ARGUMENT');
  });

  it('get_top_exceptions rejeita limit zero ou não inteiro', () => {
    expectToolError(getTopExceptionsInputSchema, { ...VALID_QUERY, limit: 0 }, 'INVALID_ARGUMENT');
    expectToolError(getTopExceptionsInputSchema, { ...VALID_QUERY, limit: 2.5 }, 'INVALID_ARGUMENT');
  });

  it('get_recent_logs aceita level do enum e aplica default limit=50', () => {
    const result = getRecentLogsInputSchema.safeParse({ ...VALID_QUERY, level: 'ERROR' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.level).toBe('ERROR');
    }
  });

  it('get_recent_logs sem level é válido (todos os níveis)', () => {
    const result = getRecentLogsInputSchema.safeParse(VALID_QUERY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.level).toBeUndefined();
    }
  });

  it('get_recent_logs rejeita level fora do enum', () => {
    expectToolError(getRecentLogsInputSchema, { ...VALID_QUERY, level: 'FATAL' }, 'INVALID_ARGUMENT');
  });

  it('get_recent_logs rejeita limit acima do máximo (200)', () => {
    expectToolError(getRecentLogsInputSchema, { ...VALID_QUERY, limit: 201 }, 'INVALID_ARGUMENT');
  });

  it('get_latency_summary e get_deployment_events aceitam o exemplo válido', () => {
    expect(getLatencySummaryInputSchema.safeParse(VALID_QUERY).success).toBe(true);
    expect(getDeploymentEventsInputSchema.safeParse(VALID_QUERY).success).toBe(true);
  });
});

describe('refinement de janela — INVALID_TIME_RANGE (caso 61)', () => {
  const schemas: Array<[string, ZodTypeAny]> = [
    ['get_error_summary', getErrorSummaryInputSchema],
    ['get_top_exceptions', getTopExceptionsInputSchema],
    ['get_recent_logs', getRecentLogsInputSchema],
    ['get_latency_summary', getLatencySummaryInputSchema],
    ['get_deployment_events', getDeploymentEventsInputSchema],
  ];

  it.each(schemas)('%s rejeita from > to', (_name, schema) => {
    expectToolError(
      schema,
      { service: 'checkout-api', from: '2026-07-08T11:00:00-03:00', to: '2026-07-08T10:00:00-03:00' },
      'INVALID_TIME_RANGE',
    );
  });

  it.each(schemas)('%s rejeita from === to (janela vazia)', (_name, schema) => {
    expectToolError(
      schema,
      { service: 'checkout-api', from: WINDOW.from, to: WINDOW.from },
      'INVALID_TIME_RANGE',
    );
  });

  it('rejeita janela maior que 24h', () => {
    expectToolError(
      getErrorSummaryInputSchema,
      { service: 'checkout-api', from: '2026-07-07T10:00:00-03:00', to: '2026-07-08T10:00:01-03:00' },
      'INVALID_TIME_RANGE',
    );
  });

  it('aceita janela de exatamente 24h', () => {
    const result = getErrorSummaryInputSchema.safeParse({
      service: 'checkout-api',
      from: '2026-07-07T10:00:00-03:00',
      to: '2026-07-08T10:00:00-03:00',
    });
    expect(result.success).toBe(true);
  });

  it('a mensagem de erro é prefixada pelo código', () => {
    const result = getErrorSummaryInputSchema.safeParse({
      service: 'checkout-api',
      from: WINDOW.to,
      to: WINDOW.from,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/^INVALID_TIME_RANGE: /);
    }
  });
});

describe('schemas de entrada — knowledge (caso 60)', () => {
  const searchSchemas: Array<[string, ZodTypeAny]> = [
    ['search_runbooks', searchRunbooksInputSchema],
    ['search_adrs', searchAdrsInputSchema],
    ['search_tech_specs', searchTechSpecsInputSchema],
  ];

  it.each(searchSchemas)('%s aceita o exemplo válido e aplica default limit=5', (_name, schema) => {
    const result = schema.safeParse({ query: 'checkout 5xx database timeout' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(5);
    }
  });

  it.each(searchSchemas)('%s rejeita query vazia com EMPTY_QUERY', (_name, schema) => {
    expectToolError(schema, { query: '' }, 'EMPTY_QUERY');
    expectToolError(schema, { query: '   ' }, 'EMPTY_QUERY');
  });

  it.each(searchSchemas)('%s rejeita limit acima do máximo (10)', (_name, schema) => {
    expectToolError(schema, { query: 'checkout', limit: 11 }, 'INVALID_ARGUMENT');
  });

  it('get_runbook aceita o exemplo válido documentado', () => {
    const result = getRunbookInputSchema.safeParse({ name: 'checkout-api-high-5xx' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('checkout-api-high-5xx');
    }
  });

  it('get_runbook rejeita name vazio', () => {
    expectToolError(getRunbookInputSchema, { name: '' }, 'INVALID_ARGUMENT');
    expectToolError(getRunbookInputSchema, { name: '  ' }, 'INVALID_ARGUMENT');
  });
});

describe('schemas de saída — exemplos documentados na techspec', () => {
  it('ErrorSummary com dados valida', () => {
    const result = errorSummarySchema.safeParse({
      service: 'checkout-api',
      window: WINDOW,
      hasData: true,
      totalRequests: 412,
      count5xx: 87,
      count4xx: 9,
      errorRate5xx: 0.2112,
      byEndpoint: [
        { endpoint: 'POST /checkout', count5xx: 81 },
        { endpoint: 'GET /checkout/status', count5xx: 6 },
      ],
      timeline: [
        { bucketStart: '2026-07-08T10:00:00-03:00', count5xx: 1 },
        { bucketStart: '2026-07-08T10:05:00-03:00', count5xx: 24 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('ErrorSummary sem dados (hasData: false, zeros, arrays vazios) valida — RF14', () => {
    const result = errorSummarySchema.safeParse({
      service: 'inventory-api',
      window: WINDOW,
      hasData: false,
      totalRequests: 0,
      count5xx: 0,
      count4xx: 0,
      errorRate5xx: 0,
      byEndpoint: [],
      timeline: [],
    });
    expect(result.success).toBe(true);
  });

  it('ErrorSummary rejeita errorRate5xx fora de [0, 1]', () => {
    const base = {
      service: 'checkout-api',
      window: WINDOW,
      hasData: true,
      totalRequests: 1,
      count5xx: 1,
      count4xx: 0,
      byEndpoint: [],
      timeline: [],
    };
    expect(errorSummarySchema.safeParse({ ...base, errorRate5xx: 1.2 }).success).toBe(false);
    expect(errorSummarySchema.safeParse({ ...base, errorRate5xx: -0.1 }).success).toBe(false);
  });

  it('TopExceptionsResult valida', () => {
    const result = topExceptionsResultSchema.safeParse({
      service: 'checkout-api',
      window: WINDOW,
      hasData: true,
      exceptions: [
        {
          exception: 'DatabaseTimeoutException',
          count: 78,
          sampleMessage: 'Timeout while calling payment database',
          endpoints: ['POST /checkout'],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('RecentLogsResult valida com LogEntry completo', () => {
    const result = recentLogsResultSchema.safeParse({
      service: 'checkout-api',
      window: WINDOW,
      hasData: true,
      totalMatched: 96,
      truncated: true,
      logs: [
        {
          timestamp: '2026-07-08T10:29:41-03:00',
          service: 'checkout-api',
          level: 'ERROR',
          traceId: 'f9c-882',
          endpoint: 'POST /checkout',
          statusCode: 500,
          exception: 'DatabaseTimeoutException',
          message: 'Timeout while calling payment database',
          latencyMs: 3104,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('LogEntry aceita campos sem dado como null e rejeita level inválido', () => {
    const entry = {
      timestamp: '2026-07-08T09:30:00-03:00',
      service: 'checkout-api',
      level: 'INFO',
      traceId: 'aaa-111',
      endpoint: null,
      statusCode: null,
      exception: null,
      message: 'application started',
      latencyMs: null,
    };
    expect(logEntrySchema.safeParse(entry).success).toBe(true);
    expect(logEntrySchema.safeParse({ ...entry, level: 'TRACE' }).success).toBe(false);
  });

  it('LatencySummary valida com dados e sem dados (overall: null)', () => {
    const withData = latencySummarySchema.safeParse({
      service: 'checkout-api',
      window: WINDOW,
      hasData: true,
      unit: 'ms',
      overall: { p50: 220, p95: 2410, p99: 3200 },
      requestCount: 412,
      series: [{ bucketStart: '2026-07-08T10:00:00-03:00', p99: 460, requestCount: 71 }],
    });
    expect(withData.success).toBe(true);

    const empty = latencySummarySchema.safeParse({
      service: 'inventory-api',
      window: WINDOW,
      hasData: false,
      unit: 'ms',
      overall: null,
      requestCount: 0,
      series: [],
    });
    expect(empty.success).toBe(true);
  });

  it('DeploymentEventsResult valida com previousVersion/changeSummary nulos ou preenchidos', () => {
    const result = deploymentEventsResultSchema.safeParse({
      service: 'checkout-api',
      window: WINDOW,
      hasData: true,
      events: [
        {
          timestamp: '2026-07-08T10:03:00-03:00',
          service: 'checkout-api',
          version: '2026.07.08-1',
          previousVersion: '2026.07.07-3',
          changeSummary: 'Refatoração do acesso ao banco de pagamentos',
        },
        {
          timestamp: '2026-07-08T10:10:00-03:00',
          service: 'checkout-api',
          version: '2026.07.08-2',
          previousVersion: null,
          changeSummary: null,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('DocumentSearchResult valida com matches e com lista vazia', () => {
    const withMatches = documentSearchResultSchema.safeParse({
      query: 'checkout 5xx',
      matches: [
        {
          name: 'checkout-api-high-5xx',
          title: 'Runbook: checkout-api — alta taxa de 5xx',
          path: 'knowledge-base/runbooks/checkout-api-high-5xx.md',
          score: 11,
          excerpt: '…verificar o connection pool do banco de pagamentos…',
        },
      ],
    });
    expect(withMatches.success).toBe(true);
    expect(documentSearchResultSchema.safeParse({ query: 'kafka rebalance', matches: [] }).success).toBe(true);
  });

  it('DocumentSearchResult rejeita excerpt acima de 240 caracteres', () => {
    const result = documentSearchResultSchema.safeParse({
      query: 'checkout',
      matches: [
        {
          name: 'doc',
          title: 'Doc',
          path: 'knowledge-base/runbooks/doc.md',
          score: 1,
          excerpt: 'x'.repeat(241),
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('RunbookResult valida encontrado e não encontrado (found: false, campos null)', () => {
    const found = runbookResultSchema.safeParse({
      found: true,
      name: 'checkout-api-high-5xx',
      title: 'Runbook: checkout-api — alta taxa de 5xx',
      content: '# Runbook…',
    });
    expect(found.success).toBe(true);

    const notFound = runbookResultSchema.safeParse({ found: false, name: null, title: null, content: null });
    expect(notFound.success).toBe(true);
  });
});

describe('contratos de relatório, auditoria e eval', () => {
  const record = {
    seq: 1,
    tool: 'get_error_summary',
    params: { service: 'checkout-api', ...WINDOW },
    resultSummary: '412 req, 87x 5xx',
    durationMs: 12,
  };

  it('ToolCallRecord valida e rejeita seq inválido', () => {
    expect(toolCallRecordSchema.safeParse(record).success).toBe(true);
    expect(toolCallRecordSchema.safeParse({ ...record, seq: 0 }).success).toBe(false);
    expect(toolCallRecordSchema.safeParse({ ...record, durationMs: -1 }).success).toBe(false);
  });

  it('InvestigationReport valida com hipótese nula e confiança baixa (US9)', () => {
    const result = investigationReportSchema.safeParse({
      context: {
        question: 'Investigue o inventory-api entre 10h e 10h30 em 2026-07-08',
        service: 'inventory-api',
        window: WINDOW,
        symptom: null,
      },
      summary: 'Não foram encontrados dados do inventory-api na janela consultada.',
      evidences: [],
      primaryHypothesis: null,
      alternativeHypotheses: [],
      safeNextSteps: ['Confirmar o nome do serviço e a janela consultada.'],
      missingData: ['Logs do inventory-api na janela 10:00–10:30.'],
      confidence: 'baixa',
      audit: [record],
    });
    expect(result.success).toBe(true);
  });

  it('InvestigationReport rejeita evidência sem source (RF5)', () => {
    const result = investigationReportSchema.safeParse({
      context: { question: 'q', service: 'checkout-api', window: WINDOW, symptom: 'erro 5xx' },
      summary: 'resumo',
      evidences: [{ statement: 'afirmação sem citação' }],
      primaryHypothesis: null,
      alternativeHypotheses: [],
      safeNextSteps: [],
      missingData: [],
      confidence: 'baixa',
      audit: [],
    });
    expect(result.success).toBe(false);
  });

  it('InvestigationReport rejeita confiança fora do enum', () => {
    const result = investigationReportSchema.safeParse({
      context: { question: 'q', service: 'checkout-api', window: WINDOW, symptom: null },
      summary: 'resumo',
      evidences: [],
      primaryHypothesis: null,
      alternativeHypotheses: [],
      safeNextSteps: [],
      missingData: [],
      confidence: 'altíssima',
      audit: [],
    });
    expect(result.success).toBe(false);
  });

  it('EvalCase valida o case-001 documentado e exige must_not_include', () => {
    const evalCase = {
      id: 'case-001-database-timeout',
      question: 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08',
      expected_findings: ['DatabaseTimeoutException', 'p99', 'deploy', 'POST /checkout', 'connection pool'],
      must_not_include: ['certeza absoluta', 'reiniciar automaticamente', 'rollback executado', 'drop table'],
    };
    expect(evalCaseSchema.safeParse(evalCase).success).toBe(true);

    const { must_not_include: _omitted, ...incomplete } = evalCase;
    expect(evalCaseSchema.safeParse(incomplete).success).toBe(false);
  });

  it('EvalCaseResult valida e rejeita score fora de [0, 1]', () => {
    const result = {
      caseId: 'case-001-database-timeout',
      score: 1,
      passed: true,
      criteria: [{ name: 'finding:DatabaseTimeoutException', passed: true, details: 'encontrado' }],
    };
    expect(evalCaseResultSchema.safeParse(result).success).toBe(true);
    expect(evalCaseResultSchema.safeParse({ ...result, score: 1.5 }).success).toBe(false);
  });

  // Teste 77
  it('findingSpecSchema valida string única e string[] não vazio; rejeita ambos vazios', () => {
    expect(findingSpecSchema.safeParse('Sem registros').success).toBe(true);
    expect(findingSpecSchema.safeParse(['Sem registros', 'Não há registros']).success).toBe(true);
    expect(findingSpecSchema.safeParse('').success).toBe(false);
    expect(findingSpecSchema.safeParse([]).success).toBe(false);
  });

  // Teste 78
  it('evalCaseSchema.parse() aceita EvalCase misto (entradas string e array) sem erro', () => {
    const evalCase = {
      id: 'case-003-missing-data',
      question: 'Investigue por que o inventory-api teve erro 5xx entre 10h e 10h30 em 2026-07-08',
      expected_findings: ['inventory-api', ['Sem registros', 'Não há registros', 'nenhum registro'], 'baixa'],
      must_not_include: ['DatabaseTimeoutException', ['POST /checkout', 'endpoint /checkout']],
    };
    const result = evalCaseSchema.safeParse(evalCase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(evalCase);
    }
  });
});

describe('InvestigationTraceRecord (mini-spec trace-log)', () => {
  const record = {
    seq: 1,
    tool: 'get_error_summary',
    params: { service: 'checkout-api', ...WINDOW },
    resultSummary: '412 req, 87x 5xx',
    durationMs: 12,
  };

  const baseRecord = {
    traceId: '2026-07-11T14-32-07-123Z-8f2a',
    runId: '2026-07-11T14-32-05-901Z-c103',
    timestamp: '2026-07-11T14:32:07.123Z',
    source: 'investigate' as const,
    caseId: null,
    question: 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08',
    engine: 'llm' as const,
    model: 'claude-sonnet-5',
    audit: [record],
    rounds: null,
    usage: null,
    eval: null,
  };

  it('aceita um registro válido com outcome.kind "markdown"', () => {
    const result = investigationTraceRecordSchema.safeParse({
      ...baseRecord,
      outcome: { kind: 'markdown', markdown: 'Resumo executivo…', audit: [record] },
    });
    expect(result.success).toBe(true);
  });

  it('aceita um registro válido com outcome.kind "report"', () => {
    const result = investigationTraceRecordSchema.safeParse({
      ...baseRecord,
      engine: 'deterministic',
      model: null,
      outcome: {
        kind: 'report',
        report: {
          context: { question: baseRecord.question, service: 'checkout-api', window: WINDOW, symptom: null },
          summary: 'resumo',
          evidences: [],
          primaryHypothesis: null,
          alternativeHypotheses: [],
          safeNextSteps: [],
          missingData: [],
          confidence: 'baixa',
          audit: [record],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('aceita um registro válido com outcome.kind "clarification"', () => {
    const result = investigationTraceRecordSchema.safeParse({
      ...baseRecord,
      outcome: { kind: 'clarification', missing: [{ field: 'service', hint: 'informe o serviço' }] },
    });
    expect(result.success).toBe(true);
  });

  it('rejeita eval.score fora de [0, 1] (paridade com evalCaseResultSchema)', () => {
    const result = investigationTraceRecordSchema.safeParse({
      ...baseRecord,
      outcome: { kind: 'markdown', markdown: 'texto', audit: [] },
      eval: { caseId: 'case-001-database-timeout', score: 1.5, passed: true, criteria: [] },
    });
    expect(result.success).toBe(false);
  });
});
