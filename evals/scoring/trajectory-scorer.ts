import type {
  ExpectedTrajectory,
  RequiredToolCallExpectation,
  ToolCallRecord,
  TrajectoryCriterionResult,
  TrajectoryEvalResult,
  TrajectoryMetrics,
} from '@agentops/types';

export interface TrajectoryScorer {
  score(expectation: ExpectedTrajectory, records: readonly ToolCallRecord[]): TrajectoryEvalResult;
}

export class DeterministicTrajectoryScorer implements TrajectoryScorer {
  score(expectation: ExpectedTrajectory, records: readonly ToolCallRecord[]): TrajectoryEvalResult {
    const matches = new Map(
      expectation.required_calls.map((required) => [required.id, matchingRecords(required, records)]),
    );
    const metrics = trajectoryMetrics(records);
    const criteria: TrajectoryCriterionResult[] = [
      ...expectation.required_calls.map((required) => requiredCallCriterion(required, matches.get(required.id)!)),
      ...expectation.order_constraints.map((constraint) => {
        const before = matches.get(constraint.before) ?? [];
        const after = matches.get(constraint.after) ?? [];
        const ordered = before.some((left) => after.some((right) => left.seq < right.seq));
        const missing = [before.length === 0 ? constraint.before : null, after.length === 0 ? constraint.after : null]
          .filter((id): id is string => id !== null);
        return {
          name: `trajectory:order:${constraint.before}:before:${constraint.after}`,
          passed: ordered,
          details: missing.length > 0
            ? `expectativa(s) sem chamada compatível: ${missing.join(', ')}`
            : ordered
              ? `precedência observada (${seqList(before)} antes de ${seqList(after)})`
              : `nenhum seq de ${constraint.before} (${seqList(before)}) precede ${constraint.after} (${seqList(after)})`,
        };
      }),
    ];

    if (expectation.forbid_exact_duplicates) {
      criteria.push({
        name: 'trajectory:no_exact_duplicates',
        passed: metrics.duplicate_calls === 0,
        details: metrics.duplicate_calls === 0
          ? '0 chamadas duplicadas'
          : `${metrics.duplicate_calls} chamada(s) duplicada(s): ${duplicateDetails(records)}`,
      });
    }
    if (expectation.max_calls !== undefined) {
      criteria.push({
        name: 'trajectory:max_calls',
        passed: records.length <= expectation.max_calls,
        details: `${records.length}/${expectation.max_calls} chamada(s)`,
      });
    }

    const approved = criteria.filter((criterion) => criterion.passed).length;
    return {
      criteria,
      score: criteria.length === 0 ? 1 : Math.round((approved / criteria.length) * 100) / 100,
      passed: approved === criteria.length,
      metrics,
    };
  }
}

export function isParameterSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => isParameterSubset(value, actual[index]));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every(
      (key) => Object.prototype.hasOwnProperty.call(actual, key) && isParameterSubset(expected[key], actual[key]),
    );
  }
  return Object.is(expected, actual);
}

export function canonicalize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchingRecords(
  expectation: RequiredToolCallExpectation,
  records: readonly ToolCallRecord[],
): ToolCallRecord[] {
  return records
    .filter((record) => record.tool === expectation.tool && isParameterSubset(expectation.params, record.params))
    .sort((left, right) => left.seq - right.seq);
}

function requiredCallCriterion(
  expectation: RequiredToolCallExpectation,
  records: readonly ToolCallRecord[],
): TrajectoryCriterionResult {
  const withinMinimum = records.length >= expectation.min_occurrences;
  const withinMaximum = expectation.max_occurrences === undefined || records.length <= expectation.max_occurrences;
  const bounds = expectation.max_occurrences === undefined
    ? `mínimo ${expectation.min_occurrences}`
    : `${expectation.min_occurrences}..${expectation.max_occurrences}`;
  return {
    name: `trajectory:required:${expectation.id}`,
    passed: withinMinimum && withinMaximum,
    details: `${records.length} chamada(s) compatível(is) encontrada(s); esperado ${bounds} (seq: ${seqList(records)})`,
  };
}

function signature(record: ToolCallRecord): string {
  return `${record.tool}:${canonicalize(record.params)}`;
}

function signatureCounts(records: readonly ToolCallRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  records.forEach((record) => counts.set(signature(record), (counts.get(signature(record)) ?? 0) + 1));
  return counts;
}

function duplicateDetails(records: readonly ToolCallRecord[]): string {
  return [...signatureCounts(records)]
    .filter(([, count]) => count > 1)
    .map(([callSignature, count]) => `${callSignature} x${count}`)
    .join('; ');
}

function trajectoryMetrics(records: readonly ToolCallRecord[]): TrajectoryMetrics {
  const counts = signatureCounts(records);
  return {
    total_calls: records.length,
    unique_call_signatures: counts.size,
    duplicate_calls: [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    failed_calls: records.filter((record) => record.resultSummary.startsWith('ERRO:')).length,
    total_duration_ms: records.reduce((total, record) => total + record.durationMs, 0),
  };
}

function seqList(records: readonly ToolCallRecord[]): string {
  return records.length === 0 ? 'nenhum' : records.map((record) => record.seq).join(', ');
}
