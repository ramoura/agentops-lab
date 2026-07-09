import type { InvestigationOutcome, InvestigationReport, MissingField, ToolCallRecord } from '@agentops/types';

/**
 * Renderização do relatório em texto puro PT-BR: as 7 seções do RF4 na ordem,
 * seguidas do registro de auditoria (RF7). A informação nunca depende de cor —
 * ANSI é reforço visual, desativado com `NO_COLOR` ou stdout não-TTY, e a
 * saída redirecionada para arquivo permanece completa e legível.
 */

/** Títulos das 7 seções do RF4, na ordem, + seção de auditoria (RF7). */
export const SECTION_TITLES = [
  'Resumo executivo',
  'Evidências encontradas',
  'Hipótese principal',
  'Hipóteses alternativas',
  'Próximos passos seguros',
  'Dados faltantes',
  'Confiança da análise',
  'Tools chamadas',
] as const;

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  cyan: '[36m',
} as const;

/**
 * Cores só quando o destino é um TTY e `NO_COLOR` não está definido
 * (convenção https://no-color.org — presença da variável desativa, qualquer valor).
 */
export function shouldUseColor(
  stream: { isTTY?: boolean | undefined },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env['NO_COLOR'] !== undefined) {
    return false;
  }
  return stream.isTTY === true;
}

/** Mensagem de uso (pergunta ausente ou `--engine` inválido → stderr + exit code 1). */
export function renderUsage(): string {
  return [
    'Uso: npm run investigate -- "<pergunta>"',
    '',
    'Opções:',
    '  --engine=deterministic|llm  Motor de investigação (default: deterministic; env AGENTOPS_ENGINE).',
    '                              O modo llm requer a variável ANTHROPIC_API_KEY.',
    '',
    'Exemplo:',
    '  npm run investigate -- "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08"',
    '',
  ].join('\n');
}

const FIELD_LABELS: Record<MissingField['field'], string> = {
  service: 'serviço',
  window: 'janela de tempo',
};

/**
 * Orientação para pergunta ambígua (RF3/US10): cita exatamente os campos que
 * o parser não extraiu, com os hints acionáveis — sem stack trace e sem
 * chamar nenhuma tool.
 */
export function renderMissingFields(missing: MissingField[], useColor: boolean): string {
  const c = colorizer(useColor);
  const lines: string[] = [
    c.title('Não consegui iniciar a investigação'),
    '',
    'A pergunta não trouxe todas as informações necessárias. Faltou:',
    '',
  ];
  for (const item of missing) {
    lines.push(`- ${c.bold(FIELD_LABELS[item.field])}: ${item.hint}`);
  }
  lines.push(
    '',
    'Reformule a pergunta incluindo os itens acima, ex.:',
    '  npm run investigate -- "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08"',
    '',
  );
  return lines.join('\n');
}

/** Relatório completo: 7 seções do RF4 na ordem + registro de auditoria. */
export function renderReport(report: InvestigationReport, useColor: boolean): string {
  const c = colorizer(useColor);
  const { context } = report;
  const sections: string[] = [];

  sections.push(
    `Investigação: ${context.service} — ${context.window.from} a ${context.window.to}` +
      (context.symptom !== null ? ` (sintoma: ${context.symptom})` : ''),
  );

  // 1. Resumo executivo
  sections.push(heading(c, SECTION_TITLES[0]), report.summary);

  // 2. Evidências encontradas (cada uma cita a tool que a sustenta — RF5)
  sections.push(heading(c, SECTION_TITLES[1]));
  if (report.evidences.length === 0) {
    sections.push('Nenhuma evidência encontrada — as tools não retornaram fatos para a janela consultada.');
  } else {
    sections.push(
      report.evidences
        .map(
          (evidence, index) =>
            `${index + 1}. ${evidence.statement}\n   ${c.dim(`Fonte: ${evidence.source.tool} (${evidence.source.reference})`)}`,
        )
        .join('\n'),
    );
  }

  // 3. Hipótese principal
  sections.push(heading(c, SECTION_TITLES[2]));
  if (report.primaryHypothesis === null) {
    sections.push('Nenhuma hipótese pôde ser formulada com as evidências disponíveis.');
  } else {
    sections.push(renderHypothesis(c, report.primaryHypothesis));
  }

  // 4. Hipóteses alternativas
  sections.push(heading(c, SECTION_TITLES[3]));
  if (report.alternativeHypotheses.length === 0) {
    sections.push('Nenhuma hipótese alternativa.');
  } else {
    sections.push(report.alternativeHypotheses.map((hypothesis) => renderHypothesis(c, hypothesis)).join('\n'));
  }

  // 5. Próximos passos seguros (o 1º nunca é destrutivo — RF17)
  sections.push(heading(c, SECTION_TITLES[4]));
  sections.push(report.safeNextSteps.map((step, index) => `${index + 1}. ${step}`).join('\n'));

  // 6. Dados faltantes (ausência declarada, nunca inventada — US9)
  sections.push(heading(c, SECTION_TITLES[5]));
  if (report.missingData.length === 0) {
    sections.push('Nenhum dado faltante identificado.');
  } else {
    sections.push(report.missingData.map((item) => `- ${item}`).join('\n'));
  }

  // 7. Confiança da análise
  sections.push(heading(c, SECTION_TITLES[6]), report.confidence);

  // Registro de auditoria (RF7)
  sections.push(renderAuditSection(report.audit, useColor));

  return `${sections.join('\n\n')}\n`;
}

/**
 * Seção "Tools chamadas" (RF7), compartilhada pelos dois motores: no modo
 * deterministic fecha o `renderReport`; no modo llm é anexada por código ao
 * markdown do modelo — a auditoria nunca depende da honestidade do modelo.
 */
export function renderAuditSection(records: ToolCallRecord[], useColor: boolean): string {
  const c = colorizer(useColor);
  const body =
    records.length === 0
      ? 'Nenhuma tool foi chamada.'
      : records.map((record) => renderAuditRecord(c, record)).join('\n');
  return `${heading(c, SECTION_TITLES[7])}\n\n${body}`;
}

/**
 * Despacho por variante do outcome (V2): `report` e `clarification` delegam
 * aos renderers da V1 (byte-idênticos); `markdown` imprime o texto do modelo
 * e anexa a seção "Tools chamadas" gerada do audit log (RF7).
 */
export function renderOutcome(outcome: InvestigationOutcome, useColor: boolean): string {
  switch (outcome.kind) {
    case 'report':
      return renderReport(outcome.report, useColor);
    case 'clarification':
      return renderMissingFields(outcome.missing, useColor);
    case 'markdown':
      return `${outcome.markdown.trim()}\n\n${renderAuditSection(outcome.audit, useColor)}\n`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Colorizer {
  title(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
}

function colorizer(useColor: boolean): Colorizer {
  if (!useColor) {
    return { title: (text) => text, bold: (text) => text, dim: (text) => text };
  }
  return {
    title: (text) => `${ANSI.bold}${ANSI.cyan}${text}${ANSI.reset}`,
    bold: (text) => `${ANSI.bold}${text}${ANSI.reset}`,
    dim: (text) => `${ANSI.dim}${text}${ANSI.reset}`,
  };
}

/** Título sublinhado com `-` — a estrutura fica visível mesmo sem cor. */
function heading(c: Colorizer, title: string): string {
  return `${c.title(title)}\n${'-'.repeat(title.length)}`;
}

function renderHypothesis(c: Colorizer, hypothesis: { statement: string; rationale: string; confidence: string }): string {
  return `${c.bold(`[confiança ${hypothesis.confidence}]`)} ${hypothesis.statement}\n   ${c.dim(`Justificativa: ${hypothesis.rationale}`)}`;
}

function renderAuditRecord(c: Colorizer, record: ToolCallRecord): string {
  const duration = `${Math.round(record.durationMs)}ms`;
  return `${record.seq}. ${c.bold(record.tool)} ${JSON.stringify(record.params)}\n   ${c.dim(`→ ${record.resultSummary} (${duration})`)}`;
}
