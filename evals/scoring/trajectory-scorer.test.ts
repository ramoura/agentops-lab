import { describe, expect, it } from 'vitest';
import type { ExpectedTrajectory, ToolCallRecord } from '@agentops/types';
import { canonicalize, DeterministicTrajectoryScorer, isParameterSubset } from './trajectory-scorer.js';

const scorer = new DeterministicTrajectoryScorer();

function record(seq: number, tool = 'get_error_summary', params: Record<string, unknown> = {}, overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { seq, tool, params, resultSummary: 'OK', durationMs: seq / 10, ...overrides };
}

function expectation(overrides: Partial<ExpectedTrajectory> = {}): ExpectedTrajectory {
  return { required_calls: [], order_constraints: [], forbid_exact_duplicates: true, ...overrides };
}

describe('matching parcial de parâmetros', () => {
  it('casa subconjuntos simples e aninhados; {} casa qualquer objeto', () => {
    expect(isParameterSubset({}, { service: 'checkout', limit: 5 })).toBe(true);
    expect(isParameterSubset({ service: 'checkout' }, { service: 'checkout', limit: 5 })).toBe(true);
    expect(isParameterSubset({ filter: { level: 'ERROR' } }, { filter: { level: 'ERROR', limit: 5 } })).toBe(true);
  });

  it('exige chave presente, igualdade sem coerção e arrays exatos/ordenados', () => {
    expect(isParameterSubset({ limit: undefined }, {})).toBe(false);
    expect(isParameterSubset({ limit: 1 }, { limit: '1' })).toBe(false);
    expect(isParameterSubset({ values: [1, 2] }, { values: [1, 2] })).toBe(true);
    expect(isParameterSubset({ values: [1, 2] }, { values: [2, 1] })).toBe(false);
    expect(isParameterSubset({ values: [1] }, { values: [1, 2] })).toBe(false);
    expect(isParameterSubset(null, null)).toBe(true);
  });

  it('canonicaliza objetos recursivamente sem alterar a ordem de arrays', () => {
    expect(canonicalize({ b: 2, nested: { z: 1, a: true }, a: 1 }))
      .toBe(canonicalize({ a: 1, nested: { a: true, z: 1 }, b: 2 }));
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});

describe('DeterministicTrajectoryScorer', () => {
  it('avalia chamadas obrigatórias, ocorrências e preserva ordem declarativa', () => {
    const result = scorer.score(expectation({
      required_calls: [
        { id: 'errors', tool: 'get_error_summary', params: { service: 'checkout' }, min_occurrences: 1, max_occurrences: 2 },
        { id: 'logs', tool: 'get_recent_logs', params: {}, min_occurrences: 2 },
        { id: 'forbidden', tool: 'search_adrs', params: {}, min_occurrences: 0, max_occurrences: 0 },
      ],
      forbid_exact_duplicates: false,
    }), [record(3, 'get_recent_logs'), record(1, 'get_error_summary', { service: 'checkout', extra: true }), record(2, 'get_recent_logs', { page: 2 })]);
    expect(result.criteria.map((criterion) => criterion.name)).toEqual([
      'trajectory:required:errors', 'trajectory:required:logs', 'trajectory:required:forbidden',
    ]);
    expect(result.criteria.every((criterion) => criterion.passed)).toBe(true);
    expect(result.criteria[1]?.details).toContain('seq: 2, 3');
  });

  it('falha por tool/parâmetros errados e por limites de ocorrência', () => {
    const result = scorer.score(expectation({ required_calls: [
      { id: 'wrong-tool', tool: 'get_recent_logs', params: { service: 'checkout' }, min_occurrences: 1 },
      { id: 'too-many', tool: 'get_error_summary', params: {}, min_occurrences: 1, max_occurrences: 1 },
    ] }), [record(1, 'get_error_summary', { service: 'other' }), record(2, 'get_error_summary', { service: 'other' })]);
    expect(result.criteria.slice(0, 2).map((criterion) => criterion.passed)).toEqual([false, false]);
  });

  it('avalia precedência pelo seq, não pela posição, e permite tools intermediárias', () => {
    const exp = expectation({
      required_calls: [
        { id: 'operational', tool: 'get_error_summary', params: {}, min_occurrences: 1 },
        { id: 'knowledge', tool: 'search_runbooks', params: {}, min_occurrences: 1 },
      ],
      order_constraints: [{ before: 'operational', after: 'knowledge' }],
    });
    const passed = scorer.score(exp, [record(5, 'search_runbooks'), record(3, 'get_recent_logs'), record(1)]);
    expect(passed.criteria.find((criterion) => criterion.name.startsWith('trajectory:order'))?.passed).toBe(true);
    const failed = scorer.score(exp, [record(1, 'search_runbooks'), record(2)]);
    expect(failed.criteria.find((criterion) => criterion.name.startsWith('trajectory:order'))?.passed).toBe(false);
  });

  it('explica lado ausente na precedência e dá crédito parcial', () => {
    const result = scorer.score(expectation({
      required_calls: [
        { id: 'before', tool: 'get_error_summary', params: {}, min_occurrences: 1 },
        { id: 'after', tool: 'search_runbooks', params: {}, min_occurrences: 1 },
      ],
      order_constraints: [{ before: 'before', after: 'after' }],
    }), [record(1)]);
    expect(result.criteria.at(-2)?.details).toContain('after');
    expect(result.score).toBe(0.5);
  });

  it('detecta duplicatas canônicas por ocorrências excedentes e ignora metadados', () => {
    const records = [
      record(1, 'get_error_summary', { service: 'checkout', nested: { b: 2, a: 1 } }),
      record(2, 'get_error_summary', { nested: { a: 1, b: 2 }, service: 'checkout' }, { resultSummary: 'outro', durationMs: 99 }),
      record(3, 'get_error_summary', { service: 'checkout', nested: { a: 1, b: 2 } }),
      record(4, 'get_recent_logs', { service: 'checkout', nested: { a: 1, b: 2 } }),
    ];
    const result = scorer.score(expectation(), records);
    expect(result.metrics).toMatchObject({ total_calls: 4, unique_call_signatures: 2, duplicate_calls: 2 });
    expect(result.criteria[0]?.passed).toBe(false);
  });

  it('mantém duplicatas como métrica quando o critério está desabilitado', () => {
    const result = scorer.score(expectation({ forbid_exact_duplicates: false }), [record(1), record(2)]);
    expect(result.criteria).toEqual([]);
    expect(result.metrics.duplicate_calls).toBe(1);
    expect(result).toMatchObject({ score: 1, passed: true });
  });

  it('aplica max_calls inclusive, inclusive em zero', () => {
    expect(scorer.score(expectation({ max_calls: 1 }), [record(1)]).passed).toBe(true);
    expect(scorer.score(expectation({ max_calls: 0 }), [record(1)]).passed).toBe(false);
    expect(scorer.score(expectation({ max_calls: 0 }), []).passed).toBe(true);
  });

  it('agrega falhas/duração sem afetar critérios e arredonda score', () => {
    const exp = expectation({ required_calls: [
      { id: 'one', tool: 'get_error_summary', params: {}, min_occurrences: 1 },
      { id: 'missing', tool: 'get_recent_logs', params: {}, min_occurrences: 1 },
    ], forbid_exact_duplicates: false, max_calls: 5 });
    const first = scorer.score(exp, [record(1, 'get_error_summary', {}, { resultSummary: 'ERRO: timeout', durationMs: 1.25 }), record(2, 'search_adrs', {}, { resultSummary: 'contém erro', durationMs: 2.5 })]);
    const second = scorer.score(exp, [record(1, 'get_error_summary', {}, { resultSummary: 'ERRO: timeout', durationMs: 100 }), record(2, 'search_adrs', {}, { resultSummary: 'contém erro', durationMs: 200 })]);
    expect(first.metrics).toMatchObject({ failed_calls: 1, total_duration_ms: 3.75 });
    expect(first.score).toBe(0.67);
    expect(second.criteria).toEqual(first.criteria);
    expect(second.score).toBe(first.score);
  });

  it('audit vazio falha obrigatórias, mas bloco sem critérios tem identidade 1', () => {
    const required = scorer.score(expectation({ required_calls: [{ id: 'x', tool: 'get_error_summary', params: {}, min_occurrences: 1 }], forbid_exact_duplicates: false }), []);
    expect(required).toMatchObject({ score: 0, passed: false });
    const empty = scorer.score(expectation({ forbid_exact_duplicates: false }), []);
    expect(empty).toMatchObject({ criteria: [], score: 1, passed: true, metrics: { total_calls: 0 } });
  });
});
