import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EXCERPT_MAX_LENGTH } from '@agentops/types';
import { FakeKnowledgeProvider } from './fake-knowledge-provider.js';
import { normalizeText } from '../shared/text-search.js';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const knowledgeBaseDir = join(repoRoot, 'knowledge-base');

let provider: FakeKnowledgeProvider;

beforeEach(() => {
  provider = new FakeKnowledgeProvider({ knowledgeBaseDir });
});

describe('search', () => {
  // Teste 28
  it("ranqueia checkout-api-high-5xx em primeiro para 'checkout 5xx'", async () => {
    const result = await provider.search('runbooks', 'checkout 5xx');

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.name).toBe('checkout-api-high-5xx');
    expect(result.matches[0]?.path).toBe('knowledge-base/runbooks/checkout-api-high-5xx.md');
    expect(result.matches[0]?.score).toBeGreaterThan(0);
  });

  // Teste 29
  it('é case/acento-insensível ("TIMEOUT", "conexao")', async () => {
    const upper = await provider.search('runbooks', 'TIMEOUT');
    expect(upper.matches.map((match) => match.name)).toContain('database-timeout');

    const unaccented = await provider.search('runbooks', 'conexao');
    expect(unaccented.matches.length).toBeGreaterThan(0);
  });

  // Teste 30
  it('retorna matches vazio quando nada corresponde', async () => {
    const result = await provider.search('runbooks', 'kafka rebalance');
    expect(result.matches).toEqual([]);
  });

  // Teste 31
  it('não vaza entre tipos: runbooks não retornam ADRs e vice-versa', async () => {
    const runbooks = await provider.search('runbooks', 'checkout');
    expect(runbooks.matches.length).toBeGreaterThan(0);
    for (const match of runbooks.matches) {
      expect(match.path).toContain('/runbooks/');
    }

    const adrs = await provider.search('adrs', 'checkout');
    expect(adrs.matches.length).toBeGreaterThan(0);
    for (const match of adrs.matches) {
      expect(match.path).toContain('/adrs/');
      expect(match.name).not.toMatch(/^runbook/);
    }
  });

  // Teste 32
  it('respeita o limit no ranking', async () => {
    const unlimited = await provider.search('runbooks', 'timeout banco');
    expect(unlimited.matches.length).toBeGreaterThan(1);

    const limited = await provider.search('runbooks', 'timeout banco', 1);
    expect(limited.matches).toHaveLength(1);
    expect(limited.matches[0]?.name).toBe(unlimited.matches[0]?.name);
  });

  // Teste 35
  it('limita o excerpt a 240 chars e inclui o termo buscado', async () => {
    const result = await provider.search('runbooks', 'connection');

    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX_LENGTH);
    }
    expect(normalizeText(result.matches[0]!.excerpt)).toContain('connection');
  });
});

describe('getRunbook', () => {
  // Teste 33
  it('retorna o markdown completo de um runbook existente', async () => {
    const result = await provider.getRunbook('checkout-api-high-5xx');

    expect(result.found).toBe(true);
    expect(result.name).toBe('checkout-api-high-5xx');
    expect(result.title).toContain('checkout-api');
    expect(result.content).toContain('# Runbook');
    expect(result.content).toContain('connection pool');
  });

  // Teste 34
  it('retorna found false com campos null para runbook inexistente (nunca exceção)', async () => {
    const result = await provider.getRunbook('nao-existe');
    expect(result).toEqual({ found: false, name: null, title: null, content: null });

    // Nome com cara de caminho também é tratado como "não encontrado".
    const traversal = await provider.getRunbook('../adrs/adr-001-checkout-payment-flow');
    expect(traversal.found).toBe(false);
  });
});
