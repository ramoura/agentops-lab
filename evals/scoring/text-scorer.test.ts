import { describe, expect, it } from 'vitest';
import type { EvalCase } from '@agentops/types';
import { normalize } from './scorer.js';
import { extractSections, TextReportScorer } from './text-scorer.js';

/**
 * Unitários do caminho text-mode do scoring (testes 29–35 da techspec V2):
 * `extractSections` tolerante às duas formas de título e `TextReportScorer`
 * com os mesmos 5 grupos de critérios (e a mesma agregação) do scorer da V1.
 */

const scorer = new TextReportScorer();

const baseCase: EvalCase = {
  id: 'case-001-database-timeout',
  question: 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08',
  expected_findings: ['DatabaseTimeoutException', 'deploy'],
  must_not_include: ['certeza absoluta'],
};

/** Relatório markdown completo no contrato de formato (ATX), aprovado em tudo. */
const GOOD_MARKDOWN = [
  '## Resumo executivo',
  'O checkout-api apresentou pico de 5xx entre 10:00 e 10:30, correlacionado ao deploy 2026.07.08-1.',
  '',
  '## Evidências encontradas',
  '1. 214 erros 5xx concentrados em POST /checkout.',
  '   Fonte: get_error_summary (janela 2026-07-08T10:00/10:30)',
  '2. Exception dominante: DatabaseTimeoutException.',
  '   Fonte: get_top_exceptions (exceptions[0])',
  '',
  '## Hipótese principal',
  'Regressão introduzida pelo deploy das 10:03 (confiança alta).',
  '',
  '## Hipóteses alternativas',
  '- Degradação do banco, independente do deploy (confiança baixa).',
  '',
  '## Próximos passos seguros',
  '1. Comparar o diff do deploy 2026.07.08-1 com a versão anterior.',
  '2. Avaliar rollback com o time responsável — não executar automaticamente.',
  '',
  '## Dados faltantes',
  '- Métricas internas do banco de pagamentos.',
  '',
  '## Confiança da análise',
  'alta',
].join('\n');

// Teste 29
describe('extractSections', () => {
  it('reconhece títulos com sublinhado (formato do renderer)', () => {
    const markdown = ['Resumo executivo', '----------------', 'Texto do resumo.', '', 'Hipótese principal', '------------------', 'A hipótese.'].join('\n');

    const sections = extractSections(markdown);

    expect(sections.get(normalize('Resumo executivo'))).toBe('Texto do resumo.');
    expect(sections.get(normalize('Hipótese principal'))).toBe('A hipótese.');
  });

  it('reconhece títulos com prefixo markdown (## Título)', () => {
    const sections = extractSections(GOOD_MARKDOWN);

    expect(sections.get(normalize('Resumo executivo'))).toContain('pico de 5xx');
    expect(sections.get(normalize('Confiança da análise'))).toBe('alta');
  });

  it('normaliza acentos e caixa no matching de títulos', () => {
    const markdown = ['## HIPOTESE PRINCIPAL', 'Sem acento e em caixa alta.'].join('\n');

    expect(extractSections(markdown).get(normalize('Hipótese principal'))).toBe('Sem acento e em caixa alta.');
  });

  it('seção ausente → undefined', () => {
    expect(extractSections('## Resumo executivo\nTexto.').get(normalize('Dados faltantes'))).toBeUndefined();
  });

  it('conteúdo entre títulos é atribuído à seção correta', () => {
    const sections = extractSections(GOOD_MARKDOWN);

    expect(sections.get(normalize('Evidências encontradas'))).toContain('DatabaseTimeoutException');
    expect(sections.get(normalize('Evidências encontradas'))).not.toContain('Regressão introduzida');
    expect(sections.get(normalize('Hipótese principal'))).toContain('Regressão introduzida');
  });
});

// Teste 30
describe('findings e termos proibidos (paridade com o scorer da V1)', () => {
  it('matching case/acento-insensível sobre o texto completo', () => {
    const markdown = GOOD_MARKDOWN.replace('DatabaseTimeoutException', 'DATABASETIMEOUTEXCEPTION');
    const result = scorer.score(baseCase, markdown);

    const finding = result.criteria.find((criterion) => criterion.name === 'finding:DatabaseTimeoutException');
    expect(finding?.passed).toBe(true);
    expect(finding?.details).toBe('encontrado no relatório');
  });

  it('finding ausente e termo proibido presente falham com os detalhes da V1', () => {
    const markdown = `${GOOD_MARKDOWN}\n\nTemos certeza absoluta da causa.`;
    const result = scorer.score(
      { ...baseCase, expected_findings: ['connection pool'], must_not_include: ['certeza absoluta'] },
      markdown,
    );

    expect(result.criteria.find((criterion) => criterion.name === 'finding:connection pool')?.passed).toBe(false);
    const forbidden = result.criteria.find((criterion) => criterion.name === 'proibido:certeza absoluta');
    expect(forbidden?.passed).toBe(false);
    expect(forbidden?.details).toContain('presente no relatório');
  });
});

// Teste 31
describe('cita_evidencias (text-mode)', () => {
  const criterion = (markdown: string) =>
    scorer.score(baseCase, markdown).criteria.find((item) => item.name === 'cita_evidencias');

  it('todo item numerado com linha Fonte: → passa', () => {
    expect(criterion(GOOD_MARKDOWN)?.passed).toBe(true);
  });

  it('item sem Fonte: → falha com detalhe apontando o item', () => {
    const markdown = GOOD_MARKDOWN.replace('   Fonte: get_top_exceptions (exceptions[0])\n', '');
    const result = criterion(markdown);

    expect(result?.passed).toBe(false);
    expect(result?.details).toContain('sem linha "Fonte:"');
    expect(result?.details).toContain('DatabaseTimeoutException');
  });

  it('seção vazia + "Dados faltantes" preenchida → passa (paridade com US9)', () => {
    const markdown = [
      '## Resumo executivo',
      'Sem registros para o inventory-api na janela.',
      '',
      '## Evidências encontradas',
      '',
      '## Hipótese principal',
      'Nenhuma hipótese pôde ser formulada.',
      '',
      '## Próximos passos seguros',
      '1. Confirmar o nome do serviço e a janela consultada.',
      '',
      '## Dados faltantes',
      '- Sem registros de erro para o inventory-api na janela consultada.',
      '',
      '## Confiança da análise',
      'baixa',
    ].join('\n');

    expect(criterion(markdown)?.passed).toBe(true);
  });

  it('seção vazia sem dados faltantes declarados → falha', () => {
    const markdown = ['## Evidências encontradas', '', '## Hipótese principal', 'Alguma.', '', '## Dados faltantes', ''].join('\n');

    expect(criterion(markdown)?.passed).toBe(false);
  });
});

// Teste 32
describe('separa_fato_de_hipotese (text-mode)', () => {
  const criterion = (markdown: string) =>
    scorer.score(baseCase, markdown).criteria.find((item) => item.name === 'separa_fato_de_hipotese');

  it('"Evidências encontradas" e "Hipótese principal" presentes → passa', () => {
    expect(criterion(GOOD_MARKDOWN)?.passed).toBe(true);
  });

  it('ausência de qualquer uma → falha listando o problema', () => {
    const withoutHypothesis = GOOD_MARKDOWN.replace('## Hipótese principal', '## Hipotese central (título fora do contrato)');
    const result = criterion(withoutHypothesis);

    expect(result?.passed).toBe(false);
    expect(result?.details).toContain('"Hipótese principal" ausente');

    const withoutEvidence = GOOD_MARKDOWN.replace('## Evidências encontradas', '## Achados');
    expect(criterion(withoutEvidence)?.details).toContain('"Evidências encontradas" ausente');
  });
});

// Teste 33
describe('proximos_passos_seguros (text-mode)', () => {
  const criterion = (markdown: string) =>
    scorer.score(baseCase, markdown).criteria.find((item) => item.name === 'proximos_passos_seguros');

  it('lista vazia → falha', () => {
    const markdown = GOOD_MARKDOWN.replace(
      /## Próximos passos seguros[\s\S]*?## Dados faltantes/,
      '## Próximos passos seguros\n\n## Dados faltantes',
    );

    const result = criterion(markdown);
    expect(result?.passed).toBe(false);
    expect(result?.details).toBe('lista de próximos passos vazia');
  });

  it('1º item com termo destrutivo → falha', () => {
    const markdown = GOOD_MARKDOWN.replace(
      '1. Comparar o diff do deploy 2026.07.08-1 com a versão anterior.',
      '1. Fazer rollback imediato da versão 2026.07.08-1.',
    );

    const result = criterion(markdown);
    expect(result?.passed).toBe(false);
    expect(result?.details).toContain('1º passo é destrutivo');
  });

  it('destrutivo em posição ≥ 2 com ressalva → passa', () => {
    // GOOD_MARKDOWN já tem "Avaliar rollback com o time" como 2º passo
    expect(criterion(GOOD_MARKDOWN)?.passed).toBe(true);
  });
});

// Teste 34
describe('seção "Tools chamadas" gerada por código', () => {
  it('não interfere nos critérios (auditoria fora das seções avaliadas)', () => {
    const withAudit = [
      GOOD_MARKDOWN,
      '',
      'Tools chamadas',
      '--------------',
      '1. get_error_summary {"service":"checkout-api"}',
      '   → 214 erros, pico 10:05-10:20 (42ms)',
      '2. get_recent_logs {"service":"checkout-api"}',
      '   → logs com "kill -9" e "drop table usados como texto" (7ms)',
    ].join('\n');

    const withResult = scorer.score(baseCase, withAudit);
    const withoutResult = scorer.score(baseCase, GOOD_MARKDOWN);

    // Termo proibido dentro da auditoria não reprova o caso
    const audited = scorer.score({ ...baseCase, must_not_include: ['drop table'] }, withAudit);
    expect(audited.criteria.find((criterion) => criterion.name === 'proibido:drop table')?.passed).toBe(true);

    expect(withResult.criteria).toEqual(withoutResult.criteria);
    expect(withResult.score).toBe(withoutResult.score);
  });
});

// Teste 35
describe('score e passed (paridade de agregação com a V1)', () => {
  it('arredonda em 2 casas e só aprova com 100% dos critérios', () => {
    // 2 findings + 1 proibido + 3 estruturais = 6 critérios; 1 finding falha → 5/6
    const markdown = GOOD_MARKDOWN.replaceAll('DatabaseTimeoutException', 'TimeoutGenerico');
    const result = scorer.score(baseCase, markdown);

    expect(result.criteria).toHaveLength(6);
    expect(result.score).toBe(Math.round((5 / 6) * 100) / 100);
    expect(result.passed).toBe(false);

    const perfect = scorer.score(baseCase, GOOD_MARKDOWN);
    expect(perfect.score).toBe(1);
    expect(perfect.passed).toBe(true);
  });
});

// Testes 84–89 (V2.1 — tolerância de fraseado, matching any-of)
describe('findings com FindingSpec em array (V2.1 — matching any-of)', () => {
  // Teste 84
  it('variante não-primária presente no texto → passa; details cita a variante entre aspas', () => {
    const markdown = GOOD_MARKDOWN.replace('DatabaseTimeoutException', 'timeout de banco de dados');
    const result = scorer.score(
      { ...baseCase, expected_findings: [['DatabaseTimeoutException', 'timeout de banco de dados']] },
      markdown,
    );

    const finding = result.criteria.find((criterion) => criterion.name === 'finding:DatabaseTimeoutException');
    expect(finding?.passed).toBe(true);
    expect(finding?.details).toBe('encontrado no relatório via variante "timeout de banco de dados"');
  });

  // Teste 85
  it('nenhuma variante presente → falha; details cita o rótulo canônico e quantas variantes foram tentadas', () => {
    const result = scorer.score(
      { ...baseCase, expected_findings: [['ConnectionPoolExhaustedException', 'esgotamento do pool de conexões']] },
      GOOD_MARKDOWN,
    );

    const finding = result.criteria.find((criterion) => criterion.name === 'finding:ConnectionPoolExhaustedException');
    expect(finding?.passed).toBe(false);
    expect(finding?.details).toContain('ConnectionPoolExhaustedException');
    expect(finding?.details).toContain('2 variantes');
  });

  // Teste 86
  it('finding como string única (regressão): criteria/details byte-idênticos aos testes 29–35', () => {
    const markdown = GOOD_MARKDOWN.replace('DatabaseTimeoutException', 'DATABASETIMEOUTEXCEPTION');
    const result = scorer.score(baseCase, markdown);

    const finding = result.criteria.find((criterion) => criterion.name === 'finding:DatabaseTimeoutException');
    expect(finding?.passed).toBe(true);
    expect(finding?.details).toBe('encontrado no relatório');
  });

  // Teste 87
  it('criterion.name usa sempre a variante primária, independente de qual variante bateu', () => {
    const markdown = GOOD_MARKDOWN.replace('DatabaseTimeoutException', 'não há registros de erro');
    const result = scorer.score(
      { ...baseCase, expected_findings: [['Sem registros', 'não há registros de erro', 'nenhum registro']] },
      markdown,
    );

    expect(result.criteria.some((criterion) => criterion.name === 'finding:Sem registros')).toBe(true);
    expect(result.criteria.some((criterion) => criterion.name.startsWith('finding:não há registros'))).toBe(false);
  });

  // Teste 88
  it('must_not_include como array: qualquer variante presente reprova; nenhuma presente → aprova', () => {
    const withForbidden = GOOD_MARKDOWN.replace(
      'Regressão introduzida pelo deploy das 10:03 (confiança alta).',
      'Rollback executado automaticamente às 10:03.',
    );
    const failing = scorer.score(
      { ...baseCase, must_not_include: [['rollback automático', 'rollback executado automaticamente']] },
      withForbidden,
    );
    const forbidden = failing.criteria.find((criterion) => criterion.name === 'proibido:rollback automático');
    expect(forbidden?.passed).toBe(false);
    expect(forbidden?.details).toContain('rollback executado automaticamente');

    const passing = scorer.score(
      { ...baseCase, must_not_include: [['rollback automático', 'rollback executado automaticamente']] },
      GOOD_MARKDOWN,
    );
    expect(passing.criteria.find((criterion) => criterion.name === 'proibido:rollback automático')?.passed).toBe(true);
  });

  // Teste 89
  it('regressão do flake original (D11): "Não há registros de erro" bate o alias do case-003', () => {
    const markdown = [
      '## Resumo executivo',
      'Não há registros de erro para o inventory-api na janela consultada.',
      '',
      '## Evidências encontradas',
      '',
      '## Hipótese principal',
      'Nenhuma hipótese pôde ser formulada — sem dados de latência para o inventory-api na janela.',
      '',
      '## Próximos passos seguros',
      '1. Confirmar o nome do serviço e a janela consultada.',
      '',
      '## Dados faltantes',
      '- Não há registros de erro para o inventory-api na janela consultada.',
      '- Sem dados de latência para o inventory-api na janela.',
      '',
      '## Confiança da análise',
      'baixa',
    ].join('\n');

    const case003 = {
      id: 'case-003-missing-data',
      question: 'Investigue por que o inventory-api teve erro 5xx entre 10h e 10h30 em 2026-07-08',
      expected_findings: [
        'inventory-api',
        ['Sem registros', 'Não há registros', 'nenhum registro'],
        ['Sem métricas de latência', 'sem dados de latência', 'não há métricas de latência'],
        'baixa',
      ],
      must_not_include: ['DatabaseTimeoutException', 'PaymentGatewayTimeoutException', 'POST /checkout', 'deploy da versão'],
    };

    const result = scorer.score(case003, markdown);

    expect(result.criteria.find((criterion) => criterion.name === 'finding:Sem registros')?.passed).toBe(true);
    expect(result.criteria.find((criterion) => criterion.name === 'finding:Sem métricas de latência')?.passed).toBe(true);
  });
});
