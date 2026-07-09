import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getErrorSummaryInputSchema, searchDocumentsInputSchema } from '@agentops/types';
import { okResult, validationErrorResult, withValidation } from './tool-result.js';

/** Bordas do envelope de resultado: espelho serializado e códigos de ToolError. */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  return first?.type === 'text' ? (first.text ?? '') : '';
}

describe('okResult', () => {
  it('espelha o structuredContent em content[0].text serializado', () => {
    const result = okResult({ hasData: false, totalRequests: 0 });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ hasData: false, totalRequests: 0 });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });
});

describe('validationErrorResult', () => {
  it('janela invertida produz mensagem prefixada com INVALID_TIME_RANGE', () => {
    const parsed = getErrorSummaryInputSchema.safeParse({
      service: 'checkout-api',
      from: '2026-07-08T11:00:00-03:00',
      to: '2026-07-08T10:00:00-03:00',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const result = validationErrorResult(parsed.error);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^INVALID_TIME_RANGE:/);
  });

  it('issue sem prefixo de código é envelopada como INVALID_ARGUMENT', () => {
    const parsed = getErrorSummaryInputSchema.safeParse({ service: '', from: 'x', to: 'y' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const result = validationErrorResult(parsed.error);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^INVALID_ARGUMENT:/);
  });

  it('query vazia produz EMPTY_QUERY', () => {
    const parsed = searchDocumentsInputSchema.safeParse({ query: '   ' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const result = validationErrorResult(parsed.error);
    expect(textOf(result)).toMatch(/^EMPTY_QUERY:/);
  });
});

describe('withValidation', () => {
  const schema = z.object({ query: z.string().min(1, 'INVALID_ARGUMENT: query obrigatória') });

  it('args undefined são tratados como objeto vazio e rejeitados pelo schema', async () => {
    const handler = withValidation('tool_teste', schema, async () => ({ ok: true }));
    const result = await handler(undefined);

    expect(result.isError).toBe(true);
  });

  it('entrada válida delega ao handler e devolve okResult', async () => {
    const handler = withValidation('tool_teste', schema, async (input) => ({ echoed: input.query }));
    const result = await handler({ query: 'checkout' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ echoed: 'checkout' });
  });
});
