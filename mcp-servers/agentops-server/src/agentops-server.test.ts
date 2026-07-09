import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  deploymentEventsResultSchema,
  documentSearchResultSchema,
  errorSummarySchema,
  latencySummarySchema,
  recentLogsResultSchema,
  runbookResultSchema,
  topExceptionsResultSchema,
  TOOL_NAMES,
} from '@agentops/types';
import type { z } from 'zod';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const INCIDENT_WINDOW = { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' };

/** Conexão MCP real (server spawnado via stdio com tsx), reutilizada pela suite inteira. */
let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'mcp-servers/agentops-server/src/main.ts')],
    stderr: 'inherit',
  });
  client = new Client({ name: 'agentops-server-integration-tests', version: '0.1.0' });
  await client.connect(transport);
}, 60_000);

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

// Teste 62
describe('descoberta de tools', () => {
  it('listTools() retorna exatamente as 9 tools, com descrição não vazia e inputSchema', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description, `descrição de ${tool.name}`).toBeTruthy();
      expect(tool.inputSchema, `inputSchema de ${tool.name}`).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(Object.keys(tool.inputSchema.properties ?? {}).length, `parâmetros de ${tool.name}`).toBeGreaterThan(0);
    }
  });
});

// Teste 63
describe('callTool com parâmetros válidos → structuredContent valida contra o schema de saída', () => {
  const cases: Array<{ name: string; args: Record<string, unknown>; schema: z.ZodTypeAny }> = [
    { name: 'get_error_summary', args: { service: 'checkout-api', ...INCIDENT_WINDOW }, schema: errorSummarySchema },
    {
      name: 'get_top_exceptions',
      args: { service: 'checkout-api', ...INCIDENT_WINDOW, limit: 3 },
      schema: topExceptionsResultSchema,
    },
    {
      name: 'get_recent_logs',
      args: { service: 'checkout-api', ...INCIDENT_WINDOW, level: 'ERROR', limit: 10 },
      schema: recentLogsResultSchema,
    },
    { name: 'get_latency_summary', args: { service: 'checkout-api', ...INCIDENT_WINDOW }, schema: latencySummarySchema },
    {
      name: 'get_deployment_events',
      args: { service: 'checkout-api', from: '2026-07-08T09:48:00-03:00', to: INCIDENT_WINDOW.to },
      schema: deploymentEventsResultSchema,
    },
    { name: 'search_runbooks', args: { query: 'checkout 5xx' }, schema: documentSearchResultSchema },
    { name: 'get_runbook', args: { name: 'checkout-api-high-5xx' }, schema: runbookResultSchema },
    { name: 'search_adrs', args: { query: 'payment' }, schema: documentSearchResultSchema },
    { name: 'search_tech_specs', args: { query: 'checkout' }, schema: documentSearchResultSchema },
  ];

  it.each(cases)('$name', async ({ name, args, schema }) => {
    const result = await callTool(name, args);

    expect(result.isError, `isError de ${name}: ${firstText(result)}`).toBeFalsy();
    const parsed = schema.safeParse(result.structuredContent);
    expect(parsed.success, `structuredContent de ${name}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    // content[0].text espelha o structuredContent serializado
    expect(JSON.parse(firstText(result))).toEqual(result.structuredContent);
  });
});

// Teste 64
describe('validação de entrada via protocolo → isError com código prefixado', () => {
  it("get_error_summary com from > to → isError: true com prefixo INVALID_TIME_RANGE", async () => {
    const result = await callTool('get_error_summary', {
      service: 'checkout-api',
      from: INCIDENT_WINDOW.to,
      to: INCIDENT_WINDOW.from,
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/^INVALID_TIME_RANGE: /);
    expect(result.structuredContent).toBeUndefined();
  });

  it('search_runbooks com query vazia (só espaços) → isError: true com prefixo EMPTY_QUERY', async () => {
    const result = await callTool('search_runbooks', { query: '   ' });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/^EMPTY_QUERY: /);
  });

  it('janela acima de 24h → isError: true com prefixo INVALID_TIME_RANGE', async () => {
    const result = await callTool('get_latency_summary', {
      service: 'checkout-api',
      from: '2026-07-07T00:00:00-03:00',
      to: '2026-07-08T12:00:00-03:00',
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/^INVALID_TIME_RANGE: /);
  });

  it('timestamp sem offset → isError: true com prefixo INVALID_ARGUMENT', async () => {
    const result = await callTool('get_error_summary', {
      service: 'checkout-api',
      from: '2026-07-08 10:00',
      to: INCIDENT_WINDOW.to,
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/^INVALID_ARGUMENT: /);
  });
});

// Teste 65
describe('ausência de dados via protocolo → resposta bem formada, nunca isError (RF14)', () => {
  it('serviço inexistente em get_error_summary → hasData: false com contadores zerados', async () => {
    const result = await callTool('get_error_summary', { service: 'servico-inexistente', ...INCIDENT_WINDOW });

    expect(result.isError).toBeFalsy();
    const summary = errorSummarySchema.parse(result.structuredContent);
    expect(summary.hasData).toBe(false);
    expect(summary.totalRequests).toBe(0);
    expect(summary.byEndpoint).toEqual([]);
    expect(summary.timeline).toEqual([]);
  });

  it('runbook inexistente em get_runbook → found: false com campos null', async () => {
    const result = await callTool('get_runbook', { name: 'runbook-que-nao-existe' });

    expect(result.isError).toBeFalsy();
    expect(runbookResultSchema.parse(result.structuredContent)).toEqual({
      found: false,
      name: null,
      title: null,
      content: null,
    });
  });

  it('busca sem correspondência em search_runbooks → matches: []', async () => {
    const result = await callTool('search_runbooks', { query: 'kafka rebalance' });

    expect(result.isError).toBeFalsy();
    expect(documentSearchResultSchema.parse(result.structuredContent).matches).toEqual([]);
  });
});

// Teste 66
describe('determinismo fim-a-fim (RF9)', () => {
  it('mesma chamada duas vezes → structuredContent idêntico', async () => {
    const args = { service: 'checkout-api', ...INCIDENT_WINDOW };
    const [first, second] = [await callTool('get_error_summary', args), await callTool('get_error_summary', args)];
    expect(first.structuredContent).toEqual(second.structuredContent);

    const searchArgs = { query: 'checkout 5xx database timeout' };
    const [firstSearch, secondSearch] = [
      await callTool('search_runbooks', searchArgs),
      await callTool('search_runbooks', searchArgs),
    ];
    expect(firstSearch.structuredContent).toEqual(secondSearch.structuredContent);
  });
});
