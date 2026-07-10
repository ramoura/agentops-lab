import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { EngineArgError, formatTokenCount, resolveEngineArgs } from '@agentops/cli-agent/main';
import { McpToolInvoker } from '@agentops/cli-agent/mcp-tool-invoker';
import { renderReport } from '@agentops/cli-agent/renderer';
import { DeterministicInvestigationAssistant } from '@agentops/core';
import {
  AnthropicChatAdapter,
  buildSystemPrompt,
  LlmInvestigationAssistant,
  resolveLlmEngineConfig,
} from '@agentops/llm-engine';
import type { LlmUsage } from '@agentops/llm-engine';
import { evalCaseSchema } from '@agentops/types';
import type { EngineKind, EvalCase, EvalCaseResult, InvestigationAssistant } from '@agentops/types';
import { DeterministicEvalScorer } from '../scoring/scorer.js';
import { TextReportScorer } from '../scoring/text-scorer.js';

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
  results: EvalCaseResult[];
  /** Casos com todos os critérios aprovados (`passed === true`). */
  passedCount: number;
  /** Média dos scores por caso, 2 casas. */
  averageScore: number;
  /** Motor usado na execução (indicado na linha de resumo). */
  engine: EngineKind;
}

export interface RunEvalsOptions {
  /** Motor de investigação (default: `deterministic` — grátis, é o que a CI roda). */
  engine?: EngineKind;
  /**
   * Assistant injetável (testes): substitui a montagem padrão do motor.
   * No modo llm dispensa a `ANTHROPIC_API_KEY`.
   */
  assistant?: InvestigationAssistant;
  /** Diretório dos casos (default: `evals/cases/`). */
  casesDir?: string;
  /** Destino dos resultados (default: stdout). */
  out?: (line: string) => void;
  /** Destino do progresso (default: stderr). */
  err?: (line: string) => void;
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
 * `missing_api_key` falha rápido, sem processo filho órfão).
 */
function buildAssistant(engine: EngineKind, invoker: () => McpToolInvoker): InvestigationAssistant {
  if (engine === 'llm') {
    const config = resolveLlmEngineConfig(process.env);
    return new LlmInvestigationAssistant(
      AnthropicChatAdapter.fromApiKey(config.apiKey),
      () => invoker().listTools(),
      config,
      buildSystemPrompt(),
    );
  }
  return new DeterministicInvestigationAssistant();
}

/** Executa todos os casos e imprime score por caso + resumo agregado (RF23/RF27). */
export async function runEvals(options: RunEvalsOptions = {}): Promise<EvalRunSummary> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const engine = options.engine ?? 'deterministic';

  const cases = await loadCases(options.casesDir);
  err(`Executando ${cases.length} caso(s) de eval…`);

  // Validação do modo llm (API key, skill) antes de spawnar o server.
  let invoker: McpToolInvoker;
  const assistant = options.assistant ?? buildAssistant(engine, () => invoker);

  const deterministicScorer = new DeterministicEvalScorer();
  const textScorer = new TextReportScorer();

  err('Iniciando o agentops-server (MCP via stdio)…');
  invoker = await McpToolInvoker.connect({ serverStderr: 'inherit' });

  const results: EvalCaseResult[] = [];
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
      const result =
        outcome.kind === 'report'
          ? deterministicScorer.score(evalCase, outcome.report, renderReport(outcome.report, false))
          : textScorer.score(evalCase, outcome.markdown);
      results.push(result);
      printCaseResult(result, out);
    }
  } finally {
    await invoker.close().catch(() => {
      // Encerramento do processo filho é melhor esforço: os scores já saíram.
    });
  }

  const passedCount = results.filter((result) => result.passed).length;
  const averageScore =
    results.length === 0 ? 0 : Math.round((results.reduce((sum, result) => sum + result.score, 0) / results.length) * 100) / 100;

  out('');
  out(`Resumo: ${passedCount}/${results.length} caso(s) aprovado(s) · score médio ${averageScore.toFixed(2)} · engine: ${engine}`);

  return { results, passedCount, averageScore, engine };
}

/** `lastUsage` do assistant concreto quando exposto (`LlmInvestigationAssistant`); null caso contrário. */
function readLastUsage(assistant: InvestigationAssistant): LlmUsage | null {
  const usage = (assistant as { lastUsage?: LlmUsage | null }).lastUsage;
  return usage ?? null;
}

/** Score do caso + breakdown critério a critério — não apenas o agregado (RF27). */
function printCaseResult(result: EvalCaseResult, out: (line: string) => void): void {
  const approved = result.criteria.filter((criterion) => criterion.passed).length;
  const status = result.passed ? 'APROVADO' : 'REPROVADO';
  out('');
  out(`${result.caseId} — score ${result.score.toFixed(2)} (${approved}/${result.criteria.length} critérios) — ${status}`);
  for (const criterion of result.criteria) {
    out(`  [${criterion.passed ? 'OK' : 'FALHOU'}] ${criterion.name} — ${criterion.details}`);
  }
}

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
    runEvals({ engine }).then(
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
