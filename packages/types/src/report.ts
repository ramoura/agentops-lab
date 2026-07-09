import { z } from 'zod';
import { timeWindowSchema } from './common.js';
import { toolCallRecordSchema } from './audit.js';
import type { ToolCallRecord, ToolInvoker } from './audit.js';

/** Resultado da interpretação da pergunta (RF2). */
export const investigationContextSchema = z.object({
  question: z.string().min(1),
  service: z.string().min(1),
  window: timeWindowSchema,
  symptom: z.string().nullable(),
});
export type InvestigationContext = z.infer<typeof investigationContextSchema>;

/** Campo que o parser não conseguiu extrair da pergunta (RF3/US10). */
export const missingFieldSchema = z.object({
  field: z.enum(['service', 'window']),
  hint: z.string().min(1),
});
export type MissingField = z.infer<typeof missingFieldSchema>;

/** O parser não adivinha: ou extrai o contexto completo, ou lista o que faltou. */
export type ParseResult = { ok: true; context: InvestigationContext } | { ok: false; missing: MissingField[] };

export interface QuestionParser {
  parse(question: string): ParseResult;
}

export const confidenceSchema = z.enum(['baixa', 'media', 'alta']);
export type Confidence = z.infer<typeof confidenceSchema>;

export const hypothesisSchema = z.object({
  statement: z.string().min(1),
  rationale: z.string().min(1),
  confidence: confidenceSchema,
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;

/** Evidência sempre cita a tool e a referência que a sustentam (RF5). */
export const evidenceSchema = z.object({
  statement: z.string().min(1),
  source: z.object({
    tool: z.string().min(1),
    reference: z.string().min(1),
  }),
});
export type Evidence = z.infer<typeof evidenceSchema>;

/** Saída estruturada do engine, nas seções e ordem do RF4. */
export const investigationReportSchema = z.object({
  context: investigationContextSchema,
  summary: z.string().min(1),
  evidences: z.array(evidenceSchema),
  primaryHypothesis: hypothesisSchema.nullable(),
  alternativeHypotheses: z.array(hypothesisSchema),
  safeNextSteps: z.array(z.string().min(1)),
  missingData: z.array(z.string().min(1)),
  confidence: confidenceSchema,
  audit: z.array(toolCallRecordSchema),
});
export type InvestigationReport = z.infer<typeof investigationReportSchema>;

export interface InvestigationEngine {
  investigate(context: InvestigationContext, tools: ToolInvoker): Promise<InvestigationReport>;
}

/**
 * Resultado de uma investigação, independente do motor (V2):
 * - `report` — relatório estruturado do motor determinístico (schema da V1 inalterado);
 * - `markdown` — relatório em texto livre do motor LLM + auditoria coletada por código (RF7);
 * - `clarification` — pergunta ambígua no motor determinístico (RF3/US10), nenhuma tool invocada.
 */
export type InvestigationOutcome =
  | { kind: 'report'; report: InvestigationReport }
  | { kind: 'markdown'; markdown: string; audit: ToolCallRecord[] }
  | { kind: 'clarification'; missing: MissingField[] };

/** Motor de investigação de ponta a ponta: pergunta crua → resultado (V2). */
export interface InvestigationAssistant {
  investigate(question: string, tools: ToolInvoker): Promise<InvestigationOutcome>;
}
