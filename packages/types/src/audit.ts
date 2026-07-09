import { z } from 'zod';
import type { ToolName } from './common.js';

/** Entrada do registro de auditoria (RF7): uma por chamada de tool, na ordem de execução. */
export const toolCallRecordSchema = z.object({
  seq: z.number().int().min(1),
  tool: z.string().min(1),
  params: z.record(z.unknown()),
  resultSummary: z.string(),
  durationMs: z.number().min(0),
});
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;

/** Toda interação do engine com o mundo externo passa por aqui (RF6). */
export interface ToolInvoker {
  invoke<TIn, TOut>(tool: ToolName, params: TIn): Promise<TOut>;
}

/** Decorator de `ToolInvoker`: registra seq, tool, params e resumo do resultado (RF7). */
export interface AuditLog {
  readonly records: ToolCallRecord[];
  wrap(inner: ToolInvoker): ToolInvoker;
}
