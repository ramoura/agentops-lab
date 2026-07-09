import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT, StubToolInvoker, case001Responses } from './__fixtures__/case-001.js';
import { DeterministicInvestigationAssistant } from './deterministic-assistant.js';
import { DeterministicInvestigationEngine } from './engine.js';
import { PtBrQuestionParser } from './question-parser.js';

/**
 * Testes 21–22 da techspec V2: o adapter compõe parser + engine sem nenhuma
 * mudança de comportamento — mesmo report da V1 byte a byte, e pergunta
 * ambígua vira `clarification` sem invocar tool alguma (RF3/US10).
 */

const AMBIGUOUS_QUESTION = 'por que deu erro?';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DeterministicInvestigationAssistant', () => {
  // Teste 21
  it('pergunta válida → kind "report" com report byte-idêntico ao da V1 (mesmo engine, mesmo stub)', async () => {
    // durationMs vem de performance.now(); fixado para a comparação byte a byte
    vi.spyOn(performance, 'now').mockReturnValue(0);

    // Caminho V1: parser e engine encadeados manualmente (como CLI/eval faziam)
    const parsed = new PtBrQuestionParser().parse(CONTEXT.question);
    if (!parsed.ok) {
      throw new Error('a pergunta do case-001 deveria ser parseável');
    }
    const v1Report = await new DeterministicInvestigationEngine().investigate(
      parsed.context,
      new StubToolInvoker(case001Responses()),
    );

    // Caminho V2: mesma pergunta crua, atrás do adapter
    const outcome = await new DeterministicInvestigationAssistant().investigate(
      CONTEXT.question,
      new StubToolInvoker(case001Responses()),
    );

    expect(outcome.kind).toBe('report');
    if (outcome.kind !== 'report') {
      throw new Error('outcome deveria ser report');
    }
    expect(JSON.stringify(outcome.report)).toBe(JSON.stringify(v1Report));
  });

  // Teste 22
  it('pergunta ambígua → kind "clarification" com os mesmos MissingField do parser, sem invocar tool', async () => {
    const parsed = new PtBrQuestionParser().parse(AMBIGUOUS_QUESTION);
    if (parsed.ok) {
      throw new Error('a pergunta ambígua não deveria ser parseável');
    }

    const stub = new StubToolInvoker(case001Responses());
    const outcome = await new DeterministicInvestigationAssistant().investigate(AMBIGUOUS_QUESTION, stub);

    expect(outcome).toEqual({ kind: 'clarification', missing: parsed.missing });
    expect(stub.calls).toEqual([]);
  });
});
