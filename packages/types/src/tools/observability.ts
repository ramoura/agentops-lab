import { z } from 'zod';
import {
  formatToolError,
  isoTimestampSchema,
  limitSchema,
  timeWindowRefinement,
  timeWindowSchema,
} from '../common.js';
import type { TimeWindowQuery } from '../common.js';
import { deploymentEventSchema, logEntrySchema, logLevelSchema } from '../datasets.js';
import type { LogLevel } from '../datasets.js';

/** Nome de serviço: 1–100 caracteres, não vazio (espaços nas bordas são ignorados). */
export const serviceSchema = z
  .string()
  .trim()
  .min(1, formatToolError('INVALID_ARGUMENT', "'service' não pode ser vazio"))
  .max(100, formatToolError('INVALID_ARGUMENT', "'service' deve ter no máximo 100 caracteres"));

/**
 * Shape base das tools de observabilidade. Os shapes são exportados separadamente dos
 * schemas porque o SDK MCP registra tools a partir do `ZodRawShape`; o refinement de
 * janela (`INVALID_TIME_RANGE`) é aplicado pelo schema completo correspondente.
 */
const timeWindowInputShape = {
  service: serviceSchema,
  from: isoTimestampSchema,
  to: isoTimestampSchema,
} as const;

// ---------------------------------------------------------------------------
// get_error_summary
// ---------------------------------------------------------------------------

export const getErrorSummaryInputShape = { ...timeWindowInputShape };
export const getErrorSummaryInputSchema = z.object(getErrorSummaryInputShape).superRefine(timeWindowRefinement);
export type GetErrorSummaryInput = z.infer<typeof getErrorSummaryInputSchema>;

const countSchema = z.number().int().min(0);

/** Base comum das saídas de observabilidade: eco do serviço/janela + flag de dados. */
const observabilityResultBase = {
  service: z.string().min(1),
  window: timeWindowSchema,
  hasData: z.boolean(),
} as const;

export const errorSummarySchema = z.object({
  ...observabilityResultBase,
  totalRequests: countSchema,
  count5xx: countSchema,
  count4xx: countSchema,
  errorRate5xx: z.number().min(0).max(1),
  byEndpoint: z.array(
    z.object({
      endpoint: z.string().min(1),
      count5xx: countSchema,
    }),
  ),
  timeline: z.array(
    z.object({
      bucketStart: isoTimestampSchema,
      count5xx: countSchema,
    }),
  ),
});
export type ErrorSummary = z.infer<typeof errorSummarySchema>;

// ---------------------------------------------------------------------------
// get_top_exceptions
// ---------------------------------------------------------------------------

export const getTopExceptionsInputShape = {
  ...timeWindowInputShape,
  limit: limitSchema(20, 5),
} as const;
export const getTopExceptionsInputSchema = z.object(getTopExceptionsInputShape).superRefine(timeWindowRefinement);
export type GetTopExceptionsInput = z.infer<typeof getTopExceptionsInputSchema>;

export const exceptionAggregateSchema = z.object({
  exception: z.string().min(1),
  count: countSchema,
  sampleMessage: z.string(),
  endpoints: z.array(z.string().min(1)),
});
export type ExceptionAggregate = z.infer<typeof exceptionAggregateSchema>;

export const topExceptionsResultSchema = z.object({
  ...observabilityResultBase,
  exceptions: z.array(exceptionAggregateSchema),
});
export type TopExceptionsResult = z.infer<typeof topExceptionsResultSchema>;

// ---------------------------------------------------------------------------
// get_recent_logs
// ---------------------------------------------------------------------------

export const getRecentLogsInputShape = {
  ...timeWindowInputShape,
  level: logLevelSchema.optional(),
  limit: limitSchema(200, 50),
} as const;
export const getRecentLogsInputSchema = z.object(getRecentLogsInputShape).superRefine(timeWindowRefinement);
export type GetRecentLogsInput = z.infer<typeof getRecentLogsInputSchema>;

export const recentLogsResultSchema = z.object({
  ...observabilityResultBase,
  logs: z.array(logEntrySchema),
  totalMatched: countSchema,
  truncated: z.boolean(),
});
export type RecentLogsResult = z.infer<typeof recentLogsResultSchema>;

// ---------------------------------------------------------------------------
// get_latency_summary
// ---------------------------------------------------------------------------

export const getLatencySummaryInputShape = { ...timeWindowInputShape };
export const getLatencySummaryInputSchema = z.object(getLatencySummaryInputShape).superRefine(timeWindowRefinement);
export type GetLatencySummaryInput = z.infer<typeof getLatencySummaryInputSchema>;

export const latencySummarySchema = z.object({
  ...observabilityResultBase,
  unit: z.literal('ms'),
  overall: z
    .object({
      p50: z.number().min(0),
      p95: z.number().min(0),
      p99: z.number().min(0),
    })
    .nullable(),
  requestCount: countSchema,
  series: z.array(
    z.object({
      bucketStart: isoTimestampSchema,
      p99: z.number().min(0),
      requestCount: countSchema,
    }),
  ),
});
export type LatencySummary = z.infer<typeof latencySummarySchema>;

// ---------------------------------------------------------------------------
// get_deployment_events
// ---------------------------------------------------------------------------

export const getDeploymentEventsInputShape = { ...timeWindowInputShape };
export const getDeploymentEventsInputSchema = z
  .object(getDeploymentEventsInputShape)
  .superRefine(timeWindowRefinement);
export type GetDeploymentEventsInput = z.infer<typeof getDeploymentEventsInputSchema>;

export const deploymentEventsResultSchema = z.object({
  ...observabilityResultBase,
  events: z.array(deploymentEventSchema),
});
export type DeploymentEventsResult = z.infer<typeof deploymentEventsResultSchema>;

// ---------------------------------------------------------------------------
// Provider (fake na v1; CloudWatch/Splunk/Prometheus na V3 — RF11)
// ---------------------------------------------------------------------------

export interface ObservabilityProvider {
  getErrorSummary(q: TimeWindowQuery): Promise<ErrorSummary>;
  getTopExceptions(q: TimeWindowQuery & { limit?: number }): Promise<TopExceptionsResult>;
  getRecentLogs(q: TimeWindowQuery & { level?: LogLevel; limit?: number }): Promise<RecentLogsResult>;
  getLatencySummary(q: TimeWindowQuery): Promise<LatencySummary>;
  getDeploymentEvents(q: TimeWindowQuery): Promise<DeploymentEventsResult>;
}
