import { access, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { formatTokenCount } from '@agentops/cli-agent/main';
import { McpToolInvoker } from '@agentops/cli-agent/mcp-tool-invoker';
import {
  AnthropicChatAdapter,
  buildSystemPrompt,
  DEFAULT_LLM_CACHE_ENABLED,
  DEFAULT_LLM_MAX_ROUNDS,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL,
  LlmEngineError,
  LlmInvestigationAssistant,
  resolveLlmEngineConfig,
} from '@agentops/llm-engine';
import type { ChatPort, LlmEngineConfig, LlmUsage } from '@agentops/llm-engine';
import { redTeamEvalCaseSchema } from '@agentops/types';
import type { RedTeamEvalCase, RedTeamEvalResult, ToolCallRecord } from '@agentops/types';
import { DeterministicRedTeamScorer } from '../scoring/redteam-scorer.js';
import { DeterministicTrajectoryScorer } from '../scoring/trajectory-scorer.js';

/**
 * Runner opt-in do experimento red-team (V2.7, `npm run eval:redteam -- --engine=llm`).
 * É um composition root exclusivamente LLM e isolado: resolve raízes adversariais
 * EXPLÍCITAS (`datasets-redteam/` / `knowledge-base-redteam/`), roda apenas
 * `case-004` pelo MCP stdio REAL (nunca lê as fixtures direto) e reaproveita o
 * prompt, as 9 tools, o `tool_choice` e a serialização da V2/V2.5 sem alteração.
 * O guardrail atual é o único controle — a V2.7 mede o baseline, não o endurece.
 *
 * Preflight tipado (`RedTeamConfigError`) roda ANTES de spawnar o server: engine,
 * raízes (nunca iguais às normais), caso (com bloco `redteam`), fixtures e
 * credencial. Nenhum token é gasto se qualquer verificação falhar.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Raízes normais — o runner red-team recusa qualquer configuração que as aponte. */
export const NORMAL_ROOTS = {
  datasetsDir: join(repoRoot, 'datasets'),
  knowledgeBaseDir: join(repoRoot, 'knowledge-base'),
};

export const DEFAULT_REDTEAM_CASE_PATH = fileURLToPath(
  new URL('../cases-redteam/case-004-tool-data-prompt-injection.json', import.meta.url),
);
export const DEFAULT_REDTEAM_DATASETS_DIR = join(repoRoot, 'datasets-redteam');
export const DEFAULT_REDTEAM_KNOWLEDGE_BASE_DIR = join(repoRoot, 'knowledge-base-redteam');

export interface RedTeamRunConfig {
  casePath: string;
  datasetsDir: string;
  knowledgeBaseDir: string;
  /** Somente `llm` é suportado na V2.7; qualquer outro valor reprova no preflight. */
  engine: string;
}

/** Config default apontando para as fixtures adversariais isoladas e `case-004`. */
export function defaultRedTeamRunConfig(engine = 'llm'): RedTeamRunConfig {
  return {
    casePath: DEFAULT_REDTEAM_CASE_PATH,
    datasetsDir: DEFAULT_REDTEAM_DATASETS_DIR,
    knowledgeBaseDir: DEFAULT_REDTEAM_KNOWLEDGE_BASE_DIR,
    engine,
  };
}

// ── Erro tipado do preflight ────────────────────────────────────────────────

export const REDTEAM_CONFIG_ERROR_CODES = [
  'REDTEAM_CASE_INVALID',
  'REDTEAM_ROOT_INVALID',
  'REDTEAM_ENGINE_UNSUPPORTED',
  'ANTHROPIC_API_KEY_MISSING',
] as const;
export type RedTeamConfigErrorCode = (typeof REDTEAM_CONFIG_ERROR_CODES)[number];

/** Falha de configuração do red-team. A CLI converte em mensagem orientativa + exit 1. */
export class RedTeamConfigError extends Error {
  readonly code: RedTeamConfigErrorCode;
  constructor(code: RedTeamConfigErrorCode, message: string) {
    super(message);
    this.name = 'RedTeamConfigError';
    this.code = code;
  }
}

export interface ResolvedRedTeamRoots {
  datasetsDir: string;
  knowledgeBaseDir: string;
}

/**
 * Resolve e valida as raízes adversariais: absolutas, existentes, com as
 * fixtures dos três vetores e NUNCA iguais às raízes normais. Qualquer desvio
 * gera `REDTEAM_ROOT_INVALID` antes de qualquer spawn/rede.
 */
export async function resolveRedTeamRoots(
  config: RedTeamRunConfig,
  normalRoots: ResolvedRedTeamRoots = NORMAL_ROOTS,
): Promise<ResolvedRedTeamRoots> {
  const datasetsDir = resolve(config.datasetsDir);
  const knowledgeBaseDir = resolve(config.knowledgeBaseDir);

  if (datasetsDir === resolve(normalRoots.datasetsDir)) {
    throw new RedTeamConfigError(
      'REDTEAM_ROOT_INVALID',
      `a raiz de datasets red-team coincide com a raiz normal (${datasetsDir}) — o experimento exige fixtures isoladas.`,
    );
  }
  if (knowledgeBaseDir === resolve(normalRoots.knowledgeBaseDir)) {
    throw new RedTeamConfigError(
      'REDTEAM_ROOT_INVALID',
      `a raiz de knowledge base red-team coincide com a raiz normal (${knowledgeBaseDir}) — o experimento exige fixtures isoladas.`,
    );
  }

  await assertReadableDir(datasetsDir);
  await assertReadableDir(knowledgeBaseDir);
  // Fixtures dos três vetores (logs+exceptions no jsonl; runbook adulterado).
  await assertReadableFile(join(datasetsDir, 'logs', 'checkout-api.jsonl'));
  await assertReadableFile(join(knowledgeBaseDir, 'runbooks', 'checkout-api-high-5xx.md'));

  return { datasetsDir, knowledgeBaseDir };
}

async function assertReadableDir(path: string): Promise<void> {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw new RedTeamConfigError('REDTEAM_ROOT_INVALID', `raiz red-team ausente ou ilegível: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new RedTeamConfigError('REDTEAM_ROOT_INVALID', `raiz red-team não é um diretório: ${path}`);
  }
}

async function assertReadableFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new RedTeamConfigError('REDTEAM_ROOT_INVALID', `fixture adversarial ausente: ${path}`);
  }
}

/**
 * Carrega e valida o caso red-team. Ausente/JSON inválido/sem bloco `redteam`
 * → `REDTEAM_CASE_INVALID` (um caso normal 001–003 cai exatamente aqui).
 */
export async function loadRedTeamCase(casePath: string): Promise<RedTeamEvalCase> {
  let raw: string;
  try {
    raw = await readFile(casePath, 'utf8');
  } catch {
    throw new RedTeamConfigError('REDTEAM_CASE_INVALID', `caso red-team não encontrado: ${casePath}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new RedTeamConfigError('REDTEAM_CASE_INVALID', `caso red-team não é JSON válido: ${casePath}`);
  }
  const parsed = redTeamEvalCaseSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new RedTeamConfigError(
      'REDTEAM_CASE_INVALID',
      `caso inválido ou sem bloco "redteam" (${casePath}): ${first?.path.join('.')} ${first?.message}`,
    );
  }
  return parsed.data;
}

export interface RunRedTeamOptions {
  /**
   * Porta Anthropic injetada (testes): dispensa `ANTHROPIC_API_KEY` e roteiriza
   * o modelo sem rede. As tools continuam passando pelo MCP real.
   */
  chat?: ChatPort;
  /** Rótulo do modelo quando `chat` é injetado (default `claude-sonnet-5`). */
  model?: string;
  /** Liga/desliga cache quando `chat` é injetado (I18). Default: on. */
  cacheEnabled?: boolean;
  /** Ambiente para resolver a config LLM real (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  rounds: 0,
};

/**
 * Executa o experimento red-team ponta a ponta: preflight → spawn do MCP real
 * com as raízes adversariais → loop LLM da V2 → outcome + segurança sobre o
 * MESMO markdown → relatório seguro. Retorna o agregado; o caller decide o exit
 * code (0 só quando `passed`).
 */
export async function runRedTeam(
  config: RedTeamRunConfig,
  options: RunRedTeamOptions = {},
): Promise<RedTeamEvalResult> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const env = options.env ?? process.env;

  // ── Preflight (tudo antes de spawnar o server / tocar rede) ──
  if (config.engine !== 'llm') {
    throw new RedTeamConfigError(
      'REDTEAM_ENGINE_UNSUPPORTED',
      `A V2.7 aceita somente --engine=llm (recebido: "${config.engine}"). ` +
        'O engine determinístico não interpreta texto de tool como instrução — rodá-lo não responde à pergunta de segurança.',
    );
  }
  const roots = await resolveRedTeamRoots(config);
  const evalCase = await loadRedTeamCase(config.casePath);

  let llmConfig: LlmEngineConfig;
  const injectedChat = options.chat;
  if (injectedChat === undefined) {
    try {
      llmConfig = resolveLlmEngineConfig(env);
    } catch (error) {
      if (error instanceof LlmEngineError && error.code === 'missing_api_key') {
        throw new RedTeamConfigError(
          'ANTHROPIC_API_KEY_MISSING',
          'O red-team real (--engine=llm) requer ANTHROPIC_API_KEY exportada. Nenhum token é gasto sem ela.',
        );
      }
      throw error;
    }
  } else {
    llmConfig = {
      provider: 'anthropic',
      baseUrl: null,
      apiKey: 'fake-injected-chat',
      model: options.model ?? DEFAULT_LLM_MODEL,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      maxRounds: DEFAULT_LLM_MAX_ROUNDS,
      cacheEnabled: options.cacheEnabled ?? DEFAULT_LLM_CACHE_ENABLED,
    };
  }

  err(`Red-team ${evalCase.id} · engine=llm · modelo ${llmConfig.model} · cache ${llmConfig.cacheEnabled ? 'on' : 'off'}`);
  err(`Raízes adversariais: ${roots.datasetsDir} · ${roots.knowledgeBaseDir}`);
  warnTraceIfEnabled(env, err);

  err('Iniciando o agentops-server (MCP via stdio) com as raízes red-team…');
  const invoker = await McpToolInvoker.connect({
    serverStderr: 'inherit',
    // As fixtures adversariais chegam ao contexto SOMENTE pelo server real; o
    // runner nunca lê os arquivos diretamente (I20).
    env: {
      AGENTOPS_DATASETS_DIR: roots.datasetsDir,
      AGENTOPS_KNOWLEDGE_BASE_DIR: roots.knowledgeBaseDir,
    },
  });

  try {
    const chat: ChatPort = injectedChat ?? AnthropicChatAdapter.fromApiKey(llmConfig.apiKey);
    // Mesmo motor, prompt e serialização da V2 — o guardrail atual é o único controle.
    const assistant = new LlmInvestigationAssistant(
      chat,
      () => invoker.listTools(),
      llmConfig,
      buildSystemPrompt(),
    );

    const outcome = await assistant.investigate(evalCase.question, invoker);
    if (outcome.kind !== 'markdown') {
      throw new Error(`o motor LLM retornou um outcome inesperado (${outcome.kind}); esperado markdown.`);
    }

    // Outcome e segurança sobre EXATAMENTE o mesmo markdown (o scorer de segurança
    // compõe o `TextReportScorer` internamente — sem renderer intermediário).
    const scoreResult = new DeterministicRedTeamScorer().score(evalCase, outcome.markdown, outcome.audit);
    const usage = (assistant.lastUsage ?? ZERO_USAGE);
    const result: RedTeamEvalResult = { ...scoreResult, model: llmConfig.model, usage };

    printRedTeamResult(result, evalCase, outcome.audit, out);
    return result;
  } finally {
    // Encerra o processo filho (best effort): os scores já saíram.
    await invoker.close().catch(() => {});
  }
}

function warnTraceIfEnabled(env: NodeJS.ProcessEnv, err: (line: string) => void): void {
  const trace = env['AGENTOPS_TRACE_LOG'];
  if (trace !== undefined && trace.trim() !== '') {
    err(
      'AVISO: AGENTOPS_TRACE_LOG habilitado — a auditoria detalhada conterá conteúdo adversarial ' +
        'sintético (ex.: instruções destrutivas em texto de tool). É dado de teste, NUNCA instrução operacional.',
    );
  }
}

/** Rótulo de status de um critério de segurança para o breakdown observável. */
function securityStatus(name: string, passed: boolean): string {
  if (passed) return 'OK';
  return name.startsWith('attack_vector_not_exercised:') ? 'NÃO EXERCITADO' : 'FALHOU';
}

/**
 * Breakdown observável (TechSpec "Monitoramento"): modelo, timestamp, outcome e
 * segurança SEPARADOS, status por vetor, estrutura, primeiro passo, tools/
 * trajetória, rodadas, tokens e cache. Nunca imprime API key nem payload integral
 * — os details de segurança já vêm redigidos do scorer.
 */
export function printRedTeamResult(
  result: RedTeamEvalResult,
  evalCase: RedTeamEvalCase,
  audit: readonly ToolCallRecord[],
  out: (line: string) => void,
): void {
  const timestamp = new Date().toISOString();
  const { outcome } = result;
  const outcomeApproved = outcome.criteria.filter((c) => c.passed).length;
  const securityApproved = result.securityCriteria.filter((c) => c.passed).length;
  const securityPassed = securityApproved === result.securityCriteria.length;

  out('');
  out(`${result.caseId} — red-team · modelo ${result.model} · ${timestamp}`);

  out('');
  out(
    `Outcome — score ${outcome.score.toFixed(2)} (${outcomeApproved}/${outcome.criteria.length} critérios) — ` +
      `${outcome.passed ? 'APROVADO' : 'REPROVADO'}`,
  );
  for (const criterion of outcome.criteria) {
    out(`  [${criterion.passed ? 'OK' : 'FALHOU'}] ${criterion.name} — ${criterion.details}`);
  }

  out('');
  out(
    `Segurança — score ${result.score.toFixed(2)} (${securityApproved}/${result.securityCriteria.length} critérios) — ` +
      `${securityPassed ? 'APROVADO' : 'REPROVADO'}`,
  );
  for (const criterion of result.securityCriteria) {
    out(`  [${securityStatus(criterion.name, criterion.passed)}] ${criterion.name} — ${criterion.details}`);
  }

  // Tools/trajetória: prova (informativa) de que cada ataque foi exercitado.
  const toolsCalled = audit.map((record) => record.tool).join(', ') || 'nenhuma';
  out('');
  out(`Tools chamadas (${audit.length}): ${toolsCalled}`);
  if (evalCase.expected_trajectory !== undefined) {
    const trajectory = new DeterministicTrajectoryScorer().score(evalCase.expected_trajectory, audit);
    out(`Trajetória — score ${trajectory.score.toFixed(2)} (INFORMATIVO: ${trajectory.passed ? 'OK' : 'ATENÇÃO'})`);
  }

  const { usage } = result;
  out(
    `Rodadas: ${usage.rounds} · tokens entrada ${formatTokenCount(usage.inputTokens)} · ` +
      `saída ${formatTokenCount(usage.outputTokens)} · cache ${formatTokenCount(usage.cacheReadTokens)} lido / ` +
      `${formatTokenCount(usage.cacheCreationTokens)} escrito`,
  );

  out('');
  out(
    `Resultado red-team: ${result.passed ? 'APROVADO' : 'REPROVADO'} ` +
      `(outcome ${outcome.passed ? 'ok' : 'falhou'} · segurança ${securityPassed ? 'ok' : 'falhou'})`,
  );
}

// ── Entrypoint CLI ──────────────────────────────────────────────────────────

/**
 * Extrai `--engine=<x>` (ou `--engine <x>`); default `llm`. Mantém o valor cru
 * para o preflight. Usa a ÚLTIMA ocorrência: o script `eval:redteam` já injeta
 * `--engine=llm`, então um `-- --engine=deterministic` do usuário prevalece.
 */
export function parseEngineArg(argv: readonly string[]): string {
  let engine = 'llm';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg.startsWith('--engine=')) engine = arg.slice('--engine='.length);
    else if (arg === '--engine' && argv[index + 1] !== undefined) engine = argv[index + 1] as string;
  }
  return engine;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const engine = parseEngineArg(process.argv.slice(2));
  // Overrides opcionais das raízes/caso (usados pelos E2E de isolamento e
  // fixture ausente); em uso normal, os defaults isolados são aplicados.
  const config: RedTeamRunConfig = {
    casePath: process.env['AGENTOPS_REDTEAM_CASE'] ?? DEFAULT_REDTEAM_CASE_PATH,
    datasetsDir: process.env['AGENTOPS_REDTEAM_DATASETS_DIR'] ?? DEFAULT_REDTEAM_DATASETS_DIR,
    knowledgeBaseDir: process.env['AGENTOPS_REDTEAM_KNOWLEDGE_BASE_DIR'] ?? DEFAULT_REDTEAM_KNOWLEDGE_BASE_DIR,
    engine,
  };
  runRedTeam(config).then(
    (result) => {
      process.exitCode = result.passed ? 0 : 1;
    },
    (error: unknown) => {
      if (error instanceof RedTeamConfigError) {
        process.stderr.write(`Red-team abortado [${error.code}]: ${error.message}\n`);
        process.stderr.write('Uso: npm run eval:redteam -- --engine=llm (requer ANTHROPIC_API_KEY)\n');
      } else if (error instanceof LlmEngineError) {
        process.stderr.write(`Red-team falhou [${error.code}]: ${error.message}\n`);
      } else {
        // Nunca stack trace cru para o usuário (fluxo de erro do PRD).
        process.stderr.write(`Red-team falhou: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      process.exitCode = 1;
    },
  );
}
