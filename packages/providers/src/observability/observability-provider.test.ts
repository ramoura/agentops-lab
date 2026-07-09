import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeObservabilityProvider } from './fake-observability-provider.js';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const datasetsDir = join(repoRoot, 'datasets');
const fixturesDir = fileURLToPath(new URL('../__fixtures__/datasets', import.meta.url));

const INCIDENT_WINDOW = { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' };
const BASELINE_WINDOW = { from: '2026-07-08T09:30:00-03:00', to: '2026-07-08T10:00:00-03:00' };

let provider: FakeObservabilityProvider;

beforeEach(() => {
  provider = new FakeObservabilityProvider({ datasetsDir });
});

describe('getErrorSummary', () => {
  // Teste 15
  it('agrega o cenário principal: contagens, POST /checkout no topo e pico a partir do bucket 10:05', async () => {
    const summary = await provider.getErrorSummary({ service: 'checkout-api', ...INCIDENT_WINDOW });

    expect(summary.hasData).toBe(true);
    expect(summary.totalRequests).toBe(153);
    expect(summary.count5xx).toBe(88);
    expect(summary.count4xx).toBe(3);
    expect(summary.errorRate5xx).toBeCloseTo(0.5752, 4);
    expect(summary.byEndpoint[0]).toEqual({ endpoint: 'POST /checkout', count5xx: 83 });
    expect(summary.byEndpoint[1]).toEqual({ endpoint: 'GET /checkout/status', count5xx: 5 });

    expect(summary.timeline).toHaveLength(6);
    expect(summary.timeline[0]).toEqual({ bucketStart: '2026-07-08T10:00:00-03:00', count5xx: 0 });
    expect(summary.timeline[1]?.bucketStart).toBe('2026-07-08T10:05:00-03:00');
    for (const bucket of summary.timeline.slice(1)) {
      expect(bucket.count5xx).toBeGreaterThanOrEqual(15);
    }
  });

  // Teste 16
  it('fora da janela do incidente (09:00–09:30) retorna hasData true com 5xx zero', async () => {
    const summary = await provider.getErrorSummary({
      service: 'checkout-api',
      from: '2026-07-08T09:00:00-03:00',
      to: '2026-07-08T09:30:00-03:00',
    });

    expect(summary.hasData).toBe(true);
    expect(summary.count5xx).toBe(0);
    expect(summary.totalRequests).toBeGreaterThan(0);
  });

  // Teste 17
  it('serviço inexistente retorna hasData false, zeros e arrays vazios (RF14)', async () => {
    const summary = await provider.getErrorSummary({ service: 'inventory-api', ...INCIDENT_WINDOW });

    expect(summary).toEqual({
      service: 'inventory-api',
      window: { from: INCIDENT_WINDOW.from, to: INCIDENT_WINDOW.to },
      hasData: false,
      totalRequests: 0,
      count5xx: 0,
      count4xx: 0,
      errorRate5xx: 0,
      byEndpoint: [],
      timeline: [],
    });
  });
});

describe('janela semiaberta [from, to)', () => {
  // Teste 18
  it('inclui log exatamente em from e exclui log exatamente em to', async () => {
    // Existe um ERROR exatamente às 10:07:00 no dataset.
    const atFrom = await provider.getRecentLogs({
      service: 'checkout-api',
      from: '2026-07-08T10:07:00-03:00',
      to: '2026-07-08T10:07:01-03:00',
    });
    expect(atFrom.logs).toHaveLength(1);
    expect(atFrom.logs[0]?.timestamp).toBe('2026-07-08T10:07:00-03:00');

    const beforeTo = await provider.getRecentLogs({
      service: 'checkout-api',
      from: '2026-07-08T10:06:00-03:00',
      to: '2026-07-08T10:07:00-03:00',
    });
    expect(beforeTo.logs.length).toBeGreaterThan(0);
    for (const log of beforeTo.logs) {
      expect(log.timestamp).not.toBe('2026-07-08T10:07:00-03:00');
    }
  });
});

describe('getTopExceptions', () => {
  // Teste 19
  it('ordena por count decrescente com DatabaseTimeoutException no topo', async () => {
    const result = await provider.getTopExceptions({ service: 'checkout-api', ...INCIDENT_WINDOW });

    expect(result.hasData).toBe(true);
    expect(result.exceptions[0]).toMatchObject({
      exception: 'DatabaseTimeoutException',
      count: 80,
      sampleMessage: 'Timeout while calling payment database',
    });
    expect(result.exceptions[0]?.endpoints).toContain('POST /checkout');
    expect(result.exceptions[1]).toMatchObject({ exception: 'ConnectionPoolExhaustedException', count: 8 });
    for (let i = 1; i < result.exceptions.length; i += 1) {
      expect(result.exceptions[i - 1]!.count).toBeGreaterThanOrEqual(result.exceptions[i]!.count);
    }
  });

  // Teste 20
  it('respeita o limit', async () => {
    const result = await provider.getTopExceptions({ service: 'checkout-api', ...INCIDENT_WINDOW, limit: 1 });

    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]?.exception).toBe('DatabaseTimeoutException');
  });
});

describe('getRecentLogs', () => {
  // Teste 21
  it('filtra por level=ERROR; sem level retorna todos os níveis', async () => {
    const errorsOnly = await provider.getRecentLogs({ service: 'checkout-api', ...INCIDENT_WINDOW, level: 'ERROR' });
    expect(errorsOnly.logs.length).toBeGreaterThan(0);
    for (const log of errorsOnly.logs) {
      expect(log.level).toBe('ERROR');
    }

    const allLevels = await provider.getRecentLogs({ service: 'checkout-api', ...INCIDENT_WINDOW, limit: 200 });
    const levels = new Set(allLevels.logs.map((log) => log.level));
    expect(levels.size).toBeGreaterThan(1);
    expect(levels).toContain('INFO');
    expect(levels).toContain('ERROR');
  });

  // Teste 22
  it('aplica limit default 50 com truncated e ordenação decrescente por timestamp', async () => {
    const result = await provider.getRecentLogs({ service: 'checkout-api', ...INCIDENT_WINDOW, level: 'ERROR' });

    expect(result.totalMatched).toBe(88);
    expect(result.logs).toHaveLength(50);
    expect(result.truncated).toBe(true);
    for (let i = 1; i < result.logs.length; i += 1) {
      expect(Date.parse(result.logs[i - 1]!.timestamp)).toBeGreaterThanOrEqual(Date.parse(result.logs[i]!.timestamp));
    }
  });
});

describe('getLatencySummary', () => {
  // Teste 23
  it('reporta p99 ≈ 3200 na janela do incidente e ≈ 450 no baseline', async () => {
    const incident = await provider.getLatencySummary({ service: 'checkout-api', ...INCIDENT_WINDOW });
    expect(incident.hasData).toBe(true);
    expect(incident.overall?.p99).toBeGreaterThanOrEqual(3000);
    expect(incident.overall?.p99).toBeLessThanOrEqual(3300);
    expect(incident.series[0]?.p99).toBeLessThan(500); // bucket 10:00 ainda normal
    expect(incident.series[1]?.p99).toBeGreaterThan(1900); // salto a partir de 10:05

    const baseline = await provider.getLatencySummary({ service: 'checkout-api', ...BASELINE_WINDOW });
    expect(baseline.overall?.p99).toBeGreaterThanOrEqual(430);
    expect(baseline.overall?.p99).toBeLessThanOrEqual(470);
  });

  // Teste 24
  it('serviço sem métricas retorna overall null e series vazia', async () => {
    const result = await provider.getLatencySummary({ service: 'inventory-api', ...INCIDENT_WINDOW });

    expect(result.hasData).toBe(false);
    expect(result.overall).toBeNull();
    expect(result.series).toEqual([]);
    expect(result.requestCount).toBe(0);
  });
});

describe('getDeploymentEvents', () => {
  // Teste 25
  it('retorna o deploy de 10:03 na janela 09:48–10:30 e nada na janela 10:10–10:30', async () => {
    const withDeploy = await provider.getDeploymentEvents({
      service: 'checkout-api',
      from: '2026-07-08T09:48:00-03:00',
      to: '2026-07-08T10:30:00-03:00',
    });
    expect(withDeploy.hasData).toBe(true);
    expect(withDeploy.events).toHaveLength(1);
    expect(withDeploy.events[0]).toMatchObject({
      timestamp: '2026-07-08T10:03:00-03:00',
      service: 'checkout-api',
      version: '2026.07.08-1',
      previousVersion: '2026.07.07-3',
    });

    const withoutDeploy = await provider.getDeploymentEvents({
      service: 'checkout-api',
      from: '2026-07-08T10:10:00-03:00',
      to: '2026-07-08T10:30:00-03:00',
    });
    expect(withoutDeploy.hasData).toBe(false);
    expect(withoutDeploy.events).toEqual([]);
  });
});

describe('robustez e determinismo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Teste 26
  it('ignora linha JSONL malformada com warning em stderr e processa as demais', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fixtureProvider = new FakeObservabilityProvider({ datasetsDir: fixturesDir });

    const result = await fixtureProvider.getRecentLogs({
      service: 'glitchy-api',
      from: '2026-07-08T10:00:00-03:00',
      to: '2026-07-08T10:30:00-03:00',
    });

    expect(result.hasData).toBe(true);
    expect(result.totalMatched).toBe(3); // 5 linhas no arquivo, 2 malformadas
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain('malformada');
  });

  // Teste 27
  it('é determinístico: chamadas idênticas retornam resultados profundamente iguais (RF9)', async () => {
    const first = await provider.getErrorSummary({ service: 'checkout-api', ...INCIDENT_WINDOW });
    const second = await provider.getErrorSummary({ service: 'checkout-api', ...INCIDENT_WINDOW });
    expect(second).toEqual(first);

    const freshProvider = new FakeObservabilityProvider({ datasetsDir });
    const third = await freshProvider.getErrorSummary({ service: 'checkout-api', ...INCIDENT_WINDOW });
    expect(third).toEqual(first);
  });
});
