import { describe, expect, it } from 'vitest';
import type { InvestigationContext, LatencySummary, RecentLogsResult, RunbookResult } from '@agentops/types';
import type { InvestigationFindings } from './findings.js';
import { buildReport, ensureSafeNextSteps, isDestructiveStep } from './report.js';

/**
 * Bordas da montagem do relatório: variações de evidência com dados parciais,
 * validador de próximos passos (RF17) e extração da orientação do runbook.
 */

const CONTEXT: InvestigationContext = {
  question: 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08',
  service: 'checkout-api',
  window: { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' },
  symptom: 'erro 5xx',
};

const NO_HYPOTHESES = { primary: null, alternatives: [] };

function emptyFindings(): InvestigationFindings {
  return {
    errorSummary: null,
    topExceptions: null,
    recentLogs: null,
    latencyWindow: null,
    latencyBaseline: null,
    deployments: null,
    runbookSearch: null,
    runbook: null,
    adrSearch: null,
    techSpecSearch: null,
  };
}

function findingsWithLogs(logs: RecentLogsResult['logs']): InvestigationFindings {
  return {
    ...emptyFindings(),
    recentLogs: {
      service: CONTEXT.service,
      window: CONTEXT.window,
      hasData: true,
      logs,
      totalMatched: logs.length,
      truncated: false,
    },
  };
}

describe('isDestructiveStep', () => {
  it('detecta termos destrutivos sem depender de caixa ou acentos', () => {
    expect(isDestructiveStep('REINICIAR o serviço imediatamente')).toBe(true);
    expect(isDestructiveStep('Executar rollback da versão')).toBe(true);
    expect(isDestructiveStep('Coletar logs adicionais da janela')).toBe(false);
  });
});

describe('ensureSafeNextSteps', () => {
  it('reordena passos destrutivos para o fim, preservando a ordem relativa', () => {
    const steps = ensureSafeNextSteps([
      'Executar rollback da versão.',
      'Coletar métricas da janela.',
      'Reiniciar o pod afetado.',
      'Comparar o diff do deploy.',
    ]);

    expect(steps).toEqual([
      'Coletar métricas da janela.',
      'Comparar o diff do deploy.',
      'Executar rollback da versão.',
      'Reiniciar o pod afetado.',
    ]);
  });

  it('lista só com passos destrutivos ganha um 1º passo de leitura', () => {
    const steps = ensureSafeNextSteps(['Executar rollback da versão.']);

    expect(steps[0]).toBe('Coletar mais dados (somente leitura) antes de qualquer ação de mudança.');
    expect(steps[1]).toBe('Executar rollback da versão.');
  });
});

describe('buildReport — dados parciais', () => {
  it('telemetria presente mas sem fatos resumíveis usa abertura genérica', () => {
    const report = buildReport(CONTEXT, findingsWithLogs([]), NO_HYPOTHESES, [], []);

    expect(report.summary).toContain('foi investigado na janela consultada');
    expect(report.summary).toContain('Nenhuma hipótese pôde ser formulada');
    expect(report.evidences).toEqual([]);
  });

  it('p99 sem baseline vira evidência apenas da janela', () => {
    const latencyWindow: LatencySummary = {
      service: CONTEXT.service,
      window: CONTEXT.window,
      hasData: true,
      unit: 'ms',
      overall: { p50: 200, p95: 900, p99: 3200 },
      requestCount: 400,
      series: [],
    };
    const report = buildReport(CONTEXT, { ...emptyFindings(), latencyWindow }, NO_HYPOTHESES, [], []);

    const p99Evidence = report.evidences.find((evidence) => evidence.source.tool === 'get_latency_summary');
    expect(p99Evidence?.statement).toBe('p99 de ~3200ms na janela do incidente.');
    expect(p99Evidence?.source.reference).toBe('overall.p99');
  });

  it('erros sem quebra por endpoint citam apenas count5xx', () => {
    const report = buildReport(
      CONTEXT,
      {
        ...emptyFindings(),
        errorSummary: {
          service: CONTEXT.service,
          window: CONTEXT.window,
          hasData: true,
          totalRequests: 100,
          count5xx: 10,
          count4xx: 0,
          errorRate5xx: 0.1,
          byEndpoint: [],
          timeline: [],
        },
      },
      NO_HYPOTHESES,
      [],
      [],
    );

    const evidence = report.evidences.find((item) => item.source.tool === 'get_error_summary');
    expect(evidence?.source.reference).toBe('count5xx');
    expect(evidence?.statement).not.toContain('concentradas em');
  });
});

describe('buildReport — orientação do runbook (firstVerificationStep)', () => {
  function withRunbook(content: string | null): InvestigationFindings {
    const runbook: RunbookResult = {
      found: true,
      name: 'checkout-api-high-5xx',
      title: 'Runbook: checkout-api — alta taxa de 5xx',
      content,
    };
    return { ...emptyFindings(), runbook };
  }

  function guidanceOf(findings: InvestigationFindings): string | undefined {
    const report = buildReport(CONTEXT, findings, NO_HYPOTHESES, [], []);
    return report.evidences.find((evidence) => evidence.statement.startsWith('O runbook orienta'))?.statement;
  }

  it('extrai o trecho em negrito do 1º passo de verificação', () => {
    const content = '# Runbook\n\n## Passos de verificação\n1. **Verificar o connection pool**: detalhes longos.\n';
    expect(guidanceOf(withRunbook(content))).toContain('"Verificar o connection pool"');
  });

  it('sem negrito usa a linha inteira; acima de 160 chars trunca com reticências', () => {
    const longStep = `Verificar ${'o pool de conexões do banco de pagamentos '.repeat(5)}na janela`;
    const content = `# Runbook\n\n## Passos de verificação\n1. ${longStep}\n`;
    const guidance = guidanceOf(withRunbook(content));

    expect(guidance).toContain('Verificar o pool');
    expect(guidance).toContain('…');
  });

  it('sem seção "Passos de verificação" não fabrica orientação', () => {
    expect(guidanceOf(withRunbook('# Runbook\n\n## Sintomas\n- 5xx\n'))).toBeUndefined();
  });

  it('seção sem item numerado (próxima seção logo em seguida) não fabrica orientação', () => {
    expect(guidanceOf(withRunbook('# Runbook\n\n## Passos de verificação\n## Escalonamento\n- acionar on-call\n'))).toBeUndefined();
  });

  it('runbook sem conteúdo mantém só a evidência do título', () => {
    const report = buildReport(CONTEXT, withRunbook(null), NO_HYPOTHESES, [], []);

    expect(report.evidences).toHaveLength(1);
    expect(report.evidences[0]?.statement).toContain('Runbook relacionado encontrado');
  });
});
