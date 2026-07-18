import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DeterministicInvestigationAssistant } from '@agentops/core';
import {
  buildSystemPrompt,
  LlmEngineError,
  LlmInvestigationAssistant,
  resolveLlmEngineConfig,
} from '@agentops/llm-engine';
import type { LlmEngineConfig, LlmUsage } from '@agentops/llm-engine';
import { ENGINE_KINDS } from '@agentops/types';
import type {
  EngineKind,
  InvestigationAssistant,
  InvestigationOutcome,
  InvestigationTraceRecord,
  LlmProvider,
  ToolInvoker,
  ToolName,
} from '@agentops/types';
import { McpConnectionError, McpToolInvoker } from './mcp-tool-invoker.js';
import { createChatPort } from './chat-port-factory.js';
import { renderMissingFields, renderOutcome, renderUsage, shouldUseColor } from './renderer.js';
import { appendTraceRecord, buildTraceRecord, generateRunId } from './trace-log.js';

/**
 * Entrypoint de `npm run investigate -- [--engine=<kind>] "<pergunta>"` (RF1):
 * spawna o agentops-server via MCP stdio, entrega a pergunta crua ao assistant
 * do motor escolhido (`deterministic` por default; `llm` via flag ou env) e
 * imprime o relatório. Progresso por etapa vai para stderr; o relatório final
 * vai para stdout — `> relatorio.txt` produz um arquivo limpo.
 */

/** Mensagem de progresso por tool (passos 2–8 da skill), exibida em stderr. */
const PROGRESS_MESSAGES: Record<ToolName, string> = {
  get_error_summary: 'Coletando resumo de erros…',
  get_top_exceptions: 'Coletando top exceptions…',
  get_recent_logs: 'Coletando logs recentes…',
  get_latency_summary: 'Coletando resumo de latência…',
  get_deployment_events: 'Coletando eventos de deploy…',
  search_runbooks: 'Buscando runbooks relacionados…',
  get_runbook: 'Lendo runbook relacionado…',
  search_adrs: 'Buscando ADRs relacionados…',
  search_tech_specs: 'Buscando tech specs relacionadas…',
};

function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Decorator de progresso: anuncia cada etapa em stderr antes de invocar a tool. */
function withProgress(inner: ToolInvoker): ToolInvoker {
  return {
    async invoke<TIn, TOut>(tool: ToolName, params: TIn): Promise<TOut> {
      progress(PROGRESS_MESSAGES[tool] ?? `Consultando ${tool}…`);
      return inner.invoke<TIn, TOut>(tool, params);
    },
  };
}

/** Valor de `--engine`/`AGENTOPS_ENGINE` fora de `ENGINE_KINDS` → uso + exit 1. */
export class EngineArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineArgError';
  }
}

/**
 * Resolve o motor a partir de argv + env: `--engine=<kind>` vence
 * `AGENTOPS_ENGINE`, e o default é `deterministic` (custo zero, sem API key).
 * A flag é removida de `rest` — o que sobra é a pergunta. Compartilhada com o
 * eval runner (mesma semântica nos dois comandos).
 */
export function resolveEngineArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): { engine: EngineKind; rest: string[] } {
  let engine: EngineKind | undefined;
  const rest: string[] = [];

  for (const arg of argv) {
    if (arg === '--engine' || arg.startsWith('--engine=')) {
      const value = arg.startsWith('--engine=') ? arg.slice('--engine='.length) : '';
      if (!isEngineKind(value)) {
        throw new EngineArgError(`--engine inválido: "${value}". Valores aceitos: ${ENGINE_KINDS.join(', ')}.`);
      }
      engine = value;
      continue;
    }
    rest.push(arg);
  }

  if (engine === undefined) {
    const fromEnv = env['AGENTOPS_ENGINE']?.trim();
    if (fromEnv !== undefined && fromEnv !== '') {
      if (!isEngineKind(fromEnv)) {
        throw new EngineArgError(
          `AGENTOPS_ENGINE inválida: "${fromEnv}". Valores aceitos: ${ENGINE_KINDS.join(', ')}.`,
        );
      }
      engine = fromEnv;
    }
  }

  return { engine: engine ?? 'deterministic', rest };
}

function isEngineKind(value: string): value is EngineKind {
  return (ENGINE_KINDS as readonly string[]).includes(value);
}

/** `12437` → `12.4k` (linha de custo do modo llm em stderr). */
export function formatTokenCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/**
 * Linha de custo do modo llm (stderr). Com cache efetivo, detalha lido/escrito
 * entre parênteses; com cache zero (opt-out ou prefixo abaixo do mínimo
 * cacheável) degrada para o formato da V2 — sem parêntese vazio.
 */
export function formatUsageLine(usage: LlmUsage): string {
  const cacheDetail =
    usage.cacheReadTokens + usage.cacheCreationTokens > 0
      ? ` (${formatTokenCount(usage.cacheReadTokens)} cache lido · ${formatTokenCount(usage.cacheCreationTokens)} cache escrito)`
      : '';
  return (
    `Tokens: ${formatTokenCount(usage.inputTokens)} entrada${cacheDetail} · ` +
    `${formatTokenCount(usage.outputTokens)} saída · ${usage.rounds} rodada(s)`
  );
}

export interface InvestigateTraceInput {
  tracePath: string | undefined;
  outcome: InvestigationOutcome;
  question: string;
  engine: EngineKind;
  model: string | null;
  provider?: LlmProvider | null;
  llmAssistant: LlmInvestigationAssistant | null;
}

/**
 * Grava o trace de uma investigação avulsa (RF opt-in via `AGENTOPS_TRACE_LOG`):
 * sem a env, ou com pergunta ambígua (RF3, nenhuma tool chamada), é um no-op.
 * `runId === traceId` — uma investigação avulsa é seu próprio "run" (ao
 * contrário do eval, que agrupa N traces sob um único runId).
 * Falha ao gravar vira aviso em stderr; nunca lança (não muda o exit code do
 * relatório que já foi impresso).
 */
export async function writeInvestigateTrace(input: InvestigateTraceInput): Promise<void> {
  const { tracePath, outcome, question, engine, model, provider, llmAssistant } = input;
  if (tracePath === undefined || outcome.kind === 'clarification') {
    return;
  }
  try {
    const runId = generateRunId();
    const record: InvestigationTraceRecord = {
      ...buildTraceRecord({
        source: 'investigate',
        runId,
        caseId: null,
        question,
        engine,
        model,
        provider,
        outcome,
        rounds: llmAssistant?.lastTrace ?? null,
        usage: llmAssistant?.lastUsage ?? null,
        evalResult: null,
      }),
      traceId: runId,
    };
    await appendTraceRecord(tracePath, record);
  } catch (error) {
    progress(`Aviso: falha ao gravar o trace de investigação: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<number> {
  const useColor = shouldUseColor(process.stdout);

  let engine: EngineKind;
  let rest: string[];
  try {
    ({ engine, rest } = resolveEngineArgs(process.argv.slice(2), process.env));
  } catch (error) {
    if (error instanceof EngineArgError) {
      process.stderr.write(`${error.message}\n\n${renderUsage()}`);
      return 1;
    }
    throw error;
  }

  const question = rest.join(' ').trim();
  if (question === '') {
    process.stderr.write(renderUsage());
    return 1;
  }

  // Modo llm: config e system prompt resolvidos ANTES do spawn do server —
  // missing_api_key, env inválida ou skill ausente falham rápido, sem
  // processo filho órfão (fluxo de erro do PRD).
  let llm: { config: LlmEngineConfig; systemPrompt: string } | null = null;
  if (engine === 'llm') {
    try {
      llm = { config: resolveLlmEngineConfig(process.env), systemPrompt: buildSystemPrompt() };
    } catch (error) {
      if (error instanceof LlmEngineError) {
        process.stderr.write(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
  }

  progress('Iniciando o agentops-server (MCP via stdio)…');

  let invoker: McpToolInvoker;
  try {
    invoker = await McpToolInvoker.connect();
  } catch (error) {
    const detail = error instanceof McpConnectionError ? error.message : String(error);
    process.stderr.write(
      `Não foi possível conectar ao servidor de tools: ${detail}\n` +
        'Verifique se as dependências foram instaladas com "npm install" e tente novamente.\n',
    );
    return 1;
  }

  try {
    let assistant: InvestigationAssistant;
    let llmAssistant: LlmInvestigationAssistant | null = null;
    if (llm !== null) {
      llmAssistant = new LlmInvestigationAssistant(
        createChatPort(llm.config),
        () => invoker.listTools(),
        llm.config,
        llm.systemPrompt,
        { onRound: (round, maxRounds) => progress(`Consultando o modelo (rodada ${round}/${maxRounds})…`) },
      );
      assistant = llmAssistant;
    } else {
      assistant = new DeterministicInvestigationAssistant();
    }

    const outcome = await assistant.investigate(question, withProgress(invoker));

    // Pergunta ambígua orienta e encerra sem chamar nenhuma tool (RF3/US10).
    if (outcome.kind === 'clarification') {
      process.stdout.write(renderMissingFields(outcome.missing, useColor));
      return 0;
    }

    progress('Montando o relatório…');
    process.stdout.write(renderOutcome(outcome, useColor));

    // Visibilidade de custo por investigação (modo llm): agregado em stderr.
    const usage = llmAssistant?.lastUsage;
    if (usage !== undefined && usage !== null) {
      progress(formatUsageLine(usage));
    }

    await writeInvestigateTrace({
      tracePath: process.env['AGENTOPS_TRACE_LOG'],
      outcome,
      question,
      engine,
      model: llm?.config.model ?? null,
      provider: llm?.config.provider ?? null,
      llmAssistant,
    });

    return 0;
  } catch (error) {
    if (error instanceof LlmEngineError) {
      process.stderr.write(`A investigação falhou: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await invoker.close().catch(() => {
      // Encerramento do processo filho é melhor esforço: o relatório já saiu.
    });
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Nunca stack trace cru para o usuário (fluxo de erro do PRD).
      process.stderr.write(`A investigação falhou: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
