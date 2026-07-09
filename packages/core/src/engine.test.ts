import { describe, expect, it } from 'vitest';
import type {
  DeploymentEventsResult,
  DocumentSearchResult,
  ErrorSummary,
  InvestigationContext,
  LatencySummary,
  RecentLogsResult,
  RunbookResult,
  ToolInvoker,
  ToolName,
  TopExceptionsResult,
} from '@agentops/types';
import { DeterministicInvestigationEngine } from './engine.js';
import { ToolInvocationError } from './tool-invoker.js';

// ---------------------------------------------------------------------------
// Stub de ToolInvoker — sem MCP, sem filesystem
// ---------------------------------------------------------------------------

type StubResponse = unknown | ((params: Record<string, unknown>) => unknown);

class StubToolInvoker implements ToolInvoker {
  readonly calls: Array<{ tool: ToolName; params: Record<string, unknown> }> = [];

  constructor(private readonly responses: Partial<Record<ToolName, StubResponse>>) {}

  async invoke<TIn, TOut>(tool: ToolName, params: TIn): Promise<TOut> {
    this.calls.push({ tool, params: params as Record<string, unknown> });
    const response = this.responses[tool];
    if (response === undefined) {
      throw new Error(`stub sem resposta para ${tool}`);
    }
    const resolved = typeof response === 'function' ? response(params as Record<string, unknown>) : response;
    if (resolved instanceof Error) {
      throw resolved;
    }
    return resolved as TOut;
  }
}

// ---------------------------------------------------------------------------
// Fixtures — dados do case-001 (regressão de deploy do checkout-api)
// ---------------------------------------------------------------------------

const WINDOW = { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' };

const CONTEXT: InvestigationContext = {
  question: 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08',
  service: 'checkout-api',
  window: WINDOW,
  symptom: 'erro 5xx',
};

const ERROR_SUMMARY: ErrorSummary = {
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
    { bucketStart: '2026-07-08T10:10:00-03:00', count5xx: 31 },
  ],
};

const TOP_EXCEPTIONS: TopExceptionsResult = {
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
    {
      exception: 'ConnectionPoolExhaustedException',
      count: 9,
      sampleMessage: "No available connection in pool 'payments' after 5000ms",
      endpoints: ['POST /checkout'],
    },
  ],
};

const RECENT_LOGS: RecentLogsResult = {
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
};

const LATENCY_WINDOW: LatencySummary = {
  service: 'checkout-api',
  window: WINDOW,
  hasData: true,
  unit: 'ms',
  overall: { p50: 220, p95: 2410, p99: 3200 },
  requestCount: 412,
  series: [{ bucketStart: '2026-07-08T10:00:00-03:00', p99: 460, requestCount: 71 }],
};

const LATENCY_BASELINE: LatencySummary = {
  service: 'checkout-api',
  window: { from: '2026-07-08T09:30:00-03:00', to: '2026-07-08T10:00:00-03:00' },
  hasData: true,
  unit: 'ms',
  overall: { p50: 180, p95: 390, p99: 460 },
  requestCount: 398,
  series: [{ bucketStart: '2026-07-08T09:30:00-03:00', p99: 450, requestCount: 66 }],
};

const DEPLOYMENTS: DeploymentEventsResult = {
  service: 'checkout-api',
  window: { from: '2026-07-08T09:45:00-03:00', to: '2026-07-08T10:30:00-03:00' },
  hasData: true,
  events: [
    {
      timestamp: '2026-07-08T10:03:00-03:00',
      service: 'checkout-api',
      version: '2026.07.08-1',
      previousVersion: '2026.07.07-3',
      changeSummary: 'Refatoração do acesso ao banco de pagamentos (novas queries no fluxo de checkout)',
    },
  ],
};

const RUNBOOK_SEARCH: DocumentSearchResult = {
  query: 'checkout-api erro 5xx',
  matches: [
    {
      name: 'checkout-api-high-5xx',
      title: 'Runbook: checkout-api — alta taxa de 5xx',
      path: 'knowledge-base/runbooks/checkout-api-high-5xx.md',
      score: 11,
      excerpt: '…verificar o connection pool do banco de pagamentos…',
    },
  ],
};

const RUNBOOK: RunbookResult = {
  found: true,
  name: 'checkout-api-high-5xx',
  title: 'Runbook: checkout-api — alta taxa de 5xx',
  content: '# Runbook: checkout-api — alta taxa de 5xx\n\n## Passos de verificação\n1. Verificar connection pool…',
};

const ADR_SEARCH: DocumentSearchResult = {
  query: 'database timeout',
  matches: [
    {
      name: 'adr-001-checkout-payment-flow',
      title: 'ADR 001: Fluxo de pagamento do checkout',
      path: 'knowledge-base/adrs/adr-001-checkout-payment-flow.md',
      score: 5,
      excerpt: '…acesso ao banco de pagamentos…',
    },
  ],
};

const TECH_SPEC_SEARCH: DocumentSearchResult = {
  query: 'database timeout',
  matches: [
    {
      name: 'checkout-api',
      title: 'Tech spec: checkout-api',
      path: 'knowledge-base/tech-specs/checkout-api.md',
      score: 4,
      excerpt: '…timeouts do banco…',
    },
  ],
};

function case001Responses(): Partial<Record<ToolName, StubResponse>> {
  return {
    get_error_summary: ERROR_SUMMARY,
    get_top_exceptions: TOP_EXCEPTIONS,
    get_recent_logs: RECENT_LOGS,
    get_latency_summary: (params: Record<string, unknown>) =>
      params['from'] === WINDOW.from ? LATENCY_WINDOW : LATENCY_BASELINE,
    get_deployment_events: DEPLOYMENTS,
    search_runbooks: RUNBOOK_SEARCH,
    get_runbook: RUNBOOK,
    search_adrs: ADR_SEARCH,
    search_tech_specs: TECH_SPEC_SEARCH,
  };
}

/** Fixtures vazias: nenhuma telemetria, nenhuma documentação (cenário R3/US9). */
function emptyResponses(): Partial<Record<ToolName, StubResponse>> {
  const emptyLatency: LatencySummary = {
    service: 'checkout-api',
    window: WINDOW,
    hasData: false,
    unit: 'ms',
    overall: null,
    requestCount: 0,
    series: [],
  };
  return {
    get_error_summary: {
      service: 'checkout-api',
      window: WINDOW,
      hasData: false,
      totalRequests: 0,
      count5xx: 0,
      count4xx: 0,
      errorRate5xx: 0,
      byEndpoint: [],
      timeline: [],
    } satisfies ErrorSummary,
    get_top_exceptions: {
      service: 'checkout-api',
      window: WINDOW,
      hasData: false,
      exceptions: [],
    } satisfies TopExceptionsResult,
    get_recent_logs: {
      service: 'checkout-api',
      window: WINDOW,
      hasData: false,
      logs: [],
      totalMatched: 0,
      truncated: false,
    } satisfies RecentLogsResult,
    get_latency_summary: emptyLatency,
    get_deployment_events: {
      service: 'checkout-api',
      window: WINDOW,
      hasData: false,
      events: [],
    } satisfies DeploymentEventsResult,
    search_runbooks: { query: 'checkout-api erro 5xx', matches: [] } satisfies DocumentSearchResult,
  };
}

const engine = new DeterministicInvestigationEngine();

// ---------------------------------------------------------------------------
// Testes 36–47
// ---------------------------------------------------------------------------

describe('DeterministicInvestigationEngine', () => {
  // Teste 36
  it('cenário principal: ordem das chamadas corresponde aos passos 2–8 da skill (RF16)', async () => {
    const stub = new StubToolInvoker(case001Responses());
    await engine.investigate(CONTEXT, stub);
    expect(stub.calls.map((call) => call.tool)).toEqual([
      'get_error_summary',
      'get_top_exceptions',
      'get_recent_logs',
      'get_latency_summary',
      'get_latency_summary',
      'get_deployment_events',
      'search_runbooks',
      'get_runbook',
      'search_adrs',
      'search_tech_specs',
    ]);
  });

  // Teste 37
  it('relatório contém as 7 seções na ordem do RF4', async () => {
    const stub = new StubToolInvoker(case001Responses());
    const report = await engine.investigate(CONTEXT, stub);
    const keys = Object.keys(report);
    expect(keys.indexOf('summary')).toBeLessThan(keys.indexOf('evidences'));
    expect(keys.slice(keys.indexOf('summary'))).toEqual([
      'summary',
      'evidences',
      'primaryHypothesis',
      'alternativeHypotheses',
      'safeNextSteps',
      'missingData',
      'confidence',
      'audit',
    ]);
  });

  // Teste 38
  it('toda evidência tem source.tool e source.reference não vazios (RF5)', async () => {
    const stub = new StubToolInvoker(case001Responses());
    const report = await engine.investigate(CONTEXT, stub);
    expect(report.evidences.length).toBeGreaterThan(0);
    for (const evidence of report.evidences) {
      expect(evidence.source.tool.length).toBeGreaterThan(0);
      expect(evidence.source.reference.length).toBeGreaterThan(0);
    }
  });

  // Teste 39
  it('R1 dispara: deploy + exception dominante + p99 ≥2× baseline → regressão de deploy, confiança alta', async () => {
    const stub = new StubToolInvoker(case001Responses());
    const report = await engine.investigate(CONTEXT, stub);
    expect(report.primaryHypothesis).not.toBeNull();
    expect(report.primaryHypothesis?.statement).toMatch(/regress/i);
    expect(report.primaryHypothesis?.statement).toContain('2026.07.08-1');
    expect(report.primaryHypothesis?.confidence).toBe('alta');
    expect(report.confidence).toBe('alta');
  });

  // Teste 40
  it('R1 sem corroboração de runbook → confiança media e missingData menciona runbook', async () => {
    const responses = case001Responses();
    responses.search_runbooks = { query: 'checkout-api erro 5xx', matches: [] } satisfies DocumentSearchResult;
    const stub = new StubToolInvoker(responses);
    const report = await engine.investigate(CONTEXT, stub);
    expect(report.primaryHypothesis?.statement).toMatch(/regress/i);
    expect(report.primaryHypothesis?.confidence).toBe('media');
    expect(report.missingData.some((item) => /runbook/i.test(item))).toBe(true);
    // sem match, get_runbook não deve ser chamado
    expect(stub.calls.map((call) => call.tool)).not.toContain('get_runbook');
  });

  // Teste 41
  it('R2 dispara: sem deploy + timeout dominante → dependência degradada', async () => {
    const responses = case001Responses();
    responses.get_deployment_events = {
      service: 'checkout-api',
      window: { from: '2026-07-08T09:45:00-03:00', to: '2026-07-08T10:30:00-03:00' },
      hasData: false,
      events: [],
    } satisfies DeploymentEventsResult;
    const stub = new StubToolInvoker(responses);
    const report = await engine.investigate(CONTEXT, stub);
    expect(report.primaryHypothesis).not.toBeNull();
    expect(report.primaryHypothesis?.statement).toMatch(/depend[eê]ncia|banco/i);
    expect(report.primaryHypothesis?.statement).not.toMatch(/regress/i);
  });

  // Teste 42
  it('R3 dispara: tudo hasData false → primaryHypothesis null, confiança baixa, missingData preenchido (US9)', async () => {
    const stub = new StubToolInvoker(emptyResponses());
    const report = await engine.investigate(CONTEXT, stub);
    expect(report.primaryHypothesis).toBeNull();
    expect(report.confidence).toBe('baixa');
    expect(report.missingData.length).toBeGreaterThan(0);
    expect(report.evidences).toEqual([]);
  });

  // Teste 43
  it('passo 8 (ADRs/tech specs) é pulado sem exception dominante — auditoria comprova', async () => {
    const stub = new StubToolInvoker(emptyResponses());
    const report = await engine.investigate(CONTEXT, stub);
    const toolsCalled = stub.calls.map((call) => call.tool);
    expect(toolsCalled).not.toContain('search_adrs');
    expect(toolsCalled).not.toContain('search_tech_specs');
    expect(report.audit.map((record) => record.tool)).not.toContain('search_adrs');
  });

  // Teste 44
  it('safeNextSteps[0] nunca contém termos destrutivos (RF17)', async () => {
    const destructive = /rollback|reiniciar|restart|apagar|deletar|delete|drop|truncate|kill|desligar/i;
    for (const responses of [case001Responses(), emptyResponses()]) {
      const stub = new StubToolInvoker(responses);
      const report = await engine.investigate(CONTEXT, stub);
      expect(report.safeNextSteps.length).toBeGreaterThan(0);
      expect(report.safeNextSteps[0]).not.toMatch(destructive);
    }
  });

  // Teste 45
  it('com stubs vazios, o relatório não menciona DatabaseTimeoutException (anti-alucinação, RF6)', async () => {
    const stub = new StubToolInvoker(emptyResponses());
    const report = await engine.investigate(CONTEXT, stub);
    expect(JSON.stringify(report)).not.toContain('DatabaseTimeoutException');
  });

  // Teste 46
  it('AuditLog: seq incremental, params ecoados byte a byte, um registro por chamada (RF7)', async () => {
    const stub = new StubToolInvoker(case001Responses());
    const report = await engine.investigate(CONTEXT, stub);
    expect(report.audit).toHaveLength(stub.calls.length);
    report.audit.forEach((record, index) => {
      expect(record.seq).toBe(index + 1);
      const sentParams = stub.calls[index]?.params;
      expect(JSON.stringify(record.params)).toBe(JSON.stringify(sentParams));
      expect(record.tool).toBe(stub.calls[index]?.tool);
      expect(record.resultSummary.length).toBeGreaterThan(0);
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // Teste 47
  it('tool retornando isError → falha registrada na auditoria e degradada para missingData (não aborta)', async () => {
    const responses = case001Responses();
    responses.get_recent_logs = new ToolInvocationError('get_recent_logs', 'INVALID_ARGUMENT: falha simulada (isError)');
    const stub = new StubToolInvoker(responses);
    const report = await engine.investigate(CONTEXT, stub);

    // a investigação continua e ainda produz a hipótese R1
    expect(report.primaryHypothesis?.statement).toMatch(/regress/i);

    const failedRecord = report.audit.find((record) => record.tool === 'get_recent_logs');
    expect(failedRecord).toBeDefined();
    expect(failedRecord?.resultSummary).toMatch(/^ERRO:/);
    expect(report.missingData.some((item) => item.includes('get_recent_logs'))).toBe(true);

    // as demais chamadas seguem na ordem da skill
    expect(stub.calls.map((call) => call.tool)).toContain('get_deployment_events');
  });

  it('declara em missingData runbook irrecuperável e buscas de ADR/tech spec vazias (US9)', async () => {
    const responses = case001Responses();
    responses.get_runbook = { found: false, name: null, title: null, content: null } satisfies RunbookResult;
    responses.search_adrs = { query: 'database timeout', matches: [] } satisfies DocumentSearchResult;
    responses.search_tech_specs = { query: 'database timeout', matches: [] } satisfies DocumentSearchResult;
    const stub = new StubToolInvoker(responses);

    const report = await engine.investigate(CONTEXT, stub);

    expect(report.missingData.some((item) => item.includes('runbook indicado pela busca'))).toBe(true);
    expect(report.missingData.some((item) => item.startsWith('Nenhum ADR'))).toBe(true);
    expect(report.missingData.some((item) => item.startsWith('Nenhuma tech spec'))).toBe(true);
  });
});
