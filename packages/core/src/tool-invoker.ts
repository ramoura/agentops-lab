import type { ToolName } from '@agentops/types';

export type { ToolInvoker } from '@agentops/types';

/**
 * Falha na invocação de uma tool (ex.: resposta MCP com `isError: true` ou
 * falha de transporte). O engine trata como dado faltante (`missingData`),
 * nunca aborta a investigação inteira (RF14 / teste 47).
 */
export class ToolInvocationError extends Error {
  readonly tool: ToolName;

  constructor(tool: ToolName, message: string) {
    super(message);
    this.name = 'ToolInvocationError';
    this.tool = tool;
  }
}
