import type {
  DeploymentEventsResult,
  DocumentSearchResult,
  ErrorSummary,
  InvestigationContext,
  InvestigationEngine,
  InvestigationReport,
  LatencySummary,
  RecentLogsResult,
  RunbookResult,
  ToolInvoker,
  ToolName,
  TopExceptionsResult,
} from '@agentops/types';
import { InMemoryAuditLog } from './audit-log.js';
import { dominantException } from './findings.js';
import type { InvestigationFindings } from './findings.js';
import { buildReport } from './report.js';
import { formulateHypotheses } from './rules/hypotheses.js';
import { shiftIso } from './time.js';

/** Janela de deploy estendida: 15 min antes do início do incidente (passo 6). */
export const DEPLOY_LOOKBACK_MS = 15 * 60 * 1000;

/**
 * Engine determinístico da v1: espelha os 11 passos da skill
 * `investigate-incident` (RF16). Passos 2–8 são chamadas de tool auditadas
 * pelo `InMemoryAuditLog` (decorator estrutural — RF7); 1 e 9–11 são locais.
 * Todo fato do relatório nasce de uma chamada de tool (RF6); tool com
 * `isError` é degradada para `missingData` sem abortar a investigação (RF14).
 */
export class DeterministicInvestigationEngine implements InvestigationEngine {
  async investigate(context: InvestigationContext, tools: ToolInvoker): Promise<InvestigationReport> {
    const auditLog = new InMemoryAuditLog();
    const invoker = auditLog.wrap(tools);
    const failures: string[] = [];

    const call = async <TOut>(tool: ToolName, params: Record<string, unknown>): Promise<TOut | null> => {
      try {
        return await invoker.invoke<Record<string, unknown>, TOut>(tool, params);
      } catch (error) {
        failures.push(`${tool} falhou: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };

    const { service, window, symptom } = context;
    const windowParams = { service, from: window.from, to: window.to };

    // Passo 2 — resumo de erros
    const errorSummary = await call<ErrorSummary>('get_error_summary', windowParams);

    // Passo 3 — top exceptions
    const topExceptions = await call<TopExceptionsResult>('get_top_exceptions', windowParams);

    // Passo 4 — logs recentes (nível ERROR)
    const recentLogs = await call<RecentLogsResult>('get_recent_logs', {
      ...windowParams,
      level: 'ERROR',
      limit: 50,
    });

    // Passo 5 — latência da janela + baseline imediatamente anterior de mesma
    // duração (segunda chamada explícita: a comparação fica visível no audit).
    const latencyWindow = await call<LatencySummary>('get_latency_summary', windowParams);
    const durationMs = Date.parse(window.to) - Date.parse(window.from);
    const latencyBaseline = await call<LatencySummary>('get_latency_summary', {
      service,
      from: shiftIso(window.from, -durationMs),
      to: window.from,
    });

    // Passo 6 — deploys, com janela estendida 15 min para trás
    const deployments = await call<DeploymentEventsResult>('get_deployment_events', {
      service,
      from: shiftIso(window.from, -DEPLOY_LOOKBACK_MS),
      to: window.to,
    });

    // Passo 7 — runbook relacionado (busca por serviço + sintoma; depois o top 1)
    const runbookQuery = [service, symptom].filter((part) => part !== null && part !== '').join(' ');
    const runbookSearch = await call<DocumentSearchResult>('search_runbooks', { query: runbookQuery });
    const topRunbookMatch = runbookSearch?.matches[0];
    const runbook =
      topRunbookMatch !== undefined ? await call<RunbookResult>('get_runbook', { name: topRunbookMatch.name }) : null;

    // Passo 8 — ADRs/tech specs, só quando existe exception dominante
    let adrSearch: DocumentSearchResult | null = null;
    let techSpecSearch: DocumentSearchResult | null = null;
    const partialFindings: InvestigationFindings = {
      errorSummary,
      topExceptions,
      recentLogs,
      latencyWindow,
      latencyBaseline,
      deployments,
      runbookSearch,
      runbook,
      adrSearch,
      techSpecSearch,
    };
    const dominant = dominantException(partialFindings);
    if (dominant !== null) {
      const terms = exceptionSearchTerms(dominant.exception);
      adrSearch = await call<DocumentSearchResult>('search_adrs', { query: terms });
      techSpecSearch = await call<DocumentSearchResult>('search_tech_specs', { query: terms });
    }

    const findings: InvestigationFindings = { ...partialFindings, adrSearch, techSpecSearch };

    // Passos 9–11 — hipóteses, separação fato/suposição e passos seguros
    const hypotheses = formulateHypotheses(findings);
    const missingData = collectMissingData(context, findings, failures, runbookQuery);
    return buildReport(context, findings, hypotheses, missingData, auditLog.records);
  }
}

/**
 * Termos de busca derivados da exception dominante:
 * `DatabaseTimeoutException` → `database timeout`.
 */
export function exceptionSearchTerms(exception: string): string {
  const words = exception
    .replace(/Exception$/i, '')
    .split(/(?=[A-Z])|[^a-zA-Z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  return words.length > 0 ? words.join(' ') : exception.toLowerCase();
}

/**
 * Dados faltantes (US9): ausência declarada explicitamente, incluindo tools
 * que falharam (`isError`) e buscas sem correspondência — nunca inventar.
 */
function collectMissingData(
  context: InvestigationContext,
  findings: InvestigationFindings,
  failures: string[],
  runbookQuery: string,
): string[] {
  const missing: string[] = [...failures];
  const { service } = context;

  if (findings.errorSummary?.hasData === false) {
    missing.push(`Sem registros de requisições/erros para ${service} na janela consultada.`);
  }
  if (findings.topExceptions?.hasData === false) {
    missing.push(`Sem exceptions registradas para ${service} na janela consultada.`);
  }
  if (findings.recentLogs?.hasData === false) {
    missing.push(`Sem logs para ${service} na janela consultada.`);
  }
  if (findings.latencyWindow?.hasData === false) {
    missing.push(`Sem métricas de latência para ${service} na janela do incidente.`);
  }
  if (findings.latencyBaseline?.hasData === false) {
    missing.push(`Sem métricas de latência para ${service} na janela de baseline (anterior ao incidente).`);
  }
  if (findings.deployments?.hasData === false) {
    missing.push(`Nenhum evento de deploy de ${service} na janela estendida (15 min antes do início).`);
  }
  if (findings.runbookSearch !== null && findings.runbookSearch.matches.length === 0) {
    missing.push(`Nenhum runbook encontrado para "${runbookQuery}".`);
  }
  if (findings.runbook !== null && findings.runbook.found === false) {
    missing.push('O runbook indicado pela busca não pôde ser recuperado.');
  }
  if (findings.adrSearch !== null && findings.adrSearch.matches.length === 0) {
    missing.push(`Nenhum ADR relacionado a "${findings.adrSearch.query}".`);
  }
  if (findings.techSpecSearch !== null && findings.techSpecSearch.matches.length === 0) {
    missing.push(`Nenhuma tech spec relacionada a "${findings.techSpecSearch.query}".`);
  }

  return missing;
}
