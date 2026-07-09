import { describe, expect, it } from 'vitest';
import { EngineArgError, formatTokenCount, resolveEngineArgs } from './main.js';

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
