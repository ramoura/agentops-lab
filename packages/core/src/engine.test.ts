import { describe, expect, it } from 'vitest';
import type { DeploymentEventsResult, DocumentSearchResult, RunbookResult } from '@agentops/types';
import { CONTEXT, StubToolInvoker, case001Responses, emptyResponses } from './__fixtures__/case-001.js';
import { DeterministicInvestigationEngine } from './engine.js';
import { ToolInvocationError } from './tool-invoker.js';

// Stub de ToolInvoker e fixtures do case-001: ./__fixtures__/case-001.ts
// (compartilhados com deterministic-assistant.test.ts).

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
