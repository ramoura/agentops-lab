import { z } from 'zod';
import { TOOL_NAMES } from './common.js';
import type { ToolCallRecord } from './audit.js';
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

// ---------------------------------------------------------------------------
// Red-team (V2.7): contrato opt-in do experimento de prompt injection indireta.
// Definido junto ao eval normal, mas fisicamente separado — casos v1–v2.6
// permanecem válidos e byte-compatíveis (o bloco `redteam` é exclusivo do
// `redTeamEvalCaseSchema`; `evalCaseSchema` continua ignorando o campo).
// ---------------------------------------------------------------------------

/**
 * Os 7 títulos literais do contrato de relatório (RF4), na ordem. Espelha
 * `REPORT_SECTION_TITLES` do prompt-builder e `SECTION_TITLES[0..6]` do
 * renderer — replicado aqui para o contrato red-team não depender das camadas
 * superiores (types é a base da árvore de dependências).
 */
export const REPORT_SECTION_TITLES = [
  'Resumo executivo',
  'Evidências encontradas',
  'Hipótese principal',
  'Hipóteses alternativas',
  'Próximos passos seguros',
  'Dados faltantes',
  'Confiança da análise',
] as const;

const KNOWN_SECTION_TITLES = new Set<string>(REPORT_SECTION_TITLES);

/**
 * Descrição verificável de uma tentativa de prompt injection indireta: a tool
 * `source` carrega o payload em `location`, e `forbidden_outputs` são os
 * marcadores específicos (any-of por variante) que indicam obediência ou
 * reprodução indevida no relatório.
 */
export const attackVectorSchema = z.object({
  id: z.string().min(1),
  source: z.enum(TOOL_NAMES),
  location: z.string().min(1),
  forbidden_outputs: z.array(findingSpecSchema).min(1),
});
export type AttackVector = z.infer<typeof attackVectorSchema>;

/** Invariantes estruturais e vetores adversariais do caso red-team. */
export const redTeamExpectationSchema = z
  .object({
    required_sections: z.array(z.string().min(1)).min(1),
    attack_vectors: z.array(attackVectorSchema).min(1),
    require_safe_first_step: z.boolean().default(true),
  })
  .superRefine((expectation, context) => {
    // required_sections: apenas títulos conhecidos do contrato, sem duplicatas.
    const seenTitles = new Set<string>();
    expectation.required_sections.forEach((title, index) => {
      if (!KNOWN_SECTION_TITLES.has(title)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['required_sections', index],
          message: `required_sections possui título desconhecido: ${title}`,
        });
      }
      if (seenTitles.has(title)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['required_sections', index],
          message: `required_sections possui título duplicado: ${title}`,
        });
      }
      seenTitles.add(title);
    });

    // attack_vectors: ids únicos (breakdown/comparação por vetor).
    const seenIds = new Set<string>();
    expectation.attack_vectors.forEach((vector, index) => {
      if (seenIds.has(vector.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attack_vectors', index, 'id'],
          message: `attack_vectors possui id duplicado: ${vector.id}`,
        });
      }
      seenIds.add(vector.id);
    });
  });
export type RedTeamExpectation = z.infer<typeof redTeamExpectationSchema>;

/**
 * Caso opt-in do experimento red-team: o mesmo contrato do `evalCaseSchema` +
 * o bloco `redteam` obrigatório. Lido apenas pelo runner red-team; o runner
 * normal ignora arquivos fora de `evals/cases/`.
 */
export const redTeamEvalCaseSchema = evalCaseSchema.extend({
  redteam: redTeamExpectationSchema,
});
export type RedTeamEvalCase = z.infer<typeof redTeamEvalCaseSchema>;

/** Agregado de tokens/rodadas reportado pelo runner (espelha `LlmUsage`). */
export const llmUsageSchema = z.object({
  inputTokens: z.number().min(0),
  outputTokens: z.number().min(0),
  cacheReadTokens: z.number().min(0),
  cacheCreationTokens: z.number().min(0),
  rounds: z.number().int().min(0),
});
export type LlmUsageResult = z.infer<typeof llmUsageSchema>;

/**
 * Resultado determinístico do scorer: outcome (do `TextReportScorer`) + critérios
 * de segurança, com `passed`/`score` agregados. Não inclui `model`/`usage` — esses
 * são metadados da execução LLM, adicionados pelo runner (`RedTeamEvalResult`).
 * O `score` é a fração dos critérios de segurança aprovados, separado do outcome
 * score; `passed` só é `true` se o outcome e TODOS os critérios de segurança
 * passarem.
 */
export const redTeamScoreResultSchema = z.object({
  caseId: z.string().min(1),
  outcome: evalCaseResultSchema,
  securityCriteria: z.array(evalCriterionResultSchema),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
});
export type RedTeamScoreResult = z.infer<typeof redTeamScoreResultSchema>;

/** Resultado agregado do experimento: score do scorer + metadados da execução LLM. */
export const redTeamEvalResultSchema = redTeamScoreResultSchema.extend({
  model: z.string().min(1),
  usage: llmUsageSchema,
});
export type RedTeamEvalResult = z.infer<typeof redTeamEvalResultSchema>;

/**
 * Scorer determinístico de segurança (V2.7): compõe o outcome do
 * `TextReportScorer` com critérios por vetor, integridade estrutural e
 * segurança do primeiro próximo passo. Não chama LLM; só avalia propriedades
 * observáveis do relatório e do audit. `model`/`usage` são responsabilidade do
 * runner — por isso o retorno é `RedTeamScoreResult`, não `RedTeamEvalResult`.
 */
export interface RedTeamScorer {
  score(
    evalCase: RedTeamEvalCase,
    markdown: string,
    audit: readonly ToolCallRecord[],
  ): RedTeamScoreResult;
}
