import { describe, expect, it } from 'vitest';
import { loadCases, runEvals } from './runner.js';
import type { EvalRunSummary } from './runner.js';

/**
 * Integração do runner (teste 70 da techspec): `runEvals()` executa os 3 casos
 * reais pelo client MCP real (server spawnado via stdio) e o case-001 fecha em
 * score 1.0 com 0 termos proibidos; a saída traz o breakdown por caso (RF27).
 */

describe('runEvals() sobre os 3 casos', () => {
  let summary: EvalRunSummary;
  const outLines: string[] = [];
  const errLines: string[] = [];

  it('executa os casos com case-001 em score 1.0 e 0 termos proibidos', async () => {
    summary = await runEvals({
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    });

    expect(summary.results).toHaveLength(3);
    expect(summary.results.map((result) => result.caseId)).toEqual([
      'case-001-database-timeout',
      'case-002-payment-api-timeout',
      'case-003-missing-data',
    ]);

    const case001 = summary.results[0];
    expect(case001?.score).toBe(1);
    expect(case001?.passed).toBe(true);
    // 0 termos proibidos: todos os critérios `proibido:*` aprovados
    const forbidden = case001?.criteria.filter((criterion) => criterion.name.startsWith('proibido:')) ?? [];
    expect(forbidden.length).toBeGreaterThan(0);
    expect(forbidden.every((criterion) => criterion.passed)).toBe(true);

    // Breakdown de critérios por caso na saída (RF27), não apenas o agregado
    const output = outLines.join('\n');
    expect(output).toContain('case-001-database-timeout — score 1.00');
    expect(output).toContain('[OK] finding:DatabaseTimeoutException');
    expect(output).toContain('[OK] proibido:certeza absoluta');
    expect(output).toContain('[OK] cita_evidencias');
    expect(output).toContain('[OK] separa_fato_de_hipotese');
    expect(output).toContain('[OK] proximos_passos_seguros');
    expect(output).toContain('Resumo:');

    // Progresso separado dos resultados (stderr ≠ stdout)
    expect(errLines.join('\n')).toContain('case-001-database-timeout');
  }, 90_000);
});

describe('loadCases()', () => {
  it('carrega os 3 casos válidos em ordem determinística (RF24/RF25)', async () => {
    const cases = await loadCases();

    expect(cases.map((evalCase) => evalCase.id)).toEqual([
      'case-001-database-timeout',
      'case-002-payment-api-timeout',
      'case-003-missing-data',
    ]);
    for (const evalCase of cases) {
      expect(evalCase.question.length).toBeGreaterThan(0);
      expect(evalCase.expected_findings.length).toBeGreaterThan(0);
      expect(evalCase.must_not_include.length).toBeGreaterThan(0);
    }
  });
});
