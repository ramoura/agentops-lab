import type { AuditLog, ToolCallRecord, ToolInvoker, ToolName } from '@agentops/types';

/**
 * Decorator de `ToolInvoker` que materializa o registro de auditoria (RF7):
 * um `ToolCallRecord` por chamada, com `seq` incremental, params ecoados
 * exatamente como enviados, resumo curto do resultado e duração. Falhas também
 * são registradas (resumo `ERRO: …`) e re-lançadas para o chamador decidir.
 */
export class InMemoryAuditLog implements AuditLog {
  readonly records: ToolCallRecord[] = [];

  wrap(inner: ToolInvoker): ToolInvoker {
    const records = this.records;
    return {
      async invoke<TIn, TOut>(tool: ToolName, params: TIn): Promise<TOut> {
        const seq = records.length + 1;
        const echoedParams = structuredClone(params) as Record<string, unknown>;
        const startedAt = performance.now();
        try {
          const result = await inner.invoke<TIn, TOut>(tool, params);
          records.push({
            seq,
            tool,
            params: echoedParams,
            resultSummary: summarizeResult(tool, result),
            durationMs: performance.now() - startedAt,
          });
          return result;
        } catch (error) {
          records.push({
            seq,
            tool,
            params: echoedParams,
            resultSummary: `ERRO: ${error instanceof Error ? error.message : String(error)}`,
            durationMs: performance.now() - startedAt,
          });
          throw error;
        }
      },
    };
  }
}

/** Resumo curto do retorno (contagens, `hasData`) — nunca o payload inteiro (RF7). */
function summarizeResult(tool: ToolName, result: unknown): string {
  if (result === null || typeof result !== 'object') {
    return String(result);
  }
  const r = result as Record<string, unknown>;
  if (r['hasData'] === false) {
    return 'sem dados (hasData: false)';
  }
  switch (tool) {
    case 'get_error_summary':
      return `${String(r['totalRequests'])} req, ${String(r['count5xx'])}x 5xx`;
    case 'get_top_exceptions': {
      const exceptions = Array.isArray(r['exceptions']) ? (r['exceptions'] as Array<{ exception?: string }>) : [];
      const top = exceptions[0]?.exception ?? '—';
      return `${exceptions.length} exception(s); top: ${top}`;
    }
    case 'get_recent_logs': {
      const logs = Array.isArray(r['logs']) ? (r['logs'] as unknown[]) : [];
      return `${logs.length}/${String(r['totalMatched'])} logs (truncated: ${String(r['truncated'])})`;
    }
    case 'get_latency_summary': {
      const overall = r['overall'] as { p99?: number } | null;
      return overall ? `p99 ${String(overall.p99)}ms, ${String(r['requestCount'])} req` : 'overall: null';
    }
    case 'get_deployment_events': {
      const events = Array.isArray(r['events']) ? (r['events'] as unknown[]) : [];
      return `${events.length} deploy(s)`;
    }
    case 'search_runbooks':
    case 'search_adrs':
    case 'search_tech_specs': {
      const matches = Array.isArray(r['matches']) ? (r['matches'] as unknown[]) : [];
      return `${matches.length} match(es)`;
    }
    case 'get_runbook':
      return r['found'] === true ? `encontrado: ${String(r['name'])}` : 'não encontrado (found: false)';
    default:
      return JSON.stringify(Object.keys(r));
  }
}
