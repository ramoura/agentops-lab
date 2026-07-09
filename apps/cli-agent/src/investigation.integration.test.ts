import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeterministicInvestigationEngine, PtBrQuestionParser } from '@agentops/core';
import type { InvestigationReport } from '@agentops/types';
import { McpToolInvoker } from './mcp-tool-invoker.js';
import { renderReport } from './renderer.js';

/**
 * Integração engine + agentops-server reais (testes 67–69 da techspec): o
 * server é spawnado via MCP stdio e a investigação percorre o mesmo caminho
 * da CLI, sobre os datasets versionados do repositório.
 */

const QUESTIONS = {
  case001: 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08',
  case002: 'Investigue por que o payment-api teve timeout entre 14h e 14h20 em 2026-07-08',
  case003: 'Investigue por que o inventory-api teve erro 5xx entre 10h e 10h30 em 2026-07-08',
} as const;

const TELEMETRY_TOOLS = [
  'get_error_summary',
  'get_top_exceptions',
  'get_recent_logs',
  'get_latency_summary',
  'get_deployment_events',
];

let invoker: McpToolInvoker;
const engine = new DeterministicInvestigationEngine();
const parser = new PtBrQuestionParser();

beforeAll(async () => {
  invoker = await McpToolInvoker.connect({ serverStderr: 'inherit' });
}, 60_000);

afterAll(async () => {
  await invoker?.close();
});

async function investigate(question: string): Promise<InvestigationReport> {
  const parsed = parser.parse(question);
  if (!parsed.ok) {
    throw new Error(`pergunta deveria ser parseável: ${JSON.stringify(parsed.missing)}`);
  }
  return engine.investigate(parsed.context, invoker);
}

// Teste 67
describe('case-001 — checkout-api (cenário principal)', () => {
  it('produz hipótese de regressão de deploy com confiança alta, ≥4 evidências e auditoria na ordem da skill', async () => {
    const report = await investigate(QUESTIONS.case001);

    expect(report.primaryHypothesis).not.toBeNull();
    expect(report.primaryHypothesis?.statement.toLowerCase()).toMatch(/regress/);
    expect(report.primaryHypothesis?.statement.toLowerCase()).toContain('deploy');
    expect(report.primaryHypothesis?.confidence).toBe('alta');
    expect(report.confidence).toBe('alta');

    expect(report.evidences.length).toBeGreaterThanOrEqual(4);
    for (const evidence of report.evidences) {
      expect(evidence.source.tool).toBeTruthy();
      expect(evidence.source.reference).toBeTruthy();
    }

    // Auditoria: ≥8 chamadas na ordem dos passos 2–8 da skill (RF16/RF7)
    expect(report.audit.length).toBeGreaterThanOrEqual(8);
    expect(report.audit.map((record) => record.tool)).toEqual([
      'get_error_summary',
      'get_top_exceptions',
      'get_recent_logs',
      'get_latency_summary',
      'get_latency_summary', // baseline (janela anterior de mesma duração)
      'get_deployment_events',
      'search_runbooks',
      'get_runbook',
      'search_adrs',
      'search_tech_specs',
    ]);
    expect(report.audit.map((record) => record.seq)).toEqual(report.audit.map((_, index) => index + 1));
  }, 30_000);
});

// Teste 68
describe('case-002 — payment-api (cenário secundário)', () => {
  it('produz hipótese de dependência externa, sem mencionar deploy inexistente', async () => {
    const report = await investigate(QUESTIONS.case002);

    expect(report.primaryHypothesis).not.toBeNull();
    expect(report.primaryHypothesis?.statement.toLowerCase()).toMatch(/depend/);
    // Não alega regressão de um deploy que não existiu (declarar "sem deploy" é correto)
    expect(report.primaryHypothesis?.statement.toLowerCase()).not.toMatch(/regress|deploy da vers/);

    // Nenhuma evidência de deploy (não houve deploy do payment-api na janela)
    expect(report.evidences.some((evidence) => evidence.source.tool === 'get_deployment_events')).toBe(false);
    const rendered = renderReport(report, false);
    expect(rendered.toLowerCase()).not.toContain('deploy da versão');
  }, 30_000);
});

// Teste 69
describe('case-003 — serviço sem dados (US9)', () => {
  it('declara dados ausentes com confiança baixa e zero findings inventados', async () => {
    const report = await investigate(QUESTIONS.case003);

    expect(report.primaryHypothesis).toBeNull();
    expect(report.confidence).toBe('baixa');
    expect(report.missingData.length).toBeGreaterThanOrEqual(4);
    expect(report.missingData.join(' ')).toContain('inventory-api');

    // Nenhum fato de telemetria fabricado: sem dados, sem evidência dessas tools
    expect(report.evidences.some((evidence) => TELEMETRY_TOOLS.includes(evidence.source.tool))).toBe(false);

    const rendered = renderReport(report, false);
    expect(rendered).not.toContain('DatabaseTimeoutException');
    expect(rendered).not.toContain('POST /checkout');
  }, 30_000);
});
