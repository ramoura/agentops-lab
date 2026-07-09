import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  deploymentEventsResultSchema,
  errorSummarySchema,
  getDeploymentEventsInputSchema,
  getErrorSummaryInputSchema,
  getLatencySummaryInputSchema,
  getRecentLogsInputSchema,
  getTopExceptionsInputSchema,
  latencySummarySchema,
  logLevelSchema,
  recentLogsResultSchema,
  topExceptionsResultSchema,
} from '@agentops/types';
import type { ObservabilityProvider } from '@agentops/types';
import { withValidation } from '../tool-result.js';

/** Anotações comuns: todas as tools são read-only e determinísticas (RF10/RF9). */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Shape de descoberta compartilhado (janela de tempo). Tipos base + descrições
 * orientadas ao agente; a validação estrita (ISO 8601 com offset, from < to,
 * janela ≤ 24h) acontece no handler via schema completo de `@agentops/types`.
 */
function timeWindowShape() {
  return {
    service: z.string().describe('Nome do serviço investigado (ex.: "checkout-api").'),
    from: z
      .string()
      .describe(
        'Início da janela [from, to), inclusivo — ISO 8601 com offset explícito (ex.: "2026-07-08T10:00:00-03:00"). Janela máxima: 24h.',
      ),
    to: z
      .string()
      .describe('Fim da janela, exclusivo — ISO 8601 com offset explícito. Deve ser posterior a "from".'),
  };
}

/**
 * Registra as 5 tools de observabilidade (logs, métricas, deploys) delegando
 * ao provider — a tool nunca lê arquivo diretamente (RF11). Ausência de dados
 * retorna `hasData: false`, nunca erro (RF14).
 */
export function registerObservabilityTools(server: McpServer, provider: ObservabilityProvider): void {
  server.registerTool(
    'get_error_summary',
    {
      title: 'Resumo de erros HTTP',
      description:
        'Resume os erros HTTP de um serviço na janela de tempo: total de requisições, contagens 4xx/5xx, ' +
        'taxa de 5xx, quebra de 5xx por endpoint (decrescente) e timeline em buckets de 5 minutos para ' +
        'localizar o início do pico. Use como primeira leitura de qualquer investigação, para dimensionar ' +
        'o problema antes de buscar exceptions ou logs. Serviço/janela sem dados retorna hasData: false ' +
        'com contadores zerados — não é erro.',
      inputSchema: timeWindowShape(),
      outputSchema: errorSummarySchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withValidation('get_error_summary', getErrorSummaryInputSchema, (input) => provider.getErrorSummary(input)),
  );

  server.registerTool(
    'get_top_exceptions',
    {
      title: 'Ranking de exceptions',
      description:
        'Ranqueia as exceptions de um serviço na janela de tempo, por contagem decrescente, com mensagem ' +
        'de exemplo e endpoints afetados. Use depois do resumo de erros para identificar a exception ' +
        'dominante — insumo central para formular hipóteses. Janela sem dados retorna hasData: false e ' +
        'lista vazia — não é erro.',
      inputSchema: {
        ...timeWindowShape(),
        limit: z.number().optional().describe('Máximo de exceptions no ranking (1–20; default 5).'),
      },
      outputSchema: topExceptionsResultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withValidation('get_top_exceptions', getTopExceptionsInputSchema, (input) => provider.getTopExceptions(input)),
  );

  server.registerTool(
    'get_recent_logs',
    {
      title: 'Logs recentes',
      description:
        'Retorna uma amostra dos logs de um serviço na janela de tempo, ordenados do mais recente para o ' +
        'mais antigo, com filtro opcional por nível. Use para citar evidência concreta (mensagem, traceId, ' +
        'statusCode) após identificar o padrão de erro. Nunca devolve o dataset inteiro: totalMatched e ' +
        'truncated informam quando o resultado é uma amostra. Janela sem dados retorna hasData: false — não é erro.',
      inputSchema: {
        ...timeWindowShape(),
        level: logLevelSchema.optional().describe('Filtra por nível de log (DEBUG | INFO | WARN | ERROR). Omitido = todos os níveis.'),
        limit: z.number().optional().describe('Máximo de logs retornados (1–200; default 50).'),
      },
      outputSchema: recentLogsResultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withValidation('get_recent_logs', getRecentLogsInputSchema, (input) => provider.getRecentLogs(input)),
  );

  server.registerTool(
    'get_latency_summary',
    {
      title: 'Resumo de latência',
      description:
        'Retorna os percentis de latência (p50/p95/p99, em ms) de um serviço na janela de tempo, com volume ' +
        'de requisições e série de p99 em buckets de 5 minutos para detectar saltos. Use para verificar ' +
        'degradação de latência; chame também com a janela imediatamente anterior (mesma duração) para obter ' +
        'um baseline comparável. Janela sem dados retorna hasData: false e overall: null — não é erro.',
      inputSchema: timeWindowShape(),
      outputSchema: latencySummarySchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withValidation('get_latency_summary', getLatencySummaryInputSchema, (input) => provider.getLatencySummary(input)),
  );

  server.registerTool(
    'get_deployment_events',
    {
      title: 'Eventos de deploy',
      description:
        'Lista os deploys de um serviço dentro da janela de tempo, em ordem cronológica, com versão nova, ' +
        'versão anterior e resumo da mudança. Use para correlacionar mudanças de versão com o início do ' +
        'sintoma — considere estender a janela alguns minutos para trás para capturar deploys imediatamente ' +
        'anteriores ao pico. Janela sem deploys retorna hasData: false e lista vazia — não é erro.',
      inputSchema: timeWindowShape(),
      outputSchema: deploymentEventsResultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withValidation('get_deployment_events', getDeploymentEventsInputSchema, (input) =>
      provider.getDeploymentEvents(input),
    ),
  );
}
