import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatPort } from '@agentops/cli-agent/chat-port-factory';
import { formatTokenCount } from '@agentops/cli-agent/main';
import { McpToolInvoker } from '@agentops/cli-agent/mcp-tool-invoker';
import { appendTraceRecord, buildTraceRecord, generateRunId } from '@agentops/cli-agent/trace-log';
import type { ChatPort, LlmEngineConfig, LlmUsage } from '@agentops/llm-engine';
import {
  LlmEngineError,
  LlmInvestigationAssistant,
  buildSystemPrompt,
  resolveLlmEngineConfig,
} from '@agentops/llm-engine';
import type { LlmEngineErrorCode } from '@agentops/llm-engine';
import type { EvalCaseResult, InvestigationOutcome, LlmProvider, McpToolDefinition, ToolInvoker } from '@agentops/types';
import { loadCases } from './runner.js';
import { TextReportScorer } from '../scoring/text-scorer.js';

const DEFAULT_CASES_DIR = fileURLToPath(new URL('../cases', import.meta.url));
const MODELS_SYNTAX = '--models=provider:modelo,...';
const ANSI_RE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export interface CompareEntry {
  provider: LlmProvider;
  model: string;
}

export interface CompareRow {
  provider: LlmProvider;
  model: string;
  status: 'ok' | LlmEngineErrorCode;
  score: number | null;
  criteria: { name: string; passed: boolean }[] | null;
  completed: boolean | null;
  rounds: number;
  usage: LlmUsage | null;
}

export interface CompareInvoker extends ToolInvoker {
  listTools(): Promise<McpToolDefinition[]>;
  close(): Promise<void>;
}

export interface CompareOptions {
  entries: CompareEntry[];
  question: string | null;
  casesDir?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  traceLogPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam; the default is the production provider factory. */
  chatPortFactory?: (config: LlmEngineConfig) => ChatPort;
  /** Test seam; the default spawns one MCP server per entry. */
  invokerFactory?: () => Promise<CompareInvoker>;
}

export type CompareMode = 'eval' | 'adhoc';

export class CompareInvocationError extends Error {
  readonly code: 'MODELS_MISSING' | 'MODELS_INVALID' | 'QUESTION_EMPTY';

  constructor(code: CompareInvocationError['code'], message: string) {
    super(message);
    this.name = 'CompareInvocationError';
    this.code = code;
  }
}

function usageMessage(): string {
  return `Uso: npm run compare -- ${MODELS_SYNTAX} ["pergunta ad-hoc"]`;
}

function invocationMessage(message: string): string {
  return `${message}\n${usageMessage()}`;
}

/** Parseia a CLI sem tocar ambiente, filesystem, MCP ou qualquer provider. */
export function parseCompareArgs(argv: string[]): { entries: CompareEntry[]; question: string | null } {
  const modelArgs = argv.filter((arg) => arg.startsWith('--models='));
  if (argv.includes('--models') || modelArgs.length > 1) {
    throw new CompareInvocationError('MODELS_INVALID', invocationMessage(`Informe exatamente uma opção ${MODELS_SYNTAX}.`));
  }
  const modelArg = modelArgs[0];
  if (modelArg === undefined || modelArg.slice('--models='.length).trim() === '') {
    throw new CompareInvocationError('MODELS_MISSING', invocationMessage(`Informe ao menos um modelo usando ${MODELS_SYNTAX}.`));
  }

  const rawEntries = modelArg.slice('--models='.length).split(',');
  const entries = rawEntries.map((rawEntry) => parseEntry(rawEntry.trim()));
  const positional = argv.filter((arg) => !arg.startsWith('--models=') && arg !== '--models');
  const question = positional.join(' ').trim();
  if (positional.length > 0 && question === '') {
    throw new CompareInvocationError('QUESTION_EMPTY', invocationMessage('A pergunta ad-hoc não pode ser vazia.'));
  }

  return { entries, question: question === '' ? null : question };
}

function parseEntry(rawEntry: string): CompareEntry {
  if (rawEntry === '') {
    throw new CompareInvocationError('MODELS_INVALID', invocationMessage(`Entrada de modelo vazia; use ${MODELS_SYNTAX}.`));
  }

  const separator = rawEntry.indexOf(':');
  if (separator === -1) {
    if (rawEntry === 'anthropic') {
      return { provider: 'anthropic', model: 'claude-sonnet-5' };
    }
    throw new CompareInvocationError(
      'MODELS_INVALID',
      invocationMessage(`Entrada inválida "${rawEntry}"; use provider:modelo e providers anthropic|openrouter|openai.`),
    );
  }

  const provider = rawEntry.slice(0, separator).trim();
  const model = rawEntry.slice(separator + 1).trim();
  if (provider !== 'anthropic' && provider !== 'openrouter' && provider !== 'openai') {
    throw new CompareInvocationError(
      'MODELS_INVALID',
      invocationMessage(`Provider desconhecido "${provider}"; valores aceitos: anthropic|openrouter|openai.`),
    );
  }
  if (model === '') {
    throw new CompareInvocationError('MODELS_INVALID', invocationMessage(`Modelo vazio em "${rawEntry}"; use ${MODELS_SYNTAX}.`));
  }
  return { provider, model };
}

/** Executa a bancada em ordem, isolando cada entry e emitindo a tabela final. */
export async function runCompare(options: CompareOptions): Promise<CompareRow[]> {
  if (options.entries.length === 0) {
    throw new CompareInvocationError('MODELS_MISSING', invocationMessage(`Informe ao menos um modelo usando ${MODELS_SYNTAX}.`));
  }
  if (options.question !== null && options.question.trim() === '') {
    throw new CompareInvocationError('QUESTION_EMPTY', invocationMessage('A pergunta ad-hoc não pode ser vazia.'));
  }
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const env = options.env ?? process.env;
  const mode: CompareMode = options.question === null ? 'eval' : 'adhoc';
  const cases = mode === 'eval' ? await loadCases(options.casesDir ?? DEFAULT_CASES_DIR) : [];
  if (mode === 'eval' && cases.length === 0) {
    throw new CompareInvocationError('MODELS_INVALID', invocationMessage('Nenhum caso de eval foi encontrado.'));
  }

  const rows: CompareRow[] = [];
  const makeChatPort = options.chatPortFactory ?? createChatPort;
  const connectInvoker = options.invokerFactory ?? (() => McpToolInvoker.connect({ serverStderr: 'inherit' }));

  for (const [index, entry] of options.entries.entries()) {
    err(`→ [${index + 1}/${options.entries.length}] ${entry.provider}:${entry.model}`);
    const row = await runEntry(entry, {
      ...options,
      cases,
      env,
      mode,
      makeChatPort,
      connectInvoker,
      err,
    });
    rows.push(row);
  }

  out(renderCompareTable(rows, mode));
  return rows;
}

interface EntryRunContext {
  cases: Awaited<ReturnType<typeof loadCases>>;
  env: NodeJS.ProcessEnv;
  mode: CompareMode;
  makeChatPort: (config: LlmEngineConfig) => ChatPort;
  connectInvoker: () => Promise<CompareInvoker>;
  traceLogPath?: string;
  question: string | null;
  err: (line: string) => void;
}

async function runEntry(entry: CompareEntry, context: EntryRunContext): Promise<CompareRow> {
  let invoker: CompareInvoker | null = null;
  try {
    const config = resolveLlmEngineConfig(context.env, { provider: entry.provider, model: entry.model });
    const chat = context.makeChatPort(config);
    invoker = await context.connectInvoker();
    const assistant = new LlmInvestigationAssistant(
      chat,
      () => invoker?.listTools() ?? Promise.reject(new Error('MCP invoker indisponível')),
      config,
      buildSystemPrompt(),
    );

    if (context.mode === 'adhoc') {
      return await runAdhocEntry(entry, assistant, invoker, context);
    }
    return await runEvalEntry(entry, assistant, invoker, context);
  } catch (error) {
    const code = error instanceof LlmEngineError ? error.code : 'api_error';
    context.err(`  ${entry.provider}:${entry.model} — ${code}`);
    return failureRow(entry, code);
  } finally {
    if (invoker !== null) {
      await invoker.close().catch(() => {
        context.err(`  aviso: não foi possível fechar o invoker de ${entry.provider}:${entry.model}`);
      });
    }
  }
}

async function runEvalEntry(
  entry: CompareEntry,
  assistant: LlmInvestigationAssistant,
  invoker: CompareInvoker,
  context: EntryRunContext,
): Promise<CompareRow> {
  const scorer = new TextReportScorer();
  const caseResults: EvalCaseResult[] = [];
  const usage: LlmUsage = emptyUsage();
  const criteria = new Map<string, boolean>();
  const runId = generateRunId();

  for (const evalCase of context.cases) {
    context.err(`  caso ${evalCase.id}`);
    const outcome = await assistant.investigate(evalCase.question, invoker);
    if (outcome.kind !== 'markdown') {
      throw new LlmEngineError('empty_response', `o caso ${evalCase.id} não produziu um relatório textual.`);
    }
    const result = scorer.score(evalCase, outcome.markdown);
    caseResults.push(result);
    mergeUsage(usage, assistant.lastUsage);
    for (const criterion of result.criteria) {
      criteria.set(criterion.name, (criteria.get(criterion.name) ?? true) && criterion.passed);
    }
    await writeCompareTrace(context, {
      runId,
      entry,
      evalCaseId: evalCase.id,
      question: evalCase.question,
      outcome,
      assistant,
      evalResult: result,
    });
  }

  const score = roundToTwo(caseResults.reduce((sum, result) => sum + result.score, 0) / caseResults.length);
  return {
    provider: entry.provider,
    model: entry.model,
    status: 'ok',
    score,
    criteria: [...criteria.entries()].map(([name, passed]) => ({ name, passed })),
    completed: null,
    rounds: usage.rounds,
    usage,
  };
}

async function runAdhocEntry(
  entry: CompareEntry,
  assistant: LlmInvestigationAssistant,
  invoker: CompareInvoker,
  context: EntryRunContext,
): Promise<CompareRow> {
  const question = context.question as string;
  context.err('  pergunta ad-hoc');
  const outcome = await assistant.investigate(question, invoker);
  const usage = assistant.lastUsage;
  await writeCompareTrace(context, {
    runId: generateRunId(),
    entry,
    evalCaseId: null,
    question,
    outcome,
    assistant,
    evalResult: null,
  });
  return {
    provider: entry.provider,
    model: entry.model,
    status: 'ok',
    score: null,
    criteria: null,
    completed: outcome.kind === 'markdown',
    rounds: usage?.rounds ?? 0,
    usage,
  };
}

interface TraceContext {
  runId: string;
  entry: CompareEntry;
  evalCaseId: string | null;
  question: string;
  outcome: InvestigationOutcome;
  assistant: LlmInvestigationAssistant;
  evalResult: EvalCaseResult | null;
}

async function writeCompareTrace(context: EntryRunContext, trace: TraceContext): Promise<void> {
  if (context.traceLogPath === undefined) return;
  try {
    await appendTraceRecord(
      context.traceLogPath,
      buildTraceRecord({
        source: 'compare',
        runId: trace.runId,
        caseId: trace.evalCaseId,
        question: trace.question,
        engine: 'llm',
        model: trace.entry.model,
        provider: trace.entry.provider,
        outcome: trace.outcome,
        rounds: trace.assistant.lastTrace,
        usage: trace.assistant.lastUsage,
        evalResult: trace.evalResult,
      }),
    );
  } catch (error) {
    context.err(`  aviso: falha ao gravar trace de ${trace.entry.provider}:${trace.entry.model}: ${errorMessage(error)}`);
  }
}

function emptyUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 0 };
}

function mergeUsage(target: LlmUsage, source: LlmUsage | null): void {
  if (source === null) return;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.rounds += source.rounds;
}

function failureRow(entry: CompareEntry, status: LlmEngineErrorCode): CompareRow {
  return {
    provider: entry.provider,
    model: entry.model,
    status,
    score: null,
    criteria: null,
    completed: null,
    rounds: 0,
    usage: null,
  };
}

/** Renderização pura: nenhum I/O, cor ou ranking implícito. */
export function renderCompareTable(rows: CompareRow[], mode: CompareMode): string {
  const criteria = mode === 'eval'
    ? [...new Set(rows.flatMap((row) => row.criteria?.map((criterion) => criterion.name) ?? []))]
    : [];
  const headers = mode === 'eval'
    ? ['Modelo', 'Provider', 'Score', ...criteria, 'Rodadas', 'Tokens (in/out)', 'Cache (r/w)', 'Status']
    : ['Modelo', 'Provider', 'Concluiu', 'Rodadas', 'Tokens (in/out)', 'Cache (r/w)', 'Status'];
  const lines = [
    mode === 'eval'
      ? '## Comparação (eval) — uma execução por modelo'
      : '## Comparação de recursos (ad-hoc) — sem score de qualidade',
    '',
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => renderRow(row, mode, criteria)),
    '',
    `Total: ${formatTokenCount(totalTokens(rows))} tokens · evidência de 1 execução por modelo (não é garantia estatística)`,
  ];
  return stripAnsi(lines.join('\n'));
}

function renderRow(row: CompareRow, mode: CompareMode, criteria: string[]): string {
  const failed = row.status !== 'ok';
  if (mode === 'eval') {
    const cells = [
      row.model,
      row.provider,
      failed ? '—' : row.score?.toFixed(2) ?? '—',
      ...criteria.map((name) => failed ? '—' : row.criteria?.find((criterion) => criterion.name === name)?.passed ? 'OK' : 'FALHOU'),
      failed ? '—' : String(row.rounds),
      failed ? '—' : formatUsage(row.usage),
      failed ? '—' : formatCache(row.usage),
      row.status,
    ];
    return `| ${cells.join(' | ')} |`;
  }
  const cells = [
    row.model,
    row.provider,
    failed ? '—' : row.completed === true ? 'sim' : 'não',
    failed ? '—' : String(row.rounds),
    failed ? '—' : formatUsage(row.usage),
    failed ? '—' : formatCache(row.usage),
    row.status,
  ];
  return `| ${cells.join(' | ')} |`;
}

function formatUsage(usage: LlmUsage | null): string {
  return usage === null ? '—' : `${formatTokenCount(usage.inputTokens)}/${formatTokenCount(usage.outputTokens)}`;
}

function formatCache(usage: LlmUsage | null): string {
  return usage === null
    ? '—'
    : `${formatTokenCount(usage.cacheReadTokens)}/${formatTokenCount(usage.cacheCreationTokens)}`;
}

function totalTokens(rows: CompareRow[]): number {
  return rows.reduce((total, row) => {
    if (row.status !== 'ok' || row.usage === null) return total;
    return total + row.usage.inputTokens + row.usage.outputTokens + row.usage.cacheReadTokens + row.usage.cacheCreationTokens;
  }, 0);
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/* c8 ignore start — composition root is covered by the CLI E2E contract. */
if (invokedDirectly) {
  let parsed: { entries: CompareEntry[]; question: string | null } | null = null;
  try {
    parsed = parseCompareArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
  if (parsed !== null) {
    runCompare({ ...parsed, traceLogPath: process.env['AGENTOPS_TRACE_LOG'] }).then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        process.stderr.write(`A comparação falhou: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  }
}
/* c8 ignore stop */
