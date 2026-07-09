import { z } from 'zod';
import { isoTimestampSchema } from './common.js';

export const logLevelSchema = z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']);
export type LogLevel = z.infer<typeof logLevelSchema>;

/**
 * Linha do dataset de logs (`datasets/logs/*.jsonl`).
 * Campos sem dado na fonte são normalizados para `null` — nunca omitidos nem inventados.
 */
export const logEntrySchema = z.object({
  timestamp: isoTimestampSchema,
  service: z.string().min(1),
  level: logLevelSchema,
  traceId: z.string().min(1),
  endpoint: z.string().nullable(),
  statusCode: z.number().int().nullable(),
  exception: z.string().nullable(),
  message: z.string(),
  latencyMs: z.number().nullable(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

/** Ponto do dataset de métricas (`datasets/metrics/latency.json`), granularidade de 1 minuto. */
export const metricPointSchema = z.object({
  timestamp: isoTimestampSchema,
  service: z.string().min(1),
  requestCount: z.number().int().min(0),
  p50Ms: z.number().min(0),
  p95Ms: z.number().min(0),
  p99Ms: z.number().min(0),
});
export type MetricPoint = z.infer<typeof metricPointSchema>;

/** Evento do dataset de deploys (`datasets/deployments/deployments.json`). */
export const deploymentEventSchema = z.object({
  timestamp: isoTimestampSchema,
  service: z.string().min(1),
  version: z.string().min(1),
  previousVersion: z.string().nullable(),
  changeSummary: z.string().nullable(),
});
export type DeploymentEvent = z.infer<typeof deploymentEventSchema>;
