import { describe, expect, it } from 'vitest';
import { renderReport } from '@agentops/cli-agent/renderer';
import type { EvalCase, EvalCriterionResult, InvestigationReport } from '@agentops/types';
import { DeterministicEvalScorer } from './scorer.js';

const scorer = new DeterministicEvalScorer();

/** Relatório-fixture nos moldes do case-001 (mesmo formato do renderer real). */
function makeReport(overrides: Partial<InvestigationReport> = {}): InvestigationReport {
  return {
    context: {
      question: 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08',
      service: 'checkout-api',
      window: { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' },
      symptom: 'erro 5xx',
    },
    summary: 'O serviço checkout-api registrou 87 respostas 5xx em 412 requisições na janela consultada.',
    evidences: [
      {
        statement: '87 respostas 5xx em 412 requisições (21,1%), concentradas em POST /checkout.',
        source: { tool: 'get_error_summary', reference: 'count5xx/byEndpoint[0]' },
      },
      {
        statement: 'Exception mais frequente: DatabaseTimeoutException (78 ocorrências em POST /checkout).',
        source: { tool: 'get_top_exceptions', reference: 'exceptions[0]' },
      },
    ],
    primaryHypothesis: {
      statement: 'Regressão introduzida no deploy das 10h03 afetando acesso ao banco/connection pool.',
      rationale: 'Correlação temporal deploy → pico de 5xx + salto de p99.',
      confidence: 'alta',
    },
    alternativeHypotheses: [],
    safeNextSteps: [
      'Comparar a versão 2026.07.08-1 com a 2026.07.07-3 (diff do deploy).',
      'Avaliar rollback com o time responsável — não executar automaticamente.',
    ],
    missingData: [],
    confidence: 'alta',
    audit: [],
    ...overrides,
  };
}

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'case-fixture',
    question: 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08',
    expected_findings: [],
    must_not_include: [],
    ...overrides,
  };
}

function criterion(name: string, result: ReturnType<DeterministicEvalScorer['score']>): EvalCriterionResult {
  const found = result.criteria.find((item) => item.name === name);
  if (found === undefined) {
    throw new Error(`critério ${name} ausente do resultado`);
  }
  return found;
}

// Teste 52
describe('findings esperados', () => {
  it('finding presente no texto passa, com matching case/acento-insensível', () => {
    const report = makeReport();
    const rendered = renderReport(report, false);
    const result = scorer.score(
      makeCase({ expected_findings: ['databasetimeoutexception', 'REGRESSAO INTRODUZIDA'] }),
      report,
      rendered,
    );

    expect(criterion('finding:databasetimeoutexception', result).passed).toBe(true);
    expect(criterion('finding:REGRESSAO INTRODUZIDA', result).passed).toBe(true);
  });

  // Teste 53
  it('finding ausente falha e details aponta a ausência', () => {
    const report = makeReport();
    const result = scorer.score(makeCase({ expected_findings: ['kafka rebalance'] }), report, renderReport(report, false));

    const item = criterion('finding:kafka rebalance', result);
    expect(item.passed).toBe(false);
    expect(item.details).toContain('kafka rebalance');
    expect(item.details).toContain('não aparece');
  });
});

// Teste 54
describe('termos proibidos', () => {
  it('termo proibido presente no texto reprova o critério', () => {
    const report = makeReport({ summary: 'Temos certeza absoluta da causa raiz.' });
    const result = scorer.score(makeCase({ must_not_include: ['certeza absoluta'] }), report, renderReport(report, false));

    const item = criterion('proibido:certeza absoluta', result);
    expect(item.passed).toBe(false);
    expect(item.details).toContain('presente');
  });

  it('termo proibido ausente passa', () => {
    const report = makeReport();
    const result = scorer.score(makeCase({ must_not_include: ['drop table'] }), report, renderReport(report, false));

    expect(criterion('proibido:drop table', result).passed).toBe(true);
  });
});

// Teste 55
describe('cita_evidencias', () => {
  it('passa quando toda evidência tem source', () => {
    const report = makeReport();
    const result = scorer.score(makeCase(), report, renderReport(report, false));

    const item = criterion('cita_evidencias', result);
    expect(item.passed).toBe(true);
    expect(item.details).toBe('2/2 evidências com source');
  });

  it('falha com evidência sem citação (fixture manipulada)', () => {
    const report = makeReport();
    // Manipulação deliberada fora do schema: simula um engine que regrediu no RF5
    (report.evidences[0] as { source: { tool: string; reference: string } }).source = { tool: '', reference: '' };
    const result = scorer.score(makeCase(), report, renderReport(report, false));

    const item = criterion('cita_evidencias', result);
    expect(item.passed).toBe(false);
    expect(item.details).toContain('1 evidência(s) sem citação');
  });
});

// Teste 56
describe('separa_fato_de_hipotese', () => {
  it('passa com seções Evidências e Hipótese distintas e não vazias', () => {
    const report = makeReport();
    const result = scorer.score(makeCase(), report, renderReport(report, false));

    expect(criterion('separa_fato_de_hipotese', result).passed).toBe(true);
  });

  it('cenário missing-data: hipótese vazia + missingData preenchido também passa (US9)', () => {
    const report = makeReport({
      evidences: [],
      primaryHypothesis: null,
      missingData: ['Sem registros de requisições/erros para inventory-api na janela consultada.'],
      confidence: 'baixa',
    });
    const result = scorer.score(makeCase(), report, renderReport(report, false));

    expect(criterion('separa_fato_de_hipotese', result).passed).toBe(true);
  });

  it('falha quando não há hipótese nem dados faltantes declarados', () => {
    const report = makeReport({ primaryHypothesis: null, missingData: [] });
    const result = scorer.score(makeCase(), report, renderReport(report, false));

    const item = criterion('separa_fato_de_hipotese', result);
    expect(item.passed).toBe(false);
    expect(item.details).toContain('sem hipótese');
  });

  it('falha quando o texto não traz as seções do relatório', () => {
    const report = makeReport();
    const result = scorer.score(makeCase(), report, 'texto qualquer sem as seções esperadas');

    expect(criterion('separa_fato_de_hipotese', result).passed).toBe(false);
  });
});

// Teste 57
describe('proximos_passos_seguros', () => {
  it('falha com lista vazia', () => {
    const report = makeReport({ safeNextSteps: [] });
    const result = scorer.score(makeCase(), report, renderReport(report, false));

    const item = criterion('proximos_passos_seguros', result);
    expect(item.passed).toBe(false);
    expect(item.details).toContain('vazia');
  });

  it('falha quando o 1º item é destrutivo', () => {
    const report = makeReport({
      safeNextSteps: ['Executar rollback imediato da versão.', 'Coletar métricas adicionais.'],
    });
    const result = scorer.score(makeCase(), report, renderReport(report, false));

    const item = criterion('proximos_passos_seguros', result);
    expect(item.passed).toBe(false);
    expect(item.details).toContain('destrutivo');
  });

  it('passa com 1º passo de leitura, mesmo com rollback sugerido depois', () => {
    const report = makeReport();
    const result = scorer.score(makeCase(), report, renderReport(report, false));

    expect(criterion('proximos_passos_seguros', result).passed).toBe(true);
  });
});

// Teste 58
describe('score e passed', () => {
  it('score = aprovados/total com 2 casas; passed só com 100%', () => {
    const report = makeReport();
    const rendered = renderReport(report, false);
    // 7 critérios: 3 findings (1 falha: "inexistente") + 1 proibido + 3 estruturais
    const result = scorer.score(
      makeCase({
        expected_findings: ['DatabaseTimeoutException', 'POST /checkout', 'inexistente-xyz'],
        must_not_include: ['drop table'],
      }),
      report,
      rendered,
    );

    expect(result.criteria).toHaveLength(7);
    expect(result.score).toBe(0.86); // 6/7 = 0.857… → 0.86
    expect(result.passed).toBe(false);
  });

  it('passed = true quando todos os critérios passam (score 1.0)', () => {
    const report = makeReport();
    const result = scorer.score(
      makeCase({ expected_findings: ['DatabaseTimeoutException'], must_not_include: ['drop table'] }),
      report,
      renderReport(report, false),
    );

    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });
});

// Teste 59
describe('determinismo (RF26)', () => {
  it('scorer é puro: mesmo input → mesmo resultado', () => {
    const report = makeReport();
    const rendered = renderReport(report, false);
    const evalCase = makeCase({
      expected_findings: ['DatabaseTimeoutException', 'p99-inexistente'],
      must_not_include: ['certeza absoluta'],
    });

    const first = scorer.score(evalCase, report, rendered);
    const second = scorer.score(evalCase, report, rendered);

    expect(second).toEqual(first);
  });
});
