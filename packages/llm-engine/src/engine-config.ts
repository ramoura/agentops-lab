import type { ToolCallRecord } from '@agentops/types';

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
  apiKey: string;
  model: string;
  maxTokens: number;
  maxRounds: number;
}

export const DEFAULT_LLM_MODEL = 'claude-sonnet-5';
export const DEFAULT_LLM_MAX_TOKENS = 4096;
export const DEFAULT_LLM_MAX_ROUNDS = 16;

/**
 * Resolve a config de `ANTHROPIC_API_KEY`, `AGENTOPS_LLM_MODEL`,
 * `AGENTOPS_LLM_MAX_TOKENS` e `AGENTOPS_LLM_MAX_ROUNDS`, aplicando defaults e
 * validando antes de tocar rede. Campos ausentes viram defaults explícitos —
 * nunca `undefined` silencioso.
 */
export function resolveLlmEngineConfig(env: NodeJS.ProcessEnv = process.env): LlmEngineConfig {
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new LlmEngineError(
      'missing_api_key',
      'O modo --engine=llm requer a variável ANTHROPIC_API_KEY. ' +
        'Exporte a chave (export ANTHROPIC_API_KEY=...) ou use o motor default (determinístico), ' +
        'que não precisa de chave: npm run investigate -- "<pergunta>"',
    );
  }

  const model = env['AGENTOPS_LLM_MODEL']?.trim() || DEFAULT_LLM_MODEL;

  return {
    apiKey,
    model,
    maxTokens: resolvePositiveInt(env, 'AGENTOPS_LLM_MAX_TOKENS', DEFAULT_LLM_MAX_TOKENS),
    maxRounds: resolvePositiveInt(env, 'AGENTOPS_LLM_MAX_ROUNDS', DEFAULT_LLM_MAX_ROUNDS),
  };
}

/** Inteiro > 0 de uma env, com default; valor inválido → erro orientativo. */
function resolvePositiveInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new LlmEngineError(
      'invalid_config',
      `${name} deve ser um número inteiro maior que zero (recebido: "${raw}"). ` +
        `Remova a variável para usar o default (${defaultValue}).`,
    );
  }
  return value;
}
