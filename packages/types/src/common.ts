import { z } from 'zod';

/**
 * Códigos do envelope `ToolError` (erros de validação de entrada das tools).
 * Ausência de dados NÃO é erro — ver variantes `hasData: false` / `found: false`.
 */
export const TOOL_ERROR_CODES = ['INVALID_ARGUMENT', 'INVALID_TIME_RANGE', 'EMPTY_QUERY'] as const;

export const toolErrorCodeSchema = z.enum(TOOL_ERROR_CODES);
export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;

export const toolErrorSchema = z.object({
  code: toolErrorCodeSchema,
  message: z.string().min(1),
});
export type ToolError = z.infer<typeof toolErrorSchema>;

/** Mensagem de erro prefixada por código, formato usado em `content[0].text` com `isError: true`. */
export function formatToolError(code: ToolErrorCode, message: string): string {
  return `${code}: ${message}`;
}

/**
 * Resolve o código de erro a partir de um `ZodError`: issues com mensagem prefixada
 * (`INVALID_TIME_RANGE:` / `EMPTY_QUERY:`) têm prioridade; o restante é `INVALID_ARGUMENT`.
 */
export function resolveToolErrorCode(error: z.ZodError): ToolErrorCode {
  for (const issue of error.issues) {
    for (const code of TOOL_ERROR_CODES) {
      if (issue.message.startsWith(`${code}:`)) {
        return code;
      }
    }
  }
  return 'INVALID_ARGUMENT';
}

/** As 9 tools read-only expostas pelo agentops-server. */
export const TOOL_NAMES = [
  'get_error_summary',
  'get_top_exceptions',
  'get_recent_logs',
  'get_latency_summary',
  'get_deployment_events',
  'search_runbooks',
  'get_runbook',
  'search_adrs',
  'search_tech_specs',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Motores de investigação disponíveis (V2). `deterministic` é o default. */
export const ENGINE_KINDS = ['deterministic', 'llm'] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];
export const engineKindSchema = z.enum(ENGINE_KINDS);

/** Providers LLM suportados pela V2.4; o endpoint custom usa o dialeto OpenAI. */
export const llmProviderSchema = z.enum(['anthropic', 'openrouter', 'openai']);
export type LlmProvider = z.infer<typeof llmProviderSchema>;

/**
 * Definição de tool descoberta via `client.listTools()` do MCP (nome +
 * descrição + JSON Schema). Mapeada de forma passthrough para o formato de
 * tool da Messages API; `annotations.readOnlyHint === true` é verificado pelo
 * lado consumidor (reforço em runtime da garantia read-only — RF10).
 */
export interface McpToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

/** Timestamp ISO 8601 com offset explícito (ex.: `2026-07-08T10:00:00-03:00`). */
export const isoTimestampSchema = z.string().datetime({
  offset: true,
  message: formatToolError(
    'INVALID_ARGUMENT',
    'timestamp deve ser ISO 8601 com offset explícito (ex.: 2026-07-08T10:00:00-03:00)',
  ),
});
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

/** Janela de tempo semiaberta `[from, to)` — `from` inclusivo, `to` exclusivo. */
export const timeWindowSchema = z.object({
  from: isoTimestampSchema,
  to: isoTimestampSchema,
});
export type TimeWindow = z.infer<typeof timeWindowSchema>;

/** Janela máxima por chamada de tool (proteção de contexto/tokens). */
export const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Consulta base das tools de observabilidade (janela `[from, to)`). */
export interface TimeWindowQuery {
  service: string;
  from: string;
  to: string;
}

/** Refinamento compartilhado: `from < to` e janela ≤ 24h (`INVALID_TIME_RANGE`). */
export function timeWindowRefinement(data: { from: string; to: string }, ctx: z.RefinementCtx): void {
  const from = Date.parse(data.from);
  const to = Date.parse(data.to);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return; // timestamp malformado já foi rejeitado pelo isoTimestampSchema
  }
  if (from >= to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['from'],
      message: formatToolError('INVALID_TIME_RANGE', `'from' (${data.from}) deve ser anterior a 'to' (${data.to})`),
    });
    return;
  }
  if (to - from > MAX_WINDOW_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: formatToolError('INVALID_TIME_RANGE', 'janela máxima por chamada é de 24h'),
    });
  }
}

/** `limit` inteiro com mínimo 1, máximo e default fixados por tool. */
export function limitSchema(max: number, defaultValue: number) {
  return z
    .number()
    .int(formatToolError('INVALID_ARGUMENT', "'limit' deve ser um número inteiro"))
    .min(1, formatToolError('INVALID_ARGUMENT', "'limit' deve ser no mínimo 1"))
    .max(max, formatToolError('INVALID_ARGUMENT', `'limit' deve ser no máximo ${max}`))
    .default(defaultValue);
}
