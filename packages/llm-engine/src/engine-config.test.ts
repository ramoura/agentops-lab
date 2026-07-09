import { describe, expect, it } from 'vitest';
import {
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
  it('aplica os defaults da techspec (claude-sonnet-5, 4096, 16, temperature 0)', () => {
    const config = resolveLlmEngineConfig({ ANTHROPIC_API_KEY: 'sk-ant-teste' });
    expect(config).toEqual({
      apiKey: 'sk-ant-teste',
      model: DEFAULT_LLM_MODEL,
      maxTokens: DEFAULT_LLM_MAX_TOKENS,
      maxRounds: DEFAULT_LLM_MAX_ROUNDS,
      temperature: 0,
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
    expect(config.temperature).toBe(0);
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
