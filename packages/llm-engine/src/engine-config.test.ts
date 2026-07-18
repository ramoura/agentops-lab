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
      provider: 'anthropic',
      baseUrl: null,
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

  it('UT-002: resolve OpenRouter com default de baseUrl e chave própria', () => {
    const config = resolveLlmEngineConfig({
      AGENTOPS_LLM_PROVIDER: 'openrouter',
      AGENTOPS_LLM_MODEL: 'deepseek/deepseek-chat',
      OPENROUTER_API_KEY: 'sk-or-teste',
    });
    expect(config).toMatchObject({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-teste',
      model: 'deepseek/deepseek-chat',
    });
  });

  it('UT-003: resolve OpenAI com baseUrl nulo', () => {
    const config = resolveLlmEngineConfig({
      AGENTOPS_LLM_PROVIDER: 'openai',
      AGENTOPS_LLM_MODEL: 'gpt-4o-mini',
      OPENAI_API_KEY: 'sk-openai-teste',
    });
    expect(config).toMatchObject({ provider: 'openai', baseUrl: null, apiKey: 'sk-openai-teste', model: 'gpt-4o-mini' });
  });

  it('UT-004: provider não Anthropic sem modelo → invalid_config orientativo', () => {
    expect(() => resolveLlmEngineConfig({ AGENTOPS_LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-teste' })).toThrowError(
      expect.objectContaining({ code: 'invalid_config', message: expect.stringContaining('não há default de modelo') }),
    );
  });

  it('UT-005: chave ausente cita OPENROUTER_API_KEY e não Anthropic', () => {
    expect(() => resolveLlmEngineConfig({ AGENTOPS_LLM_PROVIDER: 'openrouter', AGENTOPS_LLM_MODEL: 'deepseek/deepseek-chat' })).toThrowError(
      expect.objectContaining({ code: 'missing_api_key', message: expect.stringContaining('OPENROUTER_API_KEY') }),
    );
    try {
      resolveLlmEngineConfig({ AGENTOPS_LLM_PROVIDER: 'openrouter', AGENTOPS_LLM_MODEL: 'deepseek/deepseek-chat' });
    } catch (error) {
      expect((error as Error).message).not.toContain('ANTHROPIC_API_KEY');
    }
  });

  it('UT-006: provider inválido lista os valores aceitos', () => {
    expect(() => resolveLlmEngineConfig({ AGENTOPS_LLM_PROVIDER: 'talvez' })).toThrowError(
      expect.objectContaining({ code: 'invalid_config', message: expect.stringContaining('anthropic|openrouter|openai') }),
    );
  });

  it('UT-007: baseUrl custom sobrepõe o default do provider', () => {
    const config = resolveLlmEngineConfig({
      AGENTOPS_LLM_PROVIDER: 'openai',
      AGENTOPS_LLM_MODEL: 'gpt-4o-mini',
      AGENTOPS_LLM_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_API_KEY: 'sk-openai-teste',
    });
    expect(config.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('UT-008: provider inválido é reportado antes da chave ausente', () => {
    expect(() => resolveLlmEngineConfig({ AGENTOPS_LLM_PROVIDER: 'talvez' })).toThrowError(
      expect.objectContaining({ code: 'invalid_config' }),
    );
  });

  it('UT-009: chave em branco é missing_api_key', () => {
    expect(() => resolveLlmEngineConfig({
      AGENTOPS_LLM_PROVIDER: 'openrouter',
      AGENTOPS_LLM_MODEL: 'deepseek/deepseek-chat',
      OPENROUTER_API_KEY: '',
    })).toThrowError(expect.objectContaining({ code: 'missing_api_key' }));
  });

  it('UT-010: max tokens inválido permanece invalid_config em OpenRouter', () => {
    expect(() => resolveLlmEngineConfig({
      AGENTOPS_LLM_PROVIDER: 'openrouter',
      AGENTOPS_LLM_MODEL: 'deepseek/deepseek-chat',
      OPENROUTER_API_KEY: 'sk-or-teste',
      AGENTOPS_LLM_MAX_TOKENS: 'abc',
    })).toThrowError(expect.objectContaining({ code: 'invalid_config', message: expect.stringContaining('AGENTOPS_LLM_MAX_TOKENS') }));
  });

  it('UT-011: overrides de provider/model usam a mesma validação e chave do provider', () => {
    const config = resolveLlmEngineConfig(
      {
        AGENTOPS_LLM_PROVIDER: 'anthropic',
        AGENTOPS_LLM_MODEL: 'modelo-antigo',
        ANTHROPIC_API_KEY: 'sk-ant-teste',
        OPENAI_API_KEY: 'sk-openai-teste',
      },
      { provider: 'openai', model: 'gpt-4o-mini' },
    );
    expect(config).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-openai-teste' });
  });

  it('UT-012: nenhuma mensagem de erro de config contém chaves de qualquer provider', () => {
    const cases = [
      ['anthropic', 'ANTHROPIC_API_KEY', 'sk-ant-secret'],
      ['openrouter', 'OPENROUTER_API_KEY', 'sk-or-secret'],
      ['openai', 'OPENAI_API_KEY', 'sk-openai-secret'],
    ] as const;
    for (const [provider, keyName, secret] of cases) {
      try {
        resolveLlmEngineConfig({
          AGENTOPS_LLM_PROVIDER: provider,
          AGENTOPS_LLM_MODEL: provider === 'anthropic' ? undefined : 'model',
          [keyName]: secret,
          AGENTOPS_LLM_MAX_TOKENS: secret,
        });
        expect.unreachable('deveria ter lançado');
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });
});
