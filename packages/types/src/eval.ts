import { z } from 'zod';
import { TOOL_NAMES } from './common.js';
import type { InvestigationReport } from './report.js';

/** Uma entrada de expected_findings/must_not_include: termo único ou variantes aceitas (any-of). */
export type FindingSpec = string | string[];

export const findingSpecSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const requiredToolCallExpectationSchema = z
  .object({
    id: z.string().min(1),
    tool: z.enum(TOOL_NAMES),
    params: z.record(z.unknown()).default({}),
    min_occurrences: z.number().int().min(0).default(1),
    max_occurrences: z.number().int().min(0).optional(),
  })
  .superRefine((expectation, context) => {
    if (
      expectation.max_occurrences !== undefined &&
      expectation.max_occurrences < expectation.min_occurrences
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max_occurrences'],
        message: 'max_occurrences deve ser maior ou igual a min_occurrences',
      });
    }
  });
export type RequiredToolCallExpectation = z.infer<typeof requiredToolCallExpectationSchema>;

export const toolOrderConstraintSchema = z.object({
  before: z.string().min(1),
  after: z.string().min(1),
});
export type ToolOrderConstraint = z.infer<typeof toolOrderConstraintSchema>;

export const expectedTrajectorySchema = z
  .object({
    required_calls: z.array(requiredToolCallExpectationSchema).default([]),
    order_constraints: z.array(toolOrderConstraintSchema).default([]),
    forbid_exact_duplicates: z.boolean().default(true),
    max_calls: z.number().int().min(0).optional(),
  })
  .superRefine((trajectory, context) => {
    const ids = new Set<string>();
    trajectory.required_calls.forEach((call, index) => {
      if (ids.has(call.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['required_calls', index, 'id'],
          message: `required_calls possui id duplicado: ${call.id}`,
        });
      }
      ids.add(call.id);
    });

    trajectory.order_constraints.forEach((constraint, index) => {
      if (!ids.has(constraint.before)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['order_constraints', index, 'before'],
          message: `before referencia required_call inexistente: ${constraint.before}`,
        });
      }
      if (!ids.has(constraint.after)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['order_constraints', index, 'after'],
          message: `after referencia required_call inexistente: ${constraint.after}`,
        });
      }
      if (constraint.before === constraint.after) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['order_constraints', index],
          message: 'before e after devem referenciar IDs distintos',
        });
      }
    });

    // Limite inferior conservador: expectativas podem se sobrepor, portanto
    // somente o maior mínimo individual é certamente necessário.
    const minimumPossibleCalls = Math.max(0, ...trajectory.required_calls.map((call) => call.min_occurrences));
    if (trajectory.max_calls !== undefined && trajectory.max_calls < minimumPossibleCalls) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max_calls'],
        message: `max_calls deve permitir ao menos ${minimumPossibleCalls} chamada(s)`,
      });
    }
  });
export type ExpectedTrajectory = z.infer<typeof expectedTrajectorySchema>;

/** Caso de teste do eval harness (`evals/cases/*.json`, RF25). */
export const evalCaseSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  expected_findings: z.array(findingSpecSchema),
  must_not_include: z.array(findingSpecSchema),
  expected_trajectory: expectedTrajectorySchema.optional(),
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

export const trajectoryCriterionResultSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  details: z.string(),
});
export type TrajectoryCriterionResult = z.infer<typeof trajectoryCriterionResultSchema>;

export const trajectoryMetricsSchema = z.object({
  total_calls: z.number().int().min(0),
  unique_call_signatures: z.number().int().min(0),
  duplicate_calls: z.number().int().min(0),
  failed_calls: z.number().int().min(0),
  total_duration_ms: z.number().min(0),
});
export type TrajectoryMetrics = z.infer<typeof trajectoryMetricsSchema>;

export const trajectoryEvalResultSchema = z.object({
  criteria: z.array(trajectoryCriterionResultSchema),
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  metrics: trajectoryMetricsSchema,
});
export type TrajectoryEvalResult = z.infer<typeof trajectoryEvalResultSchema>;

/** Scoring determinístico por matching de termos — sem LLM (RF26). */
export interface EvalScorer {
  score(evalCase: EvalCase, report: InvestigationReport, renderedText: string): EvalCaseResult;
}
