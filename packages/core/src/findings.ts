import type {
  DeploymentEvent,
  DeploymentEventsResult,
  DocumentSearchResult,
  ErrorSummary,
  ExceptionAggregate,
  LatencySummary,
  RecentLogsResult,
  RunbookResult,
  TopExceptionsResult,
} from '@agentops/types';

/**
 * Tudo o que o engine coletou via tools nos passos 2–8 da skill. `null` indica
 * chamada que falhou (`isError`) ou passo não executado — nunca dado inventado.
 */
export interface InvestigationFindings {
  errorSummary: ErrorSummary | null;
  topExceptions: TopExceptionsResult | null;
  recentLogs: RecentLogsResult | null;
  latencyWindow: LatencySummary | null;
  latencyBaseline: LatencySummary | null;
  deployments: DeploymentEventsResult | null;
  runbookSearch: DocumentSearchResult | null;
  runbook: RunbookResult | null;
  adrSearch: DocumentSearchResult | null;
  techSpecSearch: DocumentSearchResult | null;
}

/** Salto de latência: p99 da janela ≥ 2× o p99 do baseline anterior (regra R1). */
export const LATENCY_JUMP_FACTOR = 2;

/** Mudança de tráfego: volume da janela ≥ 1,5× o baseline (alternativa da R2). */
export const TRAFFIC_JUMP_FACTOR = 1.5;

/**
 * Exception dominante: a mais frequente responde por ≥50% dos erros da janela
 * (denominador: `count5xx` quando disponível, senão o total de exceptions).
 */
export function dominantException(findings: InvestigationFindings): ExceptionAggregate | null {
  const exceptions = findings.topExceptions?.hasData === true ? findings.topExceptions.exceptions : [];
  const top = exceptions[0];
  if (top === undefined) {
    return null;
  }
  const count5xx = findings.errorSummary?.hasData === true ? findings.errorSummary.count5xx : 0;
  const totalExceptions = exceptions.reduce((sum, aggregate) => sum + aggregate.count, 0);
  const denominator = count5xx > 0 ? count5xx : totalExceptions;
  return denominator > 0 && top.count * 2 >= denominator ? top : null;
}

/** `true` quando o p99 da janela é ≥ 2× o baseline (ambos medidos por tool). */
export function hasLatencyJump(findings: InvestigationFindings): boolean {
  const windowP99 = findings.latencyWindow?.overall?.p99;
  const baselineP99 = findings.latencyBaseline?.overall?.p99;
  return (
    windowP99 !== undefined &&
    windowP99 !== null &&
    baselineP99 !== undefined &&
    baselineP99 !== null &&
    baselineP99 > 0 &&
    windowP99 >= LATENCY_JUMP_FACTOR * baselineP99
  );
}

/** Primeiro deploy na janela estendida (`[from−15min, to)`), se houver. */
export function firstDeploy(findings: InvestigationFindings): DeploymentEvent | null {
  if (findings.deployments?.hasData !== true) {
    return null;
  }
  return findings.deployments.events[0] ?? null;
}

/** `true` quando ao menos uma tool de telemetria devolveu dados (nega a R3). */
export function hasAnyTelemetry(findings: InvestigationFindings): boolean {
  return [
    findings.errorSummary,
    findings.topExceptions,
    findings.recentLogs,
    findings.latencyWindow,
    findings.latencyBaseline,
    findings.deployments,
  ].some((result) => result?.hasData === true);
}
