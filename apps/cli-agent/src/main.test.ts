import { describe, expect, it } from 'vitest';
import { EngineArgError, formatTokenCount, formatUsageLine, resolveEngineArgs } from './main.js';

/**
 * Unitários de `resolveEngineArgs` (teste 23 da techspec V2): seleção de motor
 * por flag + env, com a flag removida dos args restantes (o que sobra é a
 * pergunta). Importar `main.ts` é seguro: o entrypoint só roda quando o módulo
 * é invocado diretamente.
 */

const QUESTION = ['Investigue', 'o', 'checkout-api'];

// Teste 23
describe('resolveEngineArgs', () => {
  it('sem flag e sem env → deterministic (default, custo zero)', () => {
    const { engine, rest } = resolveEngineArgs(QUESTION, {});

    expect(engine).toBe('deterministic');
    expect(rest).toEqual(QUESTION);
  });

  it('--engine=llm → llm, com a flag removida do rest', () => {
    const { engine, rest } = resolveEngineArgs(['--engine=llm', ...QUESTION], {});

    expect(engine).toBe('llm');
    expect(rest).toEqual(QUESTION);
  });

  it('--engine=deterministic explícito também é removido do rest', () => {
    const { engine, rest } = resolveEngineArgs([...QUESTION, '--engine=deterministic'], {});

    expect(engine).toBe('deterministic');
    expect(rest).toEqual(QUESTION);
  });

  it('AGENTOPS_ENGINE=llm sem flag → llm', () => {
    const { engine, rest } = resolveEngineArgs(QUESTION, { AGENTOPS_ENGINE: 'llm' });

    expect(engine).toBe('llm');
    expect(rest).toEqual(QUESTION);
  });

  it('flag vence a env', () => {
    const { engine } = resolveEngineArgs(['--engine=deterministic', ...QUESTION], { AGENTOPS_ENGINE: 'llm' });

    expect(engine).toBe('deterministic');
  });

  it('--engine=foo → erro de uso citando os valores aceitos', () => {
    expect(() => resolveEngineArgs(['--engine=foo', ...QUESTION], {})).toThrow(EngineArgError);
    expect(() => resolveEngineArgs(['--engine=foo'], {})).toThrow(/deterministic, llm/);
  });

  it('--engine sem valor → erro de uso', () => {
    expect(() => resolveEngineArgs(['--engine', ...QUESTION], {})).toThrow(EngineArgError);
  });

  it('AGENTOPS_ENGINE inválida → erro orientativo citando a variável', () => {
    expect(() => resolveEngineArgs(QUESTION, { AGENTOPS_ENGINE: 'foo' })).toThrow(/AGENTOPS_ENGINE inválida/);
  });

  it('AGENTOPS_ENGINE vazia é ignorada (default deterministic)', () => {
    expect(resolveEngineArgs(QUESTION, { AGENTOPS_ENGINE: '  ' }).engine).toBe('deterministic');
  });
});

describe('formatTokenCount', () => {
  it('formata milhares com 1 casa e mantém valores pequenos inteiros', () => {
    expect(formatTokenCount(12437)).toBe('12.4k');
    expect(formatTokenCount(1800)).toBe('1.8k');
    expect(formatTokenCount(999)).toBe('999');
  });
});

// Testes 17–19 (techspec V2.5): linha de custo com detalhe de cache
describe('formatUsageLine', () => {
  // Teste 17
  it('cache > 0 → detalhe de cache lido/escrito entre parênteses', () => {
    const line = formatUsageLine({
      inputTokens: 3900,
      outputTokens: 5100,
      cacheReadTokens: 44200,
      cacheCreationTokens: 9200,
      rounds: 5,
    });

    expect(line).toBe('Tokens: 3.9k entrada (44.2k cache lido · 9.2k cache escrito) · 5.1k saída · 5 rodada(s)');
  });

  // Teste 18
  it('cache == 0 → formato da V2 preservado, sem parêntese vazio', () => {
    const line = formatUsageLine({
      inputTokens: 57300,
      outputTokens: 5100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      rounds: 5,
    });

    expect(line).toBe('Tokens: 57.3k entrada · 5.1k saída · 5 rodada(s)');
  });

  // Teste 19
  it('campos de cache usam a mesma formatação de formatTokenCount (12.4k)', () => {
    const line = formatUsageLine({
      inputTokens: 500,
      outputTokens: 900,
      cacheReadTokens: 12437,
      cacheCreationTokens: 999,
      rounds: 2,
    });

    expect(line).toContain(`(${formatTokenCount(12437)} cache lido · ${formatTokenCount(999)} cache escrito)`);
    expect(line).toBe('Tokens: 500 entrada (12.4k cache lido · 999 cache escrito) · 900 saída · 2 rodada(s)');
  });
});
