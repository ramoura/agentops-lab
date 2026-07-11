import { randomUUID } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  EngineKind,
  EvalCaseResult,
  InvestigationOutcome,
  InvestigationTraceRecord,
  RoundTrace,
  ToolCallRecord,
} from '@agentops/types';
import type { LlmUsage } from '@agentops/llm-engine';

/**
 * Trace completo de investigação em disco (JSONL, opt-in via `AGENTOPS_TRACE_LOG`).
 * Reúne o que `main.ts`/`runner.ts` já produzem — não altera nenhuma lógica de
 * investigação, só monta e grava um `InvestigationTraceRecord` a partir dela.
 */

/** Timestamp ISO 8601 sem `:`/`.` (compatível com nome de arquivo) + sufixo curto único. */
export function generateRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomUUID().slice(0, 4);
  return `${timestamp}-${suffix}`;
}

export interface BuildTraceRecordInput {
  source: 'investigate' | 'eval';
  runId: string;
  caseId: string | null;
  question: string;
  engine: EngineKind;
  model: string | null;
  outcome: InvestigationOutcome;
  rounds: RoundTrace[] | null;
  usage: LlmUsage | null;
  evalResult: EvalCaseResult | null;
}

/** Extrai a trilha de auditoria (RF7) do outcome, pelos 3 `kind` possíveis. */
function extractAudit(outcome: InvestigationOutcome): ToolCallRecord[] {
  switch (outcome.kind) {
    case 'report':
      return outcome.report.audit;
    case 'markdown':
      return outcome.audit;
    case 'clarification':
      return [];
  }
}

export function buildTraceRecord(input: BuildTraceRecordInput): InvestigationTraceRecord {
  return {
    traceId: generateRunId(),
    runId: input.runId,
    timestamp: new Date().toISOString(),
    source: input.source,
    caseId: input.caseId,
    question: input.question,
    engine: input.engine,
    model: input.model,
    outcome: input.outcome,
    audit: extractAudit(input.outcome),
    rounds: input.rounds,
    usage:
      input.usage === null
        ? null
        : {
            input_tokens: input.usage.inputTokens,
            output_tokens: input.usage.outputTokens,
            cache_creation_input_tokens: input.usage.cacheCreationTokens,
            cache_read_input_tokens: input.usage.cacheReadTokens,
            rounds: input.usage.rounds,
          },
    eval: input.evalResult,
  };
}

/** Append-only: cria o diretório de destino se ausente, nunca reescreve o arquivo. */
export async function appendTraceRecord(path: string, record: InvestigationTraceRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}
