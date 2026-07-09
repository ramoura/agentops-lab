import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatToolError, resolveToolErrorCode } from '@agentops/types';
import { logger } from './logger.js';

/**
 * Resultado de sucesso: `structuredContent` tipado + espelho serializado em
 * `content[0].text` (clients sem suporte a structured content leem o texto).
 */
export function okResult(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * Envelope `ToolError` (isError: true) com mensagem prefixada pelo código
 * (`INVALID_ARGUMENT` / `INVALID_TIME_RANGE` / `EMPTY_QUERY`). Usado apenas
 * para validação de entrada — ausência de dados NUNCA é erro (RF14).
 */
export function validationErrorResult(error: z.ZodError): CallToolResult {
  const code = resolveToolErrorCode(error);
  const issue = error.issues.find((candidate) => candidate.message.startsWith(`${code}:`)) ?? error.issues[0];
  const rawMessage = issue?.message ?? 'parâmetros inválidos';
  const text = rawMessage.startsWith(`${code}:`) ? rawMessage : formatToolError(code, rawMessage);
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

/**
 * Handler de tool com validação estrita: os shapes registrados no SDK descrevem
 * a descoberta (tipos base + descrições), e o schema Zod completo de
 * `@agentops/types` (refinements de janela, query, limites) é aplicado aqui —
 * garantindo o envelope `ToolError` com o prefixo de código exato.
 */
export function withValidation<TSchema extends z.ZodTypeAny>(
  toolName: string,
  schema: TSchema,
  handler: (input: z.output<TSchema>) => Promise<Record<string, unknown>>,
): (args: unknown) => Promise<CallToolResult> {
  return async (args: unknown): Promise<CallToolResult> => {
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) {
      const result = validationErrorResult(parsed.error);
      logger.debug(`${toolName} rejeitou entrada inválida: ${(result.content[0] as { text: string }).text}`);
      return result;
    }
    logger.debug(`${toolName} chamada com ${JSON.stringify(parsed.data)}`);
    return okResult(await handler(parsed.data));
  };
}
