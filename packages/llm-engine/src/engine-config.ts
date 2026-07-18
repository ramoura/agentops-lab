import { llmProviderSchema } from '@agentops/types';
import type { LlmProvider, ToolCallRecord } from '@agentops/types';

/**
 * Resolução de configuração do motor LLM por variáveis de ambiente e o
 * envelope de erro tipado `LlmEngineError`. Valores inválidos geram erro
 * orientativo ANTES de qualquer chamada de rede; a `ANTHROPIC_API_KEY`
 * jamais aparece em mensagens de erro ou logs.
 */

/**
 * Códigos de erro do motor LLM: os 5 da techspec (fluxos de execução) +
 * `invalid_config` para falhas de inicialização (env inválida, skill.md
 * ausente, contrato de tools incompleto), previstas na techspec como
 * "erro orientativo antes de qualquer chamada de rede".
 */
export const LLM_ENGINE_ERROR_CODES = [
  'missing_api_key',
  'max_rounds_exceeded',
  'max_tokens_reached',
  'api_error',
  'empty_response',
  'invalid_config',
] as const;
export type LlmEngineErrorCode = (typeof LLM_ENGINE_ERROR_CODES)[number];

/**
 * Erro tipado do motor LLM. A CLI converte `code` em mensagem orientativa e
 * exit code 1 — nunca stack trace cru. Em `max_rounds_exceeded`, `audit`
 * preserva o registro das rodadas já executadas para diagnóstico.
 */
export class LlmEngineError extends Error {
  readonly code: LlmEngineErrorCode;
  readonly audit: ToolCallRecord[];

  constructor(
    code: LlmEngineErrorCode,
    message: string,
    options: { cause?: unknown; audit?: ToolCallRecord[] } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LlmEngineError';
    this.code = code;
    this.audit = options.audit ?? [];
  }
}

/**
 * Configuração resolvida do motor LLM (uma única vez, a partir do ambiente).
 * Sem parâmetros de sampling: `temperature`/`top_p`/`top_k` foram removidos
 * da Messages API nos modelos atuais (claude-sonnet-5+) — enviar qualquer um
 * retorna 400 `invalid_request_error`.
 */
export interface LlmEngineConfig {
  provider: LlmProvider;
  baseUrl: string | null;
  apiKey: string;
  model: string;
  maxTokens: number;
  maxRounds: number;
  cacheEnabled: boolean;
}

export const DEFAULT_LLM_MODEL = 'claude-sonnet-5';
export const DEFAULT_LLM_MAX_TOKENS = 4096;
export const DEFAULT_LLM_MAX_ROUNDS = 16;
export const DEFAULT_LLM_CACHE_ENABLED = true;
export const DEFAULT_LLM_BASE_URLS: Record<LlmProvider, string | null> = {
  anthropic: null,
  openrouter: 'https://openrouter.ai/api/v1',
  openai: null,
};

const API_KEY_ENV_BY_PROVIDER: Record<LlmProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export interface LlmEngineConfigOverrides {
  provider?: LlmProvider;
  model?: string;
}

/**
 * Resolve a config do provider selecionado, `AGENTOPS_LLM_MODEL`,
 * `AGENTOPS_LLM_MAX_TOKENS`, `AGENTOPS_LLM_MAX_ROUNDS` e
 * `AGENTOPS_LLM_CACHE`, aplicando defaults e validando antes de tocar rede.
 * Campos ausentes viram defaults explícitos — nunca `undefined` silencioso.
 */
export function resolveLlmEngineConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: LlmEngineConfigOverrides = {},
): LlmEngineConfig {
  const provider = resolveProvider(overrides.provider ?? env['AGENTOPS_LLM_PROVIDER']);
  const rawModel = overrides.model ?? env['AGENTOPS_LLM_MODEL'];
  const model = rawModel?.trim() || (provider === 'anthropic' ? DEFAULT_LLM_MODEL : null);
  if (model === null) {
    throw new LlmEngineError(
      'invalid_config',
      'AGENTOPS_LLM_MODEL é obrigatório para providers diferentes de anthropic; ' +
        'não há default de modelo fora do Anthropic. Defina a variável ou informe um override de model.',
    );
  }

  const apiKeyName = API_KEY_ENV_BY_PROVIDER[provider];
  const apiKey = env[apiKeyName];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new LlmEngineError(
      'missing_api_key',
      provider === 'anthropic'
        ? 'O modo --engine=llm requer a variável ANTHROPIC_API_KEY. ' +
          'Exporte a chave (export ANTHROPIC_API_KEY=...) ou use o motor default (determinístico), ' +
          'que não precisa de chave: npm run investigate -- "<pergunta>"'
        : `O modo --engine=llm com provider ${provider} requer a variável ${apiKeyName}. ` +
          `Exporte a chave (export ${apiKeyName}=...) ou use o motor default (determinístico), ` +
          'que não precisa de chave: npm run investigate -- "<pergunta>"',
    );
  }

  const configuredBaseUrl = env['AGENTOPS_LLM_BASE_URL']?.trim();

  return {
    provider,
    baseUrl: configuredBaseUrl === undefined || configuredBaseUrl === '' ? DEFAULT_LLM_BASE_URLS[provider] : configuredBaseUrl,
    apiKey,
    model,
    maxTokens: resolvePositiveInt(env, 'AGENTOPS_LLM_MAX_TOKENS', DEFAULT_LLM_MAX_TOKENS, apiKey),
    maxRounds: resolvePositiveInt(env, 'AGENTOPS_LLM_MAX_ROUNDS', DEFAULT_LLM_MAX_ROUNDS, apiKey),
    cacheEnabled: resolveCacheEnabled(env, apiKey),
  };
}

function resolveProvider(raw: string | undefined): LlmProvider {
  const value = raw?.trim() || 'anthropic';
  const result = llmProviderSchema.safeParse(value);
  if (!result.success) {
    throw new LlmEngineError(
      'invalid_config',
      `AGENTOPS_LLM_PROVIDER deve ser um dos valores aceitos: anthropic|openrouter|openai. ` +
        'Remova a variável para usar o default (anthropic).',
    );
  }
  return result.data;
}

/**
 * Liga/desliga do prompt caching por `AGENTOPS_LLM_CACHE` (default ligado).
 * `on|true|1` → ligado; `off|false|0` → desligado (case-insensitive);
 * qualquer outro valor → erro orientativo.
 */
function resolveCacheEnabled(env: NodeJS.ProcessEnv, secret: string): boolean {
  const raw = env['AGENTOPS_LLM_CACHE'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_LLM_CACHE_ENABLED;
  }
  const value = raw.trim().toLowerCase();
  if (value === 'on' || value === 'true' || value === '1') {
    return true;
  }
  if (value === 'off' || value === 'false' || value === '0') {
    return false;
  }
  throw new LlmEngineError(
    'invalid_config',
    `AGENTOPS_LLM_CACHE aceita on|true|1 (liga) ou off|false|0 (desliga) — recebido: "${redact(raw, secret)}". ` +
      'Remova a variável para usar o default (on, prompt caching ligado).',
  );
}

/** Inteiro > 0 de uma env, com default; valor inválido → erro orientativo. */
function resolvePositiveInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number, secret: string): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new LlmEngineError(
      'invalid_config',
      `${name} deve ser um número inteiro maior que zero (recebido: "${redact(raw, secret)}"). ` +
        `Remova a variável para usar o default (${defaultValue}).`,
    );
  }
  return value;
}

function redact(value: string, secret: string): string {
  return value === secret ? '<redacted>' : value;
}
