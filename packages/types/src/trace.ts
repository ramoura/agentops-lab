import { z } from 'zod';
import { engineKindSchema } from './common.js';
import { toolCallRecordSchema } from './audit.js';
import { evalCaseResultSchema } from './eval.js';
import { investigationReportSchema, missingFieldSchema } from './report.js';

/** Mirror leve dos blocos da Messages API — só o necessário para o trace (sem cache_control). */
export const roundContentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.unknown()) }),
]);
export type RoundContentBlock = z.infer<typeof roundContentBlockSchema>;

export const roundToolResultSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.string(), // conteúdo EXATO enviado ao modelo (JSON.stringify do resultado, ou a mensagem de erro)
  is_error: z.boolean().optional(),
});
export type RoundToolResult = z.infer<typeof roundToolResultSchema>;

export const roundUsageSchema = z.object({
  input_tokens: z.number().min(0),
  output_tokens: z.number().min(0),
  cache_creation_input_tokens: z.number().min(0),
  cache_read_input_tokens: z.number().min(0),
});
export type RoundUsage = z.infer<typeof roundUsageSchema>;

/** Uma rodada do loop agêntico: o que o modelo produziu + o que voltou de tool. */
export const roundTraceSchema = z.object({
  round: z.number().int().min(1),
  assistantContent: z.array(roundContentBlockSchema),
  stopReason: z.string().nullable(),
  usage: roundUsageSchema,
  toolResults: z.array(roundToolResultSchema), // vazio na rodada final (end_turn)
});
export type RoundTrace = z.infer<typeof roundTraceSchema>;

const outcomeTraceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('report'), report: investigationReportSchema }),
  z.object({ kind: z.literal('markdown'), markdown: z.string(), audit: z.array(toolCallRecordSchema) }),
  z.object({ kind: z.literal('clarification'), missing: z.array(missingFieldSchema) }),
]);

export const investigationTraceRecordSchema = z.object({
  traceId: z.string().min(1), // 1 por investigação (timestamp + sufixo curto)
  runId: z.string().min(1), // agrupa os N traces de uma mesma invocação de eval; == traceId em investigate avulso
  timestamp: z.string().datetime({ offset: true }),
  source: z.enum(['investigate', 'eval']),
  caseId: z.string().min(1).nullable(), // id do caso (evals/cases/*.json); null fora do eval
  question: z.string().min(1),
  engine: engineKindSchema,
  model: z.string().nullable(), // AGENTOPS_LLM_MODEL resolvido; null no motor deterministic
  outcome: outcomeTraceSchema, // InvestigationOutcome inteiro — report OU markdown+audit OU clarification
  audit: z.array(toolCallRecordSchema), // trilha de auditoria (RF7), extraída do outcome para consulta direta
  rounds: z.array(roundTraceSchema).nullable(), // só motor llm; null no deterministic
  usage: roundUsageSchema.extend({ rounds: z.number().min(0) }).nullable(), // agregado (LlmUsage); null no deterministic
  eval: evalCaseResultSchema.nullable(), // score/critérios do caso; null em investigate avulso
});
export type InvestigationTraceRecord = z.infer<typeof investigationTraceRecordSchema>;
