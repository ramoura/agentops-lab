import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeKnowledgeProvider } from './knowledge/fake-knowledge-provider.js';
import { FakeObservabilityProvider } from './observability/fake-observability-provider.js';

/**
 * Bordas dos providers sobre fixtures sintéticas criadas em tempo de teste:
 * entradas parciais (endpoint/statusCode nulos), arquivos de dataset
 * malformados e knowledge base ausente — sempre resultado vazio bem definido
 * ou warning, nunca exceção não tratada nem dado inventado (RF14).
 */

const WINDOW = { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' };

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentops-provider-edges-'));

  // datasets/ sintético: logs com campos nulos, latency.json que não é array,
  // deployments.json com item malformado no meio de itens válidos
  await mkdir(join(root, 'datasets', 'logs'), { recursive: true });
  await mkdir(join(root, 'datasets', 'metrics'), { recursive: true });
  await mkdir(join(root, 'datasets', 'deployments'), { recursive: true });
  const logs = [
    // ERROR sem endpoint (branch: endpoint null não entra em byEndpoint)
    { timestamp: '2026-07-08T10:05:00-03:00', service: 'edge-api', level: 'ERROR', traceId: 'e-1', endpoint: null, statusCode: 500, exception: 'EdgeException', message: 'falha sem endpoint', latencyMs: 90 },
    // INFO sem statusCode (branch: não conta como requisição)
    { timestamp: '2026-07-08T10:06:00-03:00', service: 'edge-api', level: 'INFO', traceId: 'e-2', endpoint: null, statusCode: null, exception: null, message: 'evento interno', latencyMs: null },
    { timestamp: '2026-07-08T10:07:00-03:00', service: 'edge-api', level: 'ERROR', traceId: 'e-3', endpoint: 'GET /edge', statusCode: 500, exception: 'EdgeException', message: 'falha com endpoint', latencyMs: 120 },
  ];
  await writeFile(join(root, 'datasets', 'logs', 'edge-api.jsonl'), logs.map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
  await writeFile(join(root, 'datasets', 'metrics', 'latency.json'), '{"nao":"é array"}', 'utf8');
  await writeFile(
    join(root, 'datasets', 'deployments', 'deployments.json'),
    JSON.stringify([
      { timestamp: '2026-07-08T10:03:00-03:00', service: 'edge-api', version: '1.0.1', previousVersion: null, changeSummary: null },
      { malformado: true },
    ]),
    'utf8',
  );

  // knowledge-base/ sintético: só runbooks (sem adrs/tech-specs)
  await mkdir(join(root, 'knowledge-base', 'runbooks'), { recursive: true });
  await writeFile(join(root, 'knowledge-base', 'runbooks', 'edge.md'), '# Runbook edge\n\ncorpo sobre timeout\n', 'utf8');
  // base separada com um "documento" que é diretório (erro de leitura ≠ ENOENT)
  await mkdir(join(root, 'knowledge-eisdir', 'runbooks', 'pasta.md'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FakeObservabilityProvider — dados parciais e arquivos malformados', () => {
  it('logs sem endpoint/statusCode não contaminam contagens nem byEndpoint', async () => {
    const provider = new FakeObservabilityProvider({ datasetsDir: join(root, 'datasets') });
    const summary = await provider.getErrorSummary({ service: 'edge-api', ...WINDOW });

    expect(summary.hasData).toBe(true);
    expect(summary.totalRequests).toBe(2); // o log sem statusCode não é requisição
    expect(summary.count5xx).toBe(2);
    expect(summary.byEndpoint).toEqual([{ endpoint: 'GET /edge', count5xx: 1 }]); // endpoint null fica de fora
  });

  it('latency.json que não é array vira ausência de métricas, com warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const provider = new FakeObservabilityProvider({ datasetsDir: join(root, 'datasets') });
      const latency = await provider.getLatencySummary({ service: 'edge-api', ...WINDOW });

      expect(latency.hasData).toBe(false);
      expect(latency.overall).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('item malformado em deployments.json é ignorado com warning; válidos permanecem', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const provider = new FakeObservabilityProvider({ datasetsDir: join(root, 'datasets') });
      const deployments = await provider.getDeploymentEvents({ service: 'edge-api', ...WINDOW });

      expect(deployments.hasData).toBe(true);
      expect(deployments.events).toHaveLength(1);
      expect(deployments.events[0]?.version).toBe('1.0.1');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('FakeKnowledgeProvider — knowledge base parcial ou ausente', () => {
  it('query sem tokens alfanuméricos retorna matches vazios sem tocar o filesystem', async () => {
    const provider = new FakeKnowledgeProvider({ knowledgeBaseDir: join(root, 'knowledge-base') });
    expect(await provider.search('runbooks', '!!! ???')).toEqual({ query: '!!! ???', matches: [] });
  });

  it('diretório do tipo inexistente (ex.: sem adrs/) retorna vazio, não erro', async () => {
    const provider = new FakeKnowledgeProvider({ knowledgeBaseDir: join(root, 'knowledge-base') });
    const result = await provider.search('adrs', 'timeout');

    expect(result.matches).toEqual([]);
    // segunda chamada usa o cache do diretório vazio (mesmo resultado)
    expect(await provider.search('adrs', 'timeout')).toEqual(result);
  });

  it('runbook cujo caminho não é arquivo propaga o erro (não é ENOENT)', async () => {
    const provider = new FakeKnowledgeProvider({ knowledgeBaseDir: join(root, 'knowledge-eisdir') });
    await expect(provider.getRunbook('pasta')).rejects.toThrow();
  });

  it('busca em base sintética encontra o runbook pelo corpo', async () => {
    const provider = new FakeKnowledgeProvider({ knowledgeBaseDir: join(root, 'knowledge-base') });
    const result = await provider.search('runbooks', 'timeout');

    expect(result.matches[0]?.name).toBe('edge');
    expect(result.matches[0]?.title).toBe('Runbook edge');
  });
});
