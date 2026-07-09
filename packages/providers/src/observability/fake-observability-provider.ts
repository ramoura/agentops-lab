import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  deploymentEventSchema,
  logEntrySchema,
  metricPointSchema,
} from '@agentops/types';
import type {
  DeploymentEvent,
  DeploymentEventsResult,
  ErrorSummary,
  LatencySummary,
  LogEntry,
  LogLevel,
  MetricPoint,
  ObservabilityProvider,
  RecentLogsResult,
  TimeWindow,
  TimeWindowQuery,
  TopExceptionsResult,
} from '@agentops/types';
import { readJsonlFile } from '../shared/jsonl.js';
import { median } from '../shared/percentiles.js';
import {
  BUCKET_SIZE_MS,
  bucketCount,
  bucketIndex,
  extractOffset,
  formatWithOffset,
  isInWindow,
} from '../shared/time.js';

export interface FakeObservabilityProviderOptions {
  /** Diretório raiz dos datasets fake (contém `logs/`, `metrics/`, `deployments/`). */
  datasetsDir: string;
}

const DEFAULT_TOP_EXCEPTIONS_LIMIT = 5;
const DEFAULT_RECENT_LOGS_LIMIT = 50;

/**
 * Provider fake de observabilidade: lê `datasets/` do filesystem (somente
 * leitura — `fs.readFile`) e faz toda a agregação em memória. Determinístico:
 * mesma entrada → mesma saída (RF9). Ausência de dados vira `hasData: false`,
 * nunca exceção (RF14). Substituível por CloudWatch/Splunk/Prometheus sem
 * mudar o contrato (RF11).
 */
export class FakeObservabilityProvider implements ObservabilityProvider {
  private readonly datasetsDir: string;
  private readonly logsCache = new Map<string, LogEntry[]>();
  private metricsCache: MetricPoint[] | null = null;
  private deploymentsCache: DeploymentEvent[] | null = null;

  constructor(options: FakeObservabilityProviderOptions) {
    this.datasetsDir = options.datasetsDir;
  }

  async getErrorSummary(q: TimeWindowQuery): Promise<ErrorSummary> {
    const { window, fromMs, toMs } = parseWindow(q);
    const entries = await this.logsInWindow(q.service, fromMs, toMs);
    const base = { service: q.service, window };
    if (entries.length === 0) {
      return { ...base, hasData: false, totalRequests: 0, count5xx: 0, count4xx: 0, errorRate5xx: 0, byEndpoint: [], timeline: [] };
    }

    const requests = entries.filter((entry) => entry.statusCode !== null);
    const fiveXx = requests.filter((entry) => (entry.statusCode as number) >= 500);
    const fourXx = requests.filter((entry) => (entry.statusCode as number) >= 400 && (entry.statusCode as number) < 500);

    const byEndpointCounts = new Map<string, number>();
    for (const entry of fiveXx) {
      if (entry.endpoint !== null) {
        byEndpointCounts.set(entry.endpoint, (byEndpointCounts.get(entry.endpoint) ?? 0) + 1);
      }
    }
    const byEndpoint = [...byEndpointCounts.entries()]
      .map(([endpoint, count5xx]) => ({ endpoint, count5xx }))
      .sort((a, b) => b.count5xx - a.count5xx || a.endpoint.localeCompare(b.endpoint));

    const offset = extractOffset(q.from);
    const timeline = Array.from({ length: bucketCount(fromMs, toMs) }, (_, index) => ({
      bucketStart: formatWithOffset(fromMs + index * BUCKET_SIZE_MS, offset),
      count5xx: 0,
    }));
    for (const entry of fiveXx) {
      const bucket = timeline[bucketIndex(Date.parse(entry.timestamp), fromMs)];
      if (bucket) {
        bucket.count5xx += 1;
      }
    }

    const totalRequests = requests.length;
    return {
      ...base,
      hasData: true,
      totalRequests,
      count5xx: fiveXx.length,
      count4xx: fourXx.length,
      errorRate5xx: totalRequests === 0 ? 0 : Math.round((fiveXx.length / totalRequests) * 10_000) / 10_000,
      byEndpoint,
      timeline,
    };
  }

  async getTopExceptions(q: TimeWindowQuery & { limit?: number }): Promise<TopExceptionsResult> {
    const { window, fromMs, toMs } = parseWindow(q);
    const entries = await this.logsInWindow(q.service, fromMs, toMs);
    const base = { service: q.service, window };
    if (entries.length === 0) {
      return { ...base, hasData: false, exceptions: [] };
    }

    const aggregates = new Map<string, { count: number; sampleMessage: string; endpoints: Set<string> }>();
    const sortedAsc = [...entries].sort(byTimestampAsc);
    for (const entry of sortedAsc) {
      if (entry.exception === null) {
        continue;
      }
      const aggregate = aggregates.get(entry.exception) ?? { count: 0, sampleMessage: entry.message, endpoints: new Set<string>() };
      aggregate.count += 1;
      if (entry.endpoint !== null) {
        aggregate.endpoints.add(entry.endpoint);
      }
      aggregates.set(entry.exception, aggregate);
    }

    const limit = q.limit ?? DEFAULT_TOP_EXCEPTIONS_LIMIT;
    const exceptions = [...aggregates.entries()]
      .map(([exception, aggregate]) => ({
        exception,
        count: aggregate.count,
        sampleMessage: aggregate.sampleMessage,
        endpoints: [...aggregate.endpoints].sort(),
      }))
      .sort((a, b) => b.count - a.count || a.exception.localeCompare(b.exception))
      .slice(0, limit);

    return { ...base, hasData: true, exceptions };
  }

  async getRecentLogs(q: TimeWindowQuery & { level?: LogLevel; limit?: number }): Promise<RecentLogsResult> {
    const { window, fromMs, toMs } = parseWindow(q);
    const entries = await this.logsInWindow(q.service, fromMs, toMs);
    const base = { service: q.service, window };
    if (entries.length === 0) {
      return { ...base, hasData: false, logs: [], totalMatched: 0, truncated: false };
    }

    const matched = entries
      .filter((entry) => q.level === undefined || entry.level === q.level)
      .sort((a, b) => byTimestampAsc(b, a) || a.traceId.localeCompare(b.traceId));
    const limit = q.limit ?? DEFAULT_RECENT_LOGS_LIMIT;
    const logs = matched.slice(0, limit);

    return { ...base, hasData: true, logs, totalMatched: matched.length, truncated: matched.length > logs.length };
  }

  async getLatencySummary(q: TimeWindowQuery): Promise<LatencySummary> {
    const { window, fromMs, toMs } = parseWindow(q);
    const points = (await this.loadMetrics()).filter(
      (point) => point.service === q.service && isInWindow(Date.parse(point.timestamp), fromMs, toMs),
    );
    const base = { service: q.service, window, unit: 'ms' as const };
    if (points.length === 0) {
      return { ...base, hasData: false, overall: null, requestCount: 0, series: [] };
    }

    // "Overall" = mediana dos percentis por minuto (aproximação documentada:
    // com poucos pontos por janela, a mediana é estável e o sinal do cenário
    // — 450ms → 3200ms — é ordens de magnitude maior que o erro do estimador).
    const overall = {
      p50: Math.round(median(points.map((point) => point.p50Ms)) as number),
      p95: Math.round(median(points.map((point) => point.p95Ms)) as number),
      p99: Math.round(median(points.map((point) => point.p99Ms)) as number),
    };

    // Série por bucket de 5 min: p99 = máximo do bucket (destaca o salto),
    // requestCount = soma. Apenas buckets com pontos entram na série.
    const offset = extractOffset(q.from);
    const buckets = new Map<number, { p99: number; requestCount: number }>();
    for (const point of points) {
      const index = bucketIndex(Date.parse(point.timestamp), fromMs);
      const bucket = buckets.get(index) ?? { p99: 0, requestCount: 0 };
      bucket.p99 = Math.max(bucket.p99, point.p99Ms);
      bucket.requestCount += point.requestCount;
      buckets.set(index, bucket);
    }
    const series = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, bucket]) => ({
        bucketStart: formatWithOffset(fromMs + index * BUCKET_SIZE_MS, offset),
        p99: bucket.p99,
        requestCount: bucket.requestCount,
      }));

    return {
      ...base,
      hasData: true,
      overall,
      requestCount: points.reduce((sum, point) => sum + point.requestCount, 0),
      series,
    };
  }

  async getDeploymentEvents(q: TimeWindowQuery): Promise<DeploymentEventsResult> {
    const { window, fromMs, toMs } = parseWindow(q);
    const events = (await this.loadDeployments())
      .filter((event) => event.service === q.service && isInWindow(Date.parse(event.timestamp), fromMs, toMs))
      .sort(byTimestampAsc);
    return { service: q.service, window, hasData: events.length > 0, events };
  }

  // -------------------------------------------------------------------------
  // Leitura dos datasets (read-only, com cache em memória)
  // -------------------------------------------------------------------------

  private async logsInWindow(service: string, fromMs: number, toMs: number): Promise<LogEntry[]> {
    const all = await this.loadLogs(service);
    return all.filter((entry) => isInWindow(Date.parse(entry.timestamp), fromMs, toMs));
  }

  private async loadLogs(service: string): Promise<LogEntry[]> {
    const cached = this.logsCache.get(service);
    if (cached) {
      return cached;
    }
    // Entrada não confiável: o nome do serviço vira nome de arquivo — nunca caminho.
    if (!/^[a-z0-9][a-z0-9-_.]*$/i.test(service)) {
      this.logsCache.set(service, []);
      return [];
    }
    const entries =
      (await readJsonlFile(join(this.datasetsDir, 'logs', `${service}.jsonl`), logEntrySchema)) ?? [];
    this.logsCache.set(service, entries);
    return entries;
  }

  private async loadMetrics(): Promise<MetricPoint[]> {
    this.metricsCache ??= await readJsonArrayFile(
      join(this.datasetsDir, 'metrics', 'latency.json'),
      metricPointSchema,
    );
    return this.metricsCache;
  }

  private async loadDeployments(): Promise<DeploymentEvent[]> {
    this.deploymentsCache ??= await readJsonArrayFile(
      join(this.datasetsDir, 'deployments', 'deployments.json'),
      deploymentEventSchema,
    );
    return this.deploymentsCache;
  }
}

function parseWindow(q: TimeWindowQuery): { window: TimeWindow; fromMs: number; toMs: number } {
  return {
    window: { from: q.from, to: q.to },
    fromMs: Date.parse(q.from),
    toMs: Date.parse(q.to),
  };
}

function byTimestampAsc(a: { timestamp: string }, b: { timestamp: string }): number {
  return Date.parse(a.timestamp) - Date.parse(b.timestamp);
}

/** Lê um arquivo JSON de array validando cada item; item inválido é ignorado com warning. */
async function readJsonArrayFile<T>(filePath: string, schema: z.ZodType<T>): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const parsed = z.array(z.unknown()).safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.warn(`[providers] WARN ${filePath} não contém um array JSON — tratado como vazio`);
    return [];
  }
  const items: T[] = [];
  for (const [index, item] of parsed.data.entries()) {
    const result = schema.safeParse(item);
    if (result.success) {
      items.push(result.data);
    } else {
      console.warn(
        `[providers] WARN item ${index} malformado em ${filePath} ignorado: ${result.error.issues[0]?.message ?? 'fora do schema'}`,
      );
    }
  }
  return items;
}
