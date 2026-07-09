import type { Evidence, InvestigationContext, InvestigationReport, ToolCallRecord } from '@agentops/types';
import { dominantException, firstDeploy, hasAnyTelemetry } from './findings.js';
import type { InvestigationFindings } from './findings.js';
import type { HypothesesResult } from './rules/hypotheses.js';
import { hhmm } from './time.js';

/**
 * Montagem do `InvestigationReport` (passos 10–11 da skill): fatos são apenas
 * saídas de tools, sempre com citação (RF5/RF6); hipóteses ficam em seção
 * própria; o 1º próximo passo nunca é destrutivo (RF17). A ordem dos campos
 * segue as 7 seções do RF4.
 */
export function buildReport(
  context: InvestigationContext,
  findings: InvestigationFindings,
  hypotheses: HypothesesResult,
  missingData: string[],
  audit: ToolCallRecord[],
): InvestigationReport {
  return {
    context,
    summary: buildSummary(context, findings, hypotheses),
    evidences: buildEvidences(findings),
    primaryHypothesis: hypotheses.primary,
    alternativeHypotheses: hypotheses.alternatives,
    safeNextSteps: ensureSafeNextSteps(deriveSafeNextSteps(findings)),
    missingData,
    confidence: hypotheses.primary?.confidence ?? 'baixa',
    audit,
  };
}

// ---------------------------------------------------------------------------
// Resumo executivo
// ---------------------------------------------------------------------------

function buildSummary(
  context: InvestigationContext,
  findings: InvestigationFindings,
  hypotheses: HypothesesResult,
): string {
  if (!hasAnyTelemetry(findings)) {
    return `Não foram encontrados dados de telemetria para ${context.service} na janela consultada; sem evidências, nenhuma hipótese pôde ser formulada.`;
  }

  const facts: string[] = [];
  const errorSummary = findings.errorSummary;
  if (errorSummary?.hasData === true) {
    facts.push(`registrou ${errorSummary.count5xx} respostas 5xx em ${errorSummary.totalRequests} requisições`);
  }
  const dominant = dominantException(findings);
  if (dominant !== null) {
    facts.push(`exception dominante ${dominant.exception}`);
  }
  const deploy = firstDeploy(findings);
  if (deploy !== null) {
    facts.push(`deploy da versão ${deploy.version} às ${hhmm(deploy.timestamp)}`);
  }

  const opening =
    facts.length > 0
      ? `O serviço ${context.service} ${facts[0]} na janela consultada${facts
          .slice(1)
          .map((fact) => `; ${fact}`)
          .join('')}.`
      : `O serviço ${context.service} foi investigado na janela consultada.`;

  if (hypotheses.primary !== null) {
    return `${opening} Hipótese principal (confiança ${hypotheses.primary.confidence}): ${hypotheses.primary.statement}`;
  }
  return `${opening} Nenhuma hipótese pôde ser formulada com as evidências disponíveis.`;
}

// ---------------------------------------------------------------------------
// Evidências — apenas fatos vindos de tools, sempre com citação (RF5/RF6)
// ---------------------------------------------------------------------------

function buildEvidences(findings: InvestigationFindings): Evidence[] {
  const evidences: Evidence[] = [];

  const errorSummary = findings.errorSummary;
  if (errorSummary?.hasData === true) {
    const rate = (errorSummary.errorRate5xx * 100).toFixed(1).replace('.', ',');
    const topEndpoint = errorSummary.byEndpoint[0];
    evidences.push({
      statement: `${errorSummary.count5xx} respostas 5xx em ${errorSummary.totalRequests} requisições (${rate}%)${
        topEndpoint !== undefined ? `, concentradas em ${topEndpoint.endpoint}` : ''
      }.`,
      source: { tool: 'get_error_summary', reference: topEndpoint !== undefined ? 'count5xx/byEndpoint[0]' : 'count5xx' },
    });
  }

  const topException = findings.topExceptions?.hasData === true ? findings.topExceptions.exceptions[0] : undefined;
  if (topException !== undefined) {
    evidences.push({
      statement: `Exception mais frequente: ${topException.exception} (${topException.count} ocorrências${
        topException.endpoints.length > 0 ? ` em ${topException.endpoints.join(', ')}` : ''
      }).`,
      source: { tool: 'get_top_exceptions', reference: 'exceptions[0]' },
    });
  }

  const sampleLog = findings.recentLogs?.hasData === true ? findings.recentLogs.logs[0] : undefined;
  if (sampleLog !== undefined) {
    evidences.push({
      statement: `Log de erro recente: "${sampleLog.message}" (traceId ${sampleLog.traceId}).`,
      source: { tool: 'get_recent_logs', reference: `logs[0], traceId ${sampleLog.traceId}` },
    });
  }

  const windowP99 = findings.latencyWindow?.overall?.p99;
  const baselineP99 = findings.latencyBaseline?.overall?.p99;
  if (windowP99 !== undefined && windowP99 !== null && baselineP99 !== undefined && baselineP99 !== null) {
    evidences.push({
      statement: `p99 foi de ~${baselineP99}ms (baseline anterior) para ~${windowP99}ms na janela do incidente.`,
      source: { tool: 'get_latency_summary', reference: 'overall.p99 vs baseline' },
    });
  } else if (windowP99 !== undefined && windowP99 !== null) {
    evidences.push({
      statement: `p99 de ~${windowP99}ms na janela do incidente.`,
      source: { tool: 'get_latency_summary', reference: 'overall.p99' },
    });
  }

  const deploy = firstDeploy(findings);
  if (deploy !== null) {
    evidences.push({
      statement: `Deploy da versão ${deploy.version} às ${hhmm(deploy.timestamp)}${
        deploy.previousVersion !== null ? ` (anterior: ${deploy.previousVersion})` : ''
      }.`,
      source: { tool: 'get_deployment_events', reference: 'events[0]' },
    });
  }

  const runbook = findings.runbook;
  const runbookMatch = findings.runbookSearch?.matches[0];
  if (runbook?.found === true && runbook.title !== null) {
    const runbookReference = runbookMatch?.path ?? runbook.name ?? 'runbook';
    evidences.push({
      statement: `Runbook relacionado encontrado: "${runbook.title}".`,
      source: { tool: 'get_runbook', reference: runbookReference },
    });
    const guidance = runbook.content !== null ? firstVerificationStep(runbook.content) : null;
    if (guidance !== null) {
      evidences.push({
        statement: `O runbook orienta, como primeiro passo de verificação: "${guidance}".`,
        source: { tool: 'get_runbook', reference: `${runbookReference} — Passos de verificação` },
      });
    }
  }

  const adrMatch = findings.adrSearch?.matches[0];
  if (adrMatch !== undefined) {
    evidences.push({
      statement: `ADR relacionado: "${adrMatch.title}".`,
      source: { tool: 'search_adrs', reference: adrMatch.path },
    });
  }

  const techSpecMatch = findings.techSpecSearch?.matches[0];
  if (techSpecMatch !== undefined) {
    evidences.push({
      statement: `Tech spec relacionada: "${techSpecMatch.title}".`,
      source: { tool: 'search_tech_specs', reference: techSpecMatch.path },
    });
  }

  return evidences;
}

/**
 * Primeiro item numerado da seção "Passos de verificação" do runbook — a
 * orientação vira evidência citável (fato vindo de `get_runbook`, RF5/RF6).
 * Prefere o trecho em negrito (título do passo); sem negrito, usa a linha
 * inteira truncada. Retorna `null` quando a seção/item não existe.
 */
function firstVerificationStep(content: string): string | null {
  const lines = content.split('\n');
  const headingIndex = lines.findIndex((line) =>
    /^##\s+passos de verificacao/.test(
      line
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase(),
    ),
  );
  if (headingIndex === -1) {
    return null;
  }
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s/.test(line)) {
      break; // próxima seção — não há itens numerados nesta
    }
    const item = /^\s*1\.\s+(.+)$/.exec(line);
    if (item?.[1] !== undefined) {
      const bold = /\*\*(.+?)\*\*/.exec(item[1]);
      const text = (bold?.[1] ?? item[1]).replace(/\*\*/g, '').trim();
      return text.length > 160 ? `${text.slice(0, 157)}…` : text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Próximos passos seguros (RF17)
// ---------------------------------------------------------------------------

/**
 * Termos que caracterizam ação destrutiva/de mudança. Passos que os contêm
 * nunca podem abrir a lista — só aparecem depois, como avaliação com o time.
 */
const DESTRUCTIVE_TERMS = [
  'rollback',
  'reiniciar',
  'restart',
  'reboot',
  'apagar',
  'deletar',
  'delete',
  'excluir',
  'remover',
  'drop',
  'truncate',
  'kill',
  'desligar',
  'derrubar',
  'shutdown',
  'rm -rf',
];

/** `true` quando o passo menciona ação destrutiva (comparação sem acentos/caixa). */
export function isDestructiveStep(step: string): boolean {
  const normalized = step
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return DESTRUCTIVE_TERMS.some((term) => normalized.includes(term));
}

/**
 * Validador de `safeNextSteps`: reordena passos destrutivos para o fim da
 * lista (preservando a ordem relativa) e garante lista não vazia com um
 * primeiro passo sempre de leitura (RF17 / teste 44).
 */
export function ensureSafeNextSteps(steps: string[]): string[] {
  const safe = steps.filter((step) => !isDestructiveStep(step));
  const destructive = steps.filter((step) => isDestructiveStep(step));
  if (safe.length === 0) {
    safe.push('Coletar mais dados (somente leitura) antes de qualquer ação de mudança.');
  }
  return [...safe, ...destructive];
}

function deriveSafeNextSteps(findings: InvestigationFindings): string[] {
  const steps: string[] = [];

  const runbook = findings.runbook;
  if (runbook?.found === true && runbook.title !== null) {
    steps.push(`Seguir os passos de verificação (somente leitura) do runbook "${runbook.title}".`);
  }

  const deploy = firstDeploy(findings);
  if (deploy !== null) {
    steps.push(
      `Comparar a versão ${deploy.version} com a ${deploy.previousVersion ?? 'anterior'} (diff do deploy).`,
    );
    if (deploy.changeSummary !== null) {
      steps.push(`Revisar as mudanças descritas no deploy: ${deploy.changeSummary}.`);
    }
  }

  const dominant = dominantException(findings);
  if (dominant !== null) {
    steps.push(`Validar a saúde da dependência relacionada a ${dominant.exception} na janela do incidente.`);
  }

  if (!hasAnyTelemetry(findings)) {
    steps.push(
      'Confirmar o nome do serviço e ampliar a janela de investigação.',
      'Verificar se o serviço emite logs e métricas para o período informado.',
    );
  }

  steps.push('Coletar métricas e logs adicionais da janela (somente leitura) antes de qualquer ação de mudança.');

  if (deploy !== null) {
    steps.push('Avaliar rollback com o time responsável — não executar automaticamente.');
  }

  return steps;
}
