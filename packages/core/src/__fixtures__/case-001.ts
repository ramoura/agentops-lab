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

/**
 * Stub de `ToolInvoker` + fixtures do case-001 (regressão de deploy do
 * checkout-api), compartilhados pelos testes do engine e do assistant
 * determinístico — sem MCP, sem filesystem.
 */

export type StubResponse = unknown | ((params: Record<string, unknown>) => unknown);

export class StubToolInvoker implements ToolInvoker {
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

export const WINDOW = { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' };

export const CONTEXT: InvestigationContext = {
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

export function case001Responses(): Partial<Record<ToolName, StubResponse>> {
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
export function emptyResponses(): Partial<Record<ToolName, StubResponse>> {
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
