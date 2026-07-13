import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { investigationTraceRecordSchema } from '@agentops/types';
import type { InvestigationOutcome, MissingField, ToolCallRecord } from '@agentops/types';
import { appendTraceRecord, buildTraceRecord, generateRunId } from './trace-log.js';
import type { BuildTraceRecordInput } from './trace-log.js';

const RECORD: ToolCallRecord = {
  seq: 1,
  tool: 'get_error_summary',
  params: { service: 'checkout-api' },
  resultSummary: '412 req, 87x 5xx',
  durationMs: 12,
};

const MISSING: MissingField[] = [{ field: 'service', hint: 'informe o serviço' }];

const WINDOW = { from: '2026-07-08T10:00:00-03:00', to: '2026-07-08T10:30:00-03:00' };

function baseInput(outcome: InvestigationOutcome): BuildTraceRecordInput {
  return {
    source: 'investigate',
    runId: 'run-1',
    caseId: null,
    question: 'Investigue o checkout-api',
    engine: 'llm',
    model: 'claude-sonnet-5',
    outcome,
    rounds: null,
    usage: null,
    evalResult: null,
  };
}

describe('buildTraceRecord', () => {
  it('extrai audit de outcome.kind "report" a partir de outcome.report.audit', () => {
    const record = buildTraceRecord(
      baseInput({
        kind: 'report',
        report: {
          context: { question: 'q', service: 'checkout-api', window: WINDOW, symptom: null },
          summary: 'resumo',
          evidences: [],
          primaryHypothesis: null,
          alternativeHypotheses: [],
          safeNextSteps: [],
          missingData: [],
          confidence: 'baixa',
          audit: [RECORD],
        },
      }),
    );

    expect(record.audit).toEqual([RECORD]);
  });

  it('extrai audit de outcome.kind "markdown" a partir de outcome.audit', () => {
    const record = buildTraceRecord(baseInput({ kind: 'markdown', markdown: 'texto', audit: [RECORD] }));

    expect(record.audit).toEqual([RECORD]);
  });

  it('outcome.kind "clarification" → audit vazio', () => {
    const record = buildTraceRecord(baseInput({ kind: 'clarification', missing: MISSING }));

    expect(record.audit).toEqual([]);
  });

  it('gera um traceId novo a cada chamada e preserva o runId recebido', () => {
    const input = baseInput({ kind: 'markdown', markdown: 'texto', audit: [] });

    const first = buildTraceRecord(input);
    const second = buildTraceRecord(input);

    expect(first.traceId).not.toBe(second.traceId);
    expect(first.runId).toBe('run-1');
    expect(second.runId).toBe('run-1');
  });

  it('monta um registro válido pelo schema (paridade eval/usage)', () => {
    const record = buildTraceRecord({
      ...baseInput({ kind: 'markdown', markdown: 'texto', audit: [RECORD] }),
      source: 'eval',
      caseId: 'case-001-database-timeout',
      rounds: [],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1 },
      evalResult: {
        caseId: 'case-001-database-timeout',
        score: 1,
        passed: true,
        criteria: [{ name: 'finding:DatabaseTimeoutException', passed: true, details: 'encontrado' }],
      },
    });

    expect(investigationTraceRecordSchema.safeParse(record).success).toBe(true);
  });
});

describe('appendTraceRecord', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentops-trace-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('cria o diretório de destino quando ausente e grava uma linha JSONL válida', async () => {
    const path = join(dir, 'nested', 'trace.jsonl');
    const record = buildTraceRecord(baseInput({ kind: 'markdown', markdown: 'texto', audit: [] }));

    await appendTraceRecord(path, record);

    const content = await readFile(path, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(investigationTraceRecordSchema.safeParse(JSON.parse(lines[0] ?? '')).success).toBe(true);
  });

  it('duas chamadas seguidas produzem duas linhas, cada uma um JSON válido, sem reescrever o arquivo', async () => {
    const path = join(dir, 'trace.jsonl');
    const record1 = buildTraceRecord(baseInput({ kind: 'markdown', markdown: 'texto 1', audit: [] }));
    const record2 = buildTraceRecord(baseInput({ kind: 'markdown', markdown: 'texto 2', audit: [] }));

    await appendTraceRecord(path, record1);
    await appendTraceRecord(path, record2);

    const content = await readFile(path, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(investigationTraceRecordSchema.safeParse(JSON.parse(line)).success).toBe(true);
    }
  });
});

describe('generateRunId', () => {
  it('gera ids únicos', () => {
    expect(generateRunId()).not.toBe(generateRunId());
  });
});
