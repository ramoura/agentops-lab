import { describe, expect, it } from 'vitest';
import type { InvestigationReport, MissingField } from '@agentops/types';
import { renderMissingFields, renderReport, renderUsage, SECTION_TITLES, shouldUseColor } from './renderer.js';

const ANSI_RE = /\[[0-9;]*m/g;

const sampleReport: InvestigationReport = {
  context: {
    question: 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08',
    service: 'checkout-api',
    window: { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' },
    symptom: 'erro 5xx',
  },
  summary:
    'O serviço checkout-api registrou 87 respostas 5xx em 412 requisições na janela consultada; deploy da versão 2026.07.08-1 às 10:03.',
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
    rationale: 'Correlação temporal deploy → pico de 5xx + exception de timeout de banco + salto de p99.',
    confidence: 'alta',
  },
  alternativeHypotheses: [
    {
      statement: 'Degradação do próprio banco de pagamentos, independente do deploy.',
      rationale: 'Timeouts de banco também ocorrem sem mudança de código.',
      confidence: 'baixa',
    },
  ],
  safeNextSteps: [
    'Comparar a versão 2026.07.08-1 com a 2026.07.07-3 (diff do deploy).',
    'Avaliar rollback com o time responsável — não executar automaticamente.',
  ],
  missingData: ['Métricas internas do banco de pagamentos.'],
  confidence: 'alta',
  audit: [
    {
      seq: 1,
      tool: 'get_error_summary',
      params: { service: 'checkout-api', from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' },
      resultSummary: '412 req, 87x 5xx',
      durationMs: 12.4,
    },
    {
      seq: 2,
      tool: 'get_top_exceptions',
      params: { service: 'checkout-api', from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' },
      resultSummary: '2 exception(s); top: DatabaseTimeoutException',
      durationMs: 3.1,
    },
  ],
};

// Teste 48
describe('renderReport — seções', () => {
  it('renderiza as 7 seções do RF4 em português, na ordem, + auditoria ao final', () => {
    const output = renderReport(sampleReport, false);

    // Cabeçalho sublinhado — inequívoco mesmo quando o título aparece no corpo do texto
    const positions = SECTION_TITLES.map((title) => output.indexOf(`${title}\n${'-'.repeat(title.length)}`));
    for (const [index, position] of positions.entries()) {
      expect(position, `seção "${SECTION_TITLES[index]}" ausente`).toBeGreaterThanOrEqual(0);
      if (index > 0) {
        expect(position, `seção "${SECTION_TITLES[index]}" fora de ordem`).toBeGreaterThan(
          positions[index - 1] as number,
        );
      }
    }

    // Conteúdo essencial de cada seção
    expect(output).toContain(sampleReport.summary);
    expect(output).toContain('Fonte: get_error_summary (count5xx/byEndpoint[0])');
    expect(output).toContain('[confiança alta] Regressão introduzida no deploy das 10h03');
    expect(output).toContain('Degradação do próprio banco de pagamentos');
    expect(output).toContain('1. Comparar a versão 2026.07.08-1');
    expect(output).toContain('- Métricas internas do banco de pagamentos.');
    expect(output).toContain('2. get_top_exceptions');
    expect(output).toContain('→ 412 req, 87x 5xx (12ms)');
  });
});

// Teste 49
describe('renderReport — acessibilidade (cores como reforço)', () => {
  it('sem cor a saída não contém ANSI; conteúdo idêntico ao colorido', () => {
    const plain = renderReport(sampleReport, false);
    const colored = renderReport(sampleReport, true);

    expect(plain).not.toMatch(ANSI_RE);
    expect(colored).toMatch(ANSI_RE);
    expect(colored.replace(ANSI_RE, '')).toBe(plain);
  });

  it('shouldUseColor: NO_COLOR definido ou stdout não-TTY desativam ANSI', () => {
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
    expect(shouldUseColor({ isTTY: undefined }, {})).toBe(false);
  });
});

// Teste 50
describe('renderMissingFields — pergunta ambígua (RF3/US10)', () => {
  it('cita exatamente os campos faltantes com os hints, sem stack trace', () => {
    const missing: MissingField[] = [
      { field: 'service', hint: 'não identifiquei o serviço; mencione o nome do serviço na pergunta, ex.: `checkout-api`' },
      { field: 'window', hint: 'informe a data e o horário, ex.: "entre 10h e 10h30 em 2026-07-08"' },
    ];

    const output = renderMissingFields(missing, false);

    expect(output).toContain('serviço: não identifiquei o serviço');
    expect(output).toContain('janela de tempo: informe a data e o horário');
    expect(output).toContain('Reformule a pergunta');
    expect(output).not.toMatch(/\n\s+at /); // nenhum frame de stack trace
    expect(output).not.toContain('Error:');
  });

  it('lista apenas o campo que de fato faltou', () => {
    const output = renderMissingFields([{ field: 'window', hint: 'informe o horário da janela' }], false);

    expect(output).toContain('janela de tempo');
    expect(output).not.toContain('- serviço:');
  });
});

// Teste 51
describe('saída redirecionada para arquivo', () => {
  it('sem cor não há sequências ANSI nem controle de cursor; conteúdo completo', () => {
    const output = renderReport(sampleReport, false);

    expect(output).not.toContain(''); // nenhum escape (cores ou cursor)
    expect(output).not.toContain('\r');
    expect(output.endsWith('\n')).toBe(true);
    // Do cabeçalho à última linha de auditoria, tudo presente
    expect(output).toContain('Investigação: checkout-api — 2026-07-08T10:00:00-03:00 a 2026-07-08T10:30:00-03:00');
    expect(output).toContain('→ 2 exception(s); top: DatabaseTimeoutException (3ms)');
  });

  it('renderUsage orienta o formato do comando', () => {
    expect(renderUsage()).toContain('Uso: npm run investigate -- "<pergunta>"');
  });
});
