import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmEngineError } from '@agentops/llm-engine';
import type { LlmUsage } from '@agentops/llm-engine';
import type { InvestigationAssistant, InvestigationOutcome } from '@agentops/types';
import { loadCases, runEvals } from './runner.js';
import type { EvalRunSummary } from './runner.js';

/**
 * Integração do runner (teste 70 da techspec V1 + testes 36–38 da V2):
 * `runEvals()` executa os 3 casos reais pelo client MCP real (server spawnado
 * via stdio); o modo default permanece o da V1 e o modo llm aplica o
 * `TextReportScorer` sobre o markdown do assistant (aqui, um fake — nenhum
 * teste da suíte gasta tokens).
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
    // Teste 21 (V2.5): modo deterministic não emite linha de cache
    expect(errLines.join('\n')).not.toContain('Cache:');
  }, 90_000);
});

/** Markdown roteirizado por caso: contrato de formato + findings do cenário. */
function scriptedMarkdown(question: string): string {
  if (question.includes('checkout-api')) {
    return [
      '## Resumo executivo',
      'Pico de 5xx no checkout-api correlacionado ao deploy 2026.07.08-1 (esgotamento do connection pool).',
      '## Evidências encontradas',
      '1. DatabaseTimeoutException dominante em POST /checkout; p99 elevado após o deploy.',
      '   Fonte: get_top_exceptions (exceptions[0])',
      '## Hipótese principal',
      'Regressão do deploy afetando o connection pool.',
      '## Hipóteses alternativas',
      '- Degradação do banco.',
      '## Próximos passos seguros',
      '1. Comparar o diff do deploy com a versão anterior.',
      '## Dados faltantes',
      '- Métricas internas do banco.',
      '## Confiança da análise',
      'alta',
    ].join('\n');
  }
  if (question.includes('payment-api')) {
    return [
      '## Resumo executivo',
      'Timeouts no payment-api causados por dependência externa.',
      '## Evidências encontradas',
      '1. PaymentGatewayTimeoutException em POST /payments; p99 acima do normal.',
      '   Fonte: get_top_exceptions (exceptions[0])',
      '## Hipótese principal',
      'Instabilidade da dependência externa (gateway de pagamento).',
      '## Hipóteses alternativas',
      '- Saturação de rede.',
      '## Próximos passos seguros',
      '1. Verificar o status page do gateway.',
      '## Dados faltantes',
      '- Métricas do lado do gateway.',
      '## Confiança da análise',
      'media',
    ].join('\n');
  }
  return [
    '## Resumo executivo',
    'Sem registros para o inventory-api na janela consultada.',
    '## Evidências encontradas',
    '## Hipótese principal',
    'Nenhuma hipótese pôde ser formulada.',
    '## Hipóteses alternativas',
    'Nenhuma.',
    '## Próximos passos seguros',
    '1. Confirmar o nome do serviço e a janela consultada.',
    '## Dados faltantes',
    '- Sem registros de erro para o inventory-api.',
    '- Sem métricas de latência para a janela.',
    '## Confiança da análise',
    'baixa',
  ].join('\n');
}

class FakeLlmAssistant implements InvestigationAssistant {
  async investigate(question: string): Promise<InvestigationOutcome> {
    return { kind: 'markdown', markdown: scriptedMarkdown(question), audit: [] };
  }
}

// Testes 36 (modo llm) e 37 + integração "eval runner com engine fake"
// + teste 22 (V2.5): fake sem `lastUsage` → runner não quebra, linha omitida
describe('runEvals({ engine: "llm", assistant: fake }) sobre os 3 casos', () => {
  it('aplica o TextReportScorer, imprime o breakdown e o resumo indica engine: llm', async () => {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const summary = await runEvals({
      engine: 'llm',
      assistant: new FakeLlmAssistant(),
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    });

    expect(summary.engine).toBe('llm');
    expect(summary.results).toHaveLength(3);
    expect(summary.passedCount).toBe(3);
    expect(summary.averageScore).toBe(1);

    const output = outLines.join('\n');
    // Breakdown por critério (RF27) vindo do TextReportScorer (linha "Fonte:")
    expect(output).toContain('[OK] finding:DatabaseTimeoutException');
    expect(output).toContain('[OK] cita_evidencias');
    expect(output).toContain('[OK] proximos_passos_seguros');
    // Resumo indica o engine usado
    expect(output).toContain('Resumo: 3/3 caso(s) aprovado(s) · score médio 1.00 · engine: llm');

    // Teste 22 (V2.5): instrumentação opcional — fake sem `lastUsage` não
    // quebra o runner e a linha de cache é simplesmente omitida.
    expect(errLines.join('\n')).not.toContain('Cache:');
  }, 90_000);
});

/** Fake llm que expõe `lastUsage` (mesma superfície do assistant concreto). */
class FakeLlmAssistantWithUsage extends FakeLlmAssistant {
  readonly lastUsage: LlmUsage = {
    inputTokens: 3900,
    outputTokens: 5100,
    cacheReadTokens: 44200,
    cacheCreationTokens: 9200,
    rounds: 5,
  };
}

// Teste 20 (V2.5): linha de cache por caso em stderr; stdout inalterado
describe('runEvals({ engine: "llm" }) com assistant expondo lastUsage', () => {
  it('emite a linha Cache por caso em stderr e mantém o stdout de scores intacto', async () => {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const summary = await runEvals({
      engine: 'llm',
      assistant: new FakeLlmAssistantWithUsage(),
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    });

    // Uma linha de cache por caso, no formato da techspec
    const cacheLines = errLines.filter((line) => line.includes('Cache:'));
    expect(cacheLines).toHaveLength(3);
    for (const line of cacheLines) {
      expect(line).toBe('  Cache: 44.2k lido · 9.2k escrito · 3.9k sem cache');
    }

    // stdout byte-idêntico ao da V2: scores/resumo sem nenhuma linha de cache
    const output = outLines.join('\n');
    expect(output).not.toContain('Cache:');
    expect(output).toContain('Resumo: 3/3 caso(s) aprovado(s) · score médio 1.00 · engine: llm');
    expect(summary.passedCount).toBe(3);
  }, 90_000);
});

// Teste 36 (modo llm sem key): validação antes de qualquer spawn
describe('runEvals({ engine: "llm" }) sem ANTHROPIC_API_KEY', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falha rápido com missing_api_key, sem montar o assistant real', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    await expect(runEvals({ engine: 'llm', out: () => {}, err: () => {} })).rejects.toSatisfy(
      (error: unknown) => error instanceof LlmEngineError && error.code === 'missing_api_key',
    );
  });
});

// Teste 38: clarification num caso (modo deterministic) → erro apontando o caso
describe('outcome clarification num caso', () => {
  it('gera erro orientativo apontando o caso e o campo faltante', async () => {
    const clarifying: InvestigationAssistant = {
      async investigate(): Promise<InvestigationOutcome> {
        return { kind: 'clarification', missing: [{ field: 'window', hint: 'informe o período' }] };
      },
    };

    await expect(runEvals({ assistant: clarifying, out: () => {}, err: () => {} })).rejects.toThrow(
      /caso case-001-database-timeout: .*faltou: window.*corrija o campo "question"/,
    );
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
