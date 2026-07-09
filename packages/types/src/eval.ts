import { z } from 'zod';
import type { InvestigationReport } from './report.js';

/** Caso de teste do eval harness (`evals/cases/*.json`, RF25). */
export const evalCaseSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  expected_findings: z.array(z.string().min(1)),
  must_not_include: z.array(z.string().min(1)),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

/** Um item por critério avaliado — o eval reporta o que passou e o que falhou (RF27). */
export const evalCriterionResultSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  details: z.string(),
});
export type EvalCriterionResult = z.infer<typeof evalCriterionResultSchema>;

export const evalCaseResultSchema = z.object({
  caseId: z.string().min(1),
  criteria: z.array(evalCriterionResultSchema),
  score: z.number().min(0).max(1),
  passed: z.boolean(),
});
export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;

/** Scoring determinístico por matching de termos — sem LLM (RF26). */
export interface EvalScorer {
  score(evalCase: EvalCase, report: InvestigationReport, renderedText: string): EvalCaseResult;
}
