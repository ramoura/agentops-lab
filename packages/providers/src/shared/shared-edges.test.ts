import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readJsonlFile } from './jsonl.js';
import { median, percentile } from './percentiles.js';
import { buildExcerpt, countOccurrences, normalizeText, splitMarkdownSections, tokenize } from './text-search.js';
import { extractOffset, formatWithOffset } from './time.js';

/** Bordas dos utilitários compartilhados dos providers (defensivas do RF14). */

describe('percentile / median', () => {
  it('lista vazia retorna null — chamador decide como representar ausência', () => {
    expect(percentile([], 99)).toBeNull();
    expect(median([])).toBeNull();
  });

  it('percentil fora de [0, 100] é erro de programação (RangeError)', () => {
    expect(() => percentile([1, 2], -1)).toThrow(RangeError);
    expect(() => percentile([1, 2], 101)).toThrow(RangeError);
  });

  it('interpola linearmente entre os dois pontos mais próximos', () => {
    expect(percentile([100, 200], 50)).toBe(150);
    expect(median([1, 2, 3])).toBe(2);
  });
});

describe('time — offsets', () => {
  it('timestamp sem offset explícito cai no fallback UTC (Z)', () => {
    expect(extractOffset('2026-07-08T10:00:00')).toBe('Z');
    expect(extractOffset('2026-07-08T10:00:00Z')).toBe('Z');
    expect(extractOffset('2026-07-08T10:00:00-03:00')).toBe('-03:00');
  });

  it('formata epoch em UTC e em offsets positivos/negativos', () => {
    expect(formatWithOffset(0, 'Z')).toBe('1970-01-01T00:00:00Z');
    expect(formatWithOffset(0, '+02:00')).toBe('1970-01-01T02:00:00+02:00');
    expect(formatWithOffset(0, '-03:00')).toBe('1969-12-31T21:00:00-03:00');
  });
});

describe('readJsonlFile — erros de leitura', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentops-jsonl-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const schema = z.object({ ok: z.boolean() });

  it('arquivo inexistente (ENOENT) retorna null — serviço desconhecido, não erro', async () => {
    expect(await readJsonlFile(join(dir, 'nao-existe.jsonl'), schema)).toBeNull();
  });

  it('erro de leitura que não é ENOENT propaga (ex.: caminho é diretório)', async () => {
    await expect(readJsonlFile(dir, schema)).rejects.toThrow();
  });

  it('linhas malformadas são ignoradas com warning; as válidas permanecem', async () => {
    const file = join(dir, 'misto.jsonl');
    await writeFile(file, '{"ok":true}\nnão é json\n{"ok":"errado"}\n{"ok":false}\n', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const entries = await readJsonlFile(file, schema);
      expect(entries).toEqual([{ ok: true }, { ok: false }]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('text-search — bordas', () => {
  it('tokenize de query sem caracteres alfanuméricos retorna vazio', () => {
    expect(tokenize('!!! ???')).toEqual([]);
  });

  it('countOccurrences sem match retorna 0', () => {
    expect(countOccurrences('texto normalizado', 'kafka')).toBe(0);
  });

  it('normalizeText preserva comprimento e remove acentos', () => {
    expect(normalizeText('Conexão')).toBe('conexao');
    expect(normalizeText('já')).toHaveLength(2);
  });

  it('splitMarkdownSections sem H1 usa o título de fallback', () => {
    const sections = splitMarkdownSections('sem título\n## Heading\ncorpo', 'fallback-name');
    expect(sections.title).toBe('fallback-name');
    expect(sections.headings).toBe('Heading');
  });

  it('buildExcerpt sem ocorrência retorna o início do documento, sem prefixo', () => {
    const excerpt = buildExcerpt('conteúdo curto do documento', ['kafka']);
    expect(excerpt.startsWith('…')).toBe(false);
    expect(excerpt).toContain('conteúdo curto');
  });

  it('buildExcerpt com match no meio de texto longo usa reticências nas bordas', () => {
    const content = `${'preenchimento '.repeat(30)}connection pool saturado ${'preenchimento '.repeat(30)}`;
    const excerpt = buildExcerpt(content, ['connection']);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).toContain('connection pool');
    expect(excerpt.length).toBeLessThanOrEqual(240);
  });
});
