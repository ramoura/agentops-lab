import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FakeKnowledgeProvider, FakeObservabilityProvider } from '@agentops/providers';
import { errorSummarySchema, runbookResultSchema, TOOL_NAMES } from '@agentops/types';
import { logger } from './logger.js';
import { createAgentopsServer, SERVER_NAME, SERVER_VERSION } from './server-factory.js';

/**
 * Complemento in-process dos testes de protocolo (`agentops-server.test.ts`):
 * a mesma factory e os mesmos módulos de tools, conectados via
 * `InMemoryTransport` do SDK — sem processo filho, para o coverage v8 enxergar
 * o código do server (o spawn stdio roda fora do processo instrumentado).
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const INCIDENT_WINDOW = { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' };

let client: Client;

beforeAll(async () => {
  const server = createAgentopsServer({
    observability: new FakeObservabilityProvider({ datasetsDir: join(repoRoot, 'datasets') }),
    knowledge: new FakeKnowledgeProvider({ knowledgeBaseDir: join(repoRoot, 'knowledge-base') }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'agentops-server-inprocess-tests', version: SERVER_VERSION });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client?.close();
});

async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function firstText(result: CallToolResult): string {
  const first = result.content?.[0];
  return first?.type === 'text' ? first.text : '';
}

describe('factory in-process', () => {
  it(`compõe ${SERVER_NAME} com as 9 tools dos módulos observability e knowledge`, async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('todas as 9 tools respondem com structuredContent no caminho feliz', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: 'get_error_summary', args: { service: 'checkout-api', ...INCIDENT_WINDOW } },
      { name: 'get_top_exceptions', args: { service: 'checkout-api', ...INCIDENT_WINDOW, limit: 3 } },
      { name: 'get_recent_logs', args: { service: 'checkout-api', ...INCIDENT_WINDOW, level: 'ERROR', limit: 10 } },
      { name: 'get_latency_summary', args: { service: 'checkout-api', ...INCIDENT_WINDOW } },
      { name: 'get_deployment_events', args: { service: 'checkout-api', ...INCIDENT_WINDOW } },
      { name: 'search_runbooks', args: { query: 'checkout 5xx' } },
      { name: 'get_runbook', args: { name: 'checkout-api-high-5xx' } },
      { name: 'search_adrs', args: { query: 'checkout pagamento' } },
      { name: 'search_tech_specs', args: { query: 'checkout' } },
    ];

    for (const { name, args } of calls) {
      const result = await callTool(name, args);
      expect(result.isError, `${name} não deveria retornar isError`).not.toBe(true);
      expect(result.structuredContent, `${name} sem structuredContent`).toBeDefined();
      // Espelho serializado para clients sem suporte a structured content
      expect(JSON.parse(firstText(result))).toEqual(result.structuredContent);
    }
  });

  it('valida entrada com envelope ToolError prefixado por código', async () => {
    const invertedWindow = await callTool('get_error_summary', {
      service: 'checkout-api',
      from: INCIDENT_WINDOW.to,
      to: INCIDENT_WINDOW.from,
    });
    expect(invertedWindow.isError).toBe(true);
    expect(firstText(invertedWindow)).toMatch(/^INVALID_TIME_RANGE:/);

    const emptyQuery = await callTool('search_runbooks', { query: '   ' });
    expect(emptyQuery.isError).toBe(true);
    expect(firstText(emptyQuery)).toMatch(/^EMPTY_QUERY:/);

    // Timestamp sem offset passa no shape de descoberta do SDK (string), mas
    // é rejeitado pela validação estrita do handler (schema completo de types)
    const missingOffset = await callTool('get_recent_logs', {
      service: 'checkout-api',
      from: '2026-07-08T10:00:00',
      to: '2026-07-08T10:30:00',
    });
    expect(missingOffset.isError).toBe(true);
    expect(firstText(missingOffset)).toMatch(/^INVALID_ARGUMENT:/);
  });

  it('ausência de dados é resultado válido, nunca isError (RF14)', async () => {
    const noData = await callTool('get_error_summary', { service: 'inventory-api', ...INCIDENT_WINDOW });
    expect(noData.isError).not.toBe(true);
    const summary = errorSummarySchema.parse(noData.structuredContent);
    expect(summary.hasData).toBe(false);
    expect(summary.totalRequests).toBe(0);

    const notFound = await callTool('get_runbook', { name: 'nao-existe' });
    expect(notFound.isError).not.toBe(true);
    const runbook = runbookResultSchema.parse(notFound.structuredContent);
    expect(runbook.found).toBe(false);
    expect(runbook.content).toBeNull();
  });
});

describe('logger', () => {
  it('escreve em stderr apenas do nível ativo para cima (default warn)', () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      logger.debug('mensagem debug');
      logger.info('mensagem info');
      logger.warn('mensagem warn');
      logger.error('mensagem error');
    } finally {
      process.stderr.write = original;
    }

    const output = written.join('');
    expect(output).not.toContain('DEBUG mensagem debug');
    expect(output).not.toContain('INFO mensagem info');
    expect(output).toContain('[agentops-server] WARN mensagem warn');
    expect(output).toContain('[agentops-server] ERROR mensagem error');
  });
});
