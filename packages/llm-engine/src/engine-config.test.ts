import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_CACHE_ENABLED,
  DEFAULT_LLM_MAX_ROUNDS,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL,
  LlmEngineError,
  resolveLlmEngineConfig,
} from './engine-config.js';

// ---------------------------------------------------------------------------
// Test cases 17–18 da techspec V2 (config e prompt)
// ---------------------------------------------------------------------------

describe('resolveLlmEngineConfig', () => {
  // Teste 17
  it('ANTHROPIC_API_KEY ausente → LlmEngineError(missing_api_key) orientativo, sem tocar rede', () => {
    expect.assertions(3);
    try {
      resolveLlmEngineConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(LlmEngineError);
      expect((error as LlmEngineError).code).toBe('missing_api_key');
      expect((error as LlmEngineError).message).toContain('export ANTHROPIC_API_KEY');
    }
  });

  it('ANTHROPIC_API_KEY vazia ou só espaços → missing_api_key', () => {
    for (const value of ['', '   ']) {
      expect(() => resolveLlmEngineConfig({ ANTHROPIC_API_KEY: value })).toThrowError(
        expect.objectContaining({ code: 'missing_api_key' }),
      );
    }
  });

  // Teste 18 — defaults
  it('aplica os defaults da techspec (claude-sonnet-5, 4096, 16)', () => {
    const config = resolveLlmEngineConfig({ ANTHROPIC_API_KEY: 'sk-ant-teste' });
    expect(config).toEqual({
      apiKey: 'sk-ant-teste',
      model: DEFAULT_LLM_MODEL,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      maxRounds: DEFAULT_LLM_MAX_ROUNDS,
      cacheEnabled: DEFAULT_LLM_CACHE_ENABLED,
    });
    expect(config.model).toBe('claude-sonnet-5');
    expect(config.maxTokens).toBe(4096);
    expect(config.maxRounds).toBe(16);
  });

  // Teste 18 — overrides por env
  it('respeita overrides por env (modelo, max tokens e max rounds)', () => {
    const config = resolveLlmEngineConfig({
      ANTHROPIC_API_KEY: 'sk-ant-teste',
      AGENTOPS_LLM_MODEL: 'claude-opus-4-8',
      AGENTOPS_LLM_MAX_TOKENS: '8192',
      AGENTOPS_LLM_MAX_ROUNDS: '4',
    });
    expect(config.model).toBe('claude-opus-4-8');
    expect(config.maxTokens).toBe(8192);
    expect(config.maxRounds).toBe(4);
  });

  // Teste 18 — valores inválidos
  it.each(['abc', '0', '-5', '2.5'])(
    'AGENTOPS_LLM_MAX_TOKENS=%s → erro orientativo (invalid_config) citando a variável e o default',
    (value) => {
      expect.assertions(4);
      try {
        resolveLlmEngineConfig({ ANTHROPIC_API_KEY: 'sk-ant-teste', AGENTOPS_LLM_MAX_TOKENS: value });
      } catch (error) {
        expect(error).toBeInstanceOf(LlmEngineError);
        expect((error as LlmEngineError).code).toBe('invalid_config');
        expect((error as LlmEngineError).message).toContain('AGENTOPS_LLM_MAX_TOKENS');
        expect((error as LlmEngineError).message).toContain('4096');
      }
    },
  );

  it.each(['abc', '0', '-1'])('AGENTOPS_LLM_MAX_ROUNDS=%s → erro orientativo (invalid_config)', (value) => {
    expect(() =>
      resolveLlmEngineConfig({ ANTHROPIC_API_KEY: 'sk-ant-teste', AGENTOPS_LLM_MAX_ROUNDS: value }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_config' }));
  });

  // ---------------------------------------------------------------------------
  // Test cases 1–4 da techspec V2.5 (AGENTOPS_LLM_CACHE)
  // ---------------------------------------------------------------------------

  // Teste 1
  it.each([undefined, '', '   '])('AGENTOPS_LLM_CACHE ausente/vazia (%j) → cacheEnabled: true (default ligado)', (value) => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-ant-teste' };
    if (value !== undefined) {
      env['AGENTOPS_LLM_CACHE'] = value;
    }
    expect(resolveLlmEngineConfig(env).cacheEnabled).toBe(true);
    expect(DEFAULT_LLM_CACHE_ENABLED).toBe(true);
  });

  // Teste 2 — liga/desliga explícito, case-insensitive
  it.each(['on', 'true', '1', 'ON', 'True'])('AGENTOPS_LLM_CACHE=%s → cacheEnabled: true', (value) => {
    expect(
      resolveLlmEngineConfig({ ANTHROPIC_API_KEY: 'sk-ant-teste', AGENTOPS_LLM_CACHE: value }).cacheEnabled,
    ).toBe(true);
  });

  it.each(['off', 'false', '0', 'OFF', 'False'])('AGENTOPS_LLM_CACHE=%s → cacheEnabled: false', (value) => {
    expect(
      resolveLlmEngineConfig({ ANTHROPIC_API_KEY: 'sk-ant-teste', AGENTOPS_LLM_CACHE: value }).cacheEnabled,
    ).toBe(false);
  });

  // Teste 3
  it('AGENTOPS_LLM_CACHE inválida → invalid_config orientativo citando os valores aceitos e o default', () => {
    expect.assertions(6);
    try {
      resolveLlmEngineConfig({ ANTHROPIC_API_KEY: 'sk-ant-teste', AGENTOPS_LLM_CACHE: 'talvez' });
    } catch (error) {
      expect(error).toBeInstanceOf(LlmEngineError);
      expect((error as LlmEngineError).code).toBe('invalid_config');
      expect((error as LlmEngineError).message).toContain('AGENTOPS_LLM_CACHE');
      expect((error as LlmEngineError).message).toContain('on|true|1');
      expect((error as LlmEngineError).message).toContain('off|false|0');
      expect((error as LlmEngineError).message).toContain('default (on');
    }
  });

  // Teste 4 — regressão: ordem dos erros preservada
  it('ANTHROPIC_API_KEY continua sendo validada antes de AGENTOPS_LLM_CACHE (ordem dos erros)', () => {
    expect(() => resolveLlmEngineConfig({ AGENTOPS_LLM_CACHE: 'talvez' })).toThrowError(
      expect.objectContaining({ code: 'missing_api_key' }),
    );
  });

  it('a API key nunca aparece em mensagens de erro de config', () => {
    const secret = 'sk-ant-super-secreta-123';
    try {
      resolveLlmEngineConfig({ ANTHROPIC_API_KEY: secret, AGENTOPS_LLM_MAX_TOKENS: 'abc' });
      expect.unreachable('deveria ter lançado');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
