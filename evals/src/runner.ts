import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { McpToolInvoker } from '@agentops/cli-agent/mcp-tool-invoker';
import { renderReport } from '@agentops/cli-agent/renderer';
import { DeterministicInvestigationEngine, PtBrQuestionParser } from '@agentops/core';
import { evalCaseSchema } from '@agentops/types';
import type { EvalCase, EvalCaseResult } from '@agentops/types';
import { DeterministicEvalScorer } from '../scoring/scorer.js';

/**
 * Runner do eval harness (`npm run eval`, RF23): carrega `cases/*.json`,
 * executa cada investigação pelo MESMO caminho da CLI — client MCP real via
 * stdio (`McpToolInvoker`) + engine determinístico + renderer — e pontua com o
 * scorer determinístico, imprimindo o breakdown de critérios por caso (RF27)
 * e o resumo agregado. Progresso vai para stderr; resultados para stdout.
 */

const DEFAULT_CASES_DIR = fileURLToPath(new URL('../cases', import.meta.url));

export interface EvalRunSummary {
  results: EvalCaseResult[];
  /** Casos com todos os critérios aprovados (`passed === true`). */
  passedCount: number;
  /** Média dos scores por caso, 2 casas. */
  averageScore: number;
}

export interface RunEvalsOptions {
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

/** Executa todos os casos e imprime score por caso + resumo agregado (RF23/RF27). */
export async function runEvals(options: RunEvalsOptions = {}): Promise<EvalRunSummary> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));

  const cases = await loadCases(options.casesDir);
  err(`Executando ${cases.length} caso(s) de eval…`);

  const parser = new PtBrQuestionParser();
  const engine = new DeterministicInvestigationEngine();
  const scorer = new DeterministicEvalScorer();

  err('Iniciando o agentops-server (MCP via stdio)…');
  const invoker = await McpToolInvoker.connect({ serverStderr: 'inherit' });

  const results: EvalCaseResult[] = [];
  try {
    for (const evalCase of cases) {
      err(`→ ${evalCase.id}`);
      const parsed = parser.parse(evalCase.question);
      if (!parsed.ok) {
        throw new Error(
          `caso ${evalCase.id}: a pergunta não pôde ser interpretada (faltou: ${parsed.missing
            .map((item) => item.field)
            .join(', ')}) — corrija o campo "question" do caso.`,
        );
      }
      const report = await engine.investigate(parsed.context, invoker);
      const rendered = renderReport(report, false);
      const result = scorer.score(evalCase, report, rendered);
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
  out(`Resumo: ${passedCount}/${results.length} caso(s) aprovado(s) · score médio ${averageScore.toFixed(2)}`);

  return { results, passedCount, averageScore };
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

if (invokedDirectly) {
  runEvals().then(
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
