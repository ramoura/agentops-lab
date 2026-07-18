import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { EngineArgError, formatTokenCount, resolveEngineArgs } from '@agentops/cli-agent/main';
import { createChatPort } from '@agentops/cli-agent/chat-port-factory';
import { McpToolInvoker } from '@agentops/cli-agent/mcp-tool-invoker';
import { renderReport } from '@agentops/cli-agent/renderer';
import { appendTraceRecord, buildTraceRecord, generateRunId } from '@agentops/cli-agent/trace-log';
import { DeterministicInvestigationAssistant } from '@agentops/core';
import {
  buildSystemPrompt,
  LlmInvestigationAssistant,
  resolveLlmEngineConfig,
} from '@agentops/llm-engine';
import type { LlmUsage } from '@agentops/llm-engine';
import { evalCaseSchema } from '@agentops/types';
import type {
  EngineKind,
  EvalCase,
  EvalCaseResult,
  InvestigationAssistant,
  InvestigationOutcome,
  LlmProvider,
  RoundTrace,
  ToolCallRecord,
  TrajectoryEvalResult,
} from '@agentops/types';
import { DeterministicEvalScorer } from '../scoring/scorer.js';
import { TextReportScorer } from '../scoring/text-scorer.js';
import { DeterministicTrajectoryScorer } from '../scoring/trajectory-scorer.js';

/**
 * Runner do eval harness (`npm run eval -- [--engine=<kind>]`, RF23): carrega
 * `cases/*.json`, executa cada investigação pelo MESMO caminho da CLI — client
 * MCP real via stdio (`McpToolInvoker`) + assistant do motor escolhido — e
 * pontua deterministicamente (RF26): `DeterministicEvalScorer` sobre o report
 * estruturado no modo default, `TextReportScorer` sobre as seções do markdown
 * no modo llm. Imprime o breakdown de critérios por caso (RF27) e o resumo
 * agregado com o engine usado. Progresso vai para stderr; resultados para stdout.
 */

const DEFAULT_CASES_DIR = fileURLToPath(new URL('../cases', import.meta.url));

export interface EvalRunSummary {
  results: EvalRunCaseResult[];
  /** Casos com todos os critérios aprovados (`passed === true`). */
  passedCount: number;
  /** Média dos scores por caso, 2 casas. */
  averageScore: number;
  /** Média das trajetórias configuradas; null quando nenhum caso as declara. */
  averageTrajectoryScore: number | null;
  /** Motor usado na execução (indicado na linha de resumo). */
  engine: EngineKind;
}

/** Outcome canônico (gate) composto com a avaliação informativa da trajetória. */
export interface EvalRunCaseResult {
  outcome: EvalCaseResult;
  trajectory: TrajectoryEvalResult | null;
}

export interface RunEvalsOptions {
  /** Motor de investigação (default: `deterministic` — grátis, é o que a CI roda). */
  engine?: EngineKind;
  /**
   * Assistant injetável (testes): substitui a montagem padrão do motor.
   * No modo llm dispensa a `ANTHROPIC_API_KEY`.
   */
  assistant?: InvestigationAssistant;
  /** Identidade do provider/modelo quando um assistant já foi montado pelo chamador. */
  model?: string | null;
  provider?: LlmProvider | null;
  /** Diretório dos casos (default: `evals/cases/`). */
  casesDir?: string;
  /** Destino dos resultados (default: stdout). */
  out?: (line: string) => void;
  /** Destino do progresso (default: stderr). */
  err?: (line: string) => void;
  /**
   * Caminho do arquivo JSONL de trace (opt-in, mesmo padrão de `AGENTOPS_TRACE_LOG`
   * em `investigate`). Sem valor, nenhum I/O de trace acontece. Lido da env
   * apenas no bloco `invokedDirectly` — `runEvals()` em si permanece puro.
   */
  traceLogPath?: string;
}

/** Carrega e valida todos os `cases/*.json`, em ordem alfabética (determinístico). */
export async function loadCases(casesDir: string = DEFAULT_CASES_DIR): Promise<EvalCase[]> {
  const files = (await readdir(casesDir)).filter((file) => file.endsWith('.json')).sort();
  const cases: EvalCase[] = [];
  for (const file of files) {
    const raw = await readFile(join(casesDir, file), 'utf8');
    cases.push(evalCaseSchema.parse(JSON.parse(raw)));
  }
  return cases;
}

/**
 * Monta o assistant do motor escolhido. No modo llm, config e system prompt
 * são resolvidos ANTES do spawn do server (mesma validação e mensagem da CLI:
 * `missing_api_key` falha rápido, sem processo filho órfão). O `model`
 * resolvido volta junto — usado pelo trace (`AGENTOPS_LLM_MODEL` efetivo).
 */
function buildAssistant(
  engine: EngineKind,
  invoker: () => McpToolInvoker,
): { assistant: InvestigationAssistant; model: string | null; provider: LlmProvider | null } {
  if (engine === 'llm') {
    const config = resolveLlmEngineConfig(process.env);
    const assistant = new LlmInvestigationAssistant(
      createChatPort(config),
      () => invoker().listTools(),
      config,
      buildSystemPrompt(),
    );
    return { assistant, model: config.model, provider: config.provider };
  }
  return { assistant: new DeterministicInvestigationAssistant(), model: null, provider: null };
}

/** Executa todos os casos e imprime score por caso + resumo agregado (RF23/RF27). */
export async function runEvals(options: RunEvalsOptions = {}): Promise<EvalRunSummary> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const engine = options.engine ?? 'deterministic';
  const traceLogPath = options.traceLogPath;
  // Um runId por execução de `runEvals()`, compartilhado pelos N casos —
  // agrupa os traces de um mesmo eval (jq por `runId`).
  const runId = generateRunId();

  const cases = await loadCases(options.casesDir);
  err(`Executando ${cases.length} caso(s) de eval…`);

  // Validação do modo llm (API key, skill) antes de spawnar o server.
  let invoker: McpToolInvoker;
  let model: string | null = engine === 'llm' ? (options.model ?? null) : null;
  let provider: LlmProvider | null = engine === 'llm' ? (options.provider ?? null) : null;
  const assistant =
    options.assistant ??
    (() => {
      const built = buildAssistant(engine, () => invoker);
      model = built.model;
      provider = built.provider;
      return built.assistant;
    })();

  const deterministicScorer = new DeterministicEvalScorer();
  const textScorer = new TextReportScorer();
  const trajectoryScorer = new DeterministicTrajectoryScorer();

  err('Iniciando o agentops-server (MCP via stdio)…');
  invoker = await McpToolInvoker.connect({ serverStderr: 'inherit' });

  const results: EvalRunCaseResult[] = [];
  try {
    for (const evalCase of cases) {
      err(`→ ${evalCase.id}`);
      const outcome = await assistant.investigate(evalCase.question, invoker);
      // Agregado de cache do caso (V2.5, progresso em stderr): só no modo llm
      // e só quando o assistant concreto expõe `lastUsage` — instrumentação
      // opcional; fakes injetados sem o campo apenas omitem a linha.
      if (engine === 'llm') {
        const usage = readLastUsage(assistant);
        if (usage !== null) {
          err(
            `  Cache: ${formatTokenCount(usage.cacheReadTokens)} lido · ` +
              `${formatTokenCount(usage.cacheCreationTokens)} escrito · ` +
              `${formatTokenCount(usage.inputTokens)} sem cache`,
          );
        }
      }
      if (outcome.kind === 'clarification') {
        throw new Error(
          `caso ${evalCase.id}: a pergunta não pôde ser interpretada (faltou: ${outcome.missing
            .map((item) => item.field)
            .join(', ')}) — corrija o campo "question" do caso.`,
        );
      }
      // Scoring 100% determinístico nos dois modos (RF26): report estruturado
      // → scorer da V1 (byte-idêntico); markdown do LLM → scorer text-mode.
      const outcomeResult =
        outcome.kind === 'report'
          ? deterministicScorer.score(evalCase, outcome.report, renderReport(outcome.report, false))
          : textScorer.score(evalCase, outcome.markdown);
      const result: EvalRunCaseResult = {
        outcome: outcomeResult,
        trajectory:
          evalCase.expected_trajectory === undefined
            ? null
            : trajectoryScorer.score(evalCase.expected_trajectory, auditFromOutcome(outcome)),
      };
      results.push(result);
      printCaseResult(result, out);

      if (traceLogPath !== undefined) {
        try {
          const record = buildTraceRecord({
            source: 'eval',
            runId,
            caseId: evalCase.id,
            question: evalCase.question,
            engine,
            model,
            provider,
            outcome,
            rounds: readLastTrace(assistant),
            usage: readLastUsage(assistant),
            evalResult: outcomeResult,
          });
          await appendTraceRecord(traceLogPath, record);
        } catch (error) {
          err(`Aviso: falha ao gravar o trace do caso ${evalCase.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } finally {
    await invoker.close().catch(() => {
      // Encerramento do processo filho é melhor esforço: os scores já saíram.
    });
  }

  const passedCount = results.filter((result) => result.outcome.passed).length;
  const averageScore =
    results.length === 0
      ? 0
      : Math.round((results.reduce((sum, result) => sum + result.outcome.score, 0) / results.length) * 100) / 100;
  const configuredTrajectories = results.flatMap((result) =>
    result.trajectory === null ? [] : [result.trajectory],
  );
  const averageTrajectoryScore =
    configuredTrajectories.length === 0
      ? null
      : Math.round(
          (configuredTrajectories.reduce((sum, trajectory) => sum + trajectory.score, 0) /
            configuredTrajectories.length) *
            100,
        ) / 100;

  out('');
  const trajectorySummary =
    averageTrajectoryScore === null
      ? ''
      : ` · trajetória média ${averageTrajectoryScore.toFixed(2)} (informativa)`;
  out(
    `Resumo: ${passedCount}/${results.length} outcome(s) aprovado(s) · score médio ${averageScore.toFixed(2)}` +
      `${trajectorySummary} · engine: ${engine}`,
  );

  return { results, passedCount, averageScore, averageTrajectoryScore, engine };
}

/** Audit canônico de cada variante; nunca consulta instrumentação auxiliar do assistant. */
export function auditFromOutcome(outcome: InvestigationOutcome): ToolCallRecord[] {
  if (outcome.kind === 'report') return outcome.report.audit;
  if (outcome.kind === 'markdown') return outcome.audit;
  return [];
}

/** `lastUsage` do assistant concreto quando exposto (`LlmInvestigationAssistant`); null caso contrário. */
function readLastUsage(assistant: InvestigationAssistant): LlmUsage | null {
  const usage = (assistant as { lastUsage?: LlmUsage | null }).lastUsage;
  return usage ?? null;
}

/** `lastTrace` do assistant concreto quando exposto (`LlmInvestigationAssistant`); null caso contrário (RF trace, motor deterministic ou fake de teste sem o campo). */
function readLastTrace(assistant: InvestigationAssistant): RoundTrace[] | null {
  const trace = (assistant as { lastTrace?: RoundTrace[] }).lastTrace;
  return trace ?? null;
}

/** Score do caso + breakdown critério a critério — não apenas o agregado (RF27). */
export function printCaseResult(result: EvalRunCaseResult, out: (line: string) => void): void {
  const { outcome, trajectory } = result;
  const approved = outcome.criteria.filter((criterion) => criterion.passed).length;
  const status = outcome.passed ? 'APROVADO' : 'REPROVADO';
  out('');
  out(
    `${outcome.caseId} — outcome ${outcome.score.toFixed(2)} (${approved}/${outcome.criteria.length} critérios) — ${status}`,
  );
  for (const criterion of outcome.criteria) {
    out(`  [${criterion.passed ? 'OK' : 'FALHOU'}] ${criterion.name} — ${criterion.details}`);
  }
  if (trajectory !== null) {
    const trajectoryApproved = trajectory.criteria.filter((criterion) => criterion.passed).length;
    out(
      `  Trajetória — score ${trajectory.score.toFixed(2)} (${trajectoryApproved}/${trajectory.criteria.length} critérios)` +
        ` — INFORMATIVO: ${trajectory.passed ? 'OK' : 'ATENÇÃO'}`,
    );
    for (const criterion of trajectory.criteria) {
      out(`    [${criterion.passed ? 'OK' : 'FALHOU'}] ${criterion.name} — ${criterion.details}`);
    }
    out(
      `  Métricas: ${trajectory.metrics.total_calls} chamadas · ` +
        `${trajectory.metrics.unique_call_signatures} únicas · ` +
        `${trajectory.metrics.duplicate_calls} duplicadas · ` +
        `${trajectory.metrics.failed_calls} falhas · ` +
        `${trajectory.metrics.total_duration_ms.toFixed(2)}ms`,
    );
  }
}

/* c8 ignore start — composition root is covered by the CLI E2E contract. */
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function resolveCliEngine(): EngineKind | null {
  try {
    return resolveEngineArgs(process.argv.slice(2), process.env).engine;
  } catch (error) {
    if (error instanceof EngineArgError) {
      process.stderr.write(`${error.message}\nUso: npm run eval -- [--engine=deterministic|llm]\n`);
      return null;
    }
    throw error;
  }
}

if (invokedDirectly) {
  const engine = resolveCliEngine();
  if (engine === null) {
    process.exitCode = 1;
  } else {
    runEvals({ engine, traceLogPath: process.env['AGENTOPS_TRACE_LOG'] }).then(
      (summary) => {
        process.exitCode = summary.passedCount === summary.results.length ? 0 : 1;
      },
      (error: unknown) => {
        // Nunca stack trace cru para o usuário (fluxo de erro do PRD).
        process.stderr.write(`O eval falhou: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  }
}
/* c8 ignore stop */
