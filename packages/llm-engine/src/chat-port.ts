import type { ToolName } from '@agentops/types';

/** Breakpoint de prompt caching da Messages API. */
export interface CacheControl {
  type: 'ephemeral';
}

/** Bloco de system com breakpoint opcional. */
export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

/** Bloco de conteúdo produzido pelo modelo (assistant). */
export type AssistantContentBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; cache_control?: CacheControl };

/** Bloco de conteúdo enviado pelo usuário ou devolvido por uma tool. */
export type UserContentBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; cache_control?: CacheControl };

export type ChatMessage =
  | { role: 'user'; content: UserContentBlock[] }
  | { role: 'assistant'; content: AssistantContentBlock[] };

/** Definição provider-neutra de tool; adapters embrulham a mesma shape. */
export interface ChatToolDefinition {
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Espelho provider-neutro dos parâmetros usados pelo loop agêntico. */
export interface ChatRequest {
  model: string;
  max_tokens: number;
  system: SystemBlock[];
  tools: ChatToolDefinition[];
  tool_choice: { type: 'auto' };
  messages: ChatMessage[];
}

/** Uso de tokens de uma rodada, normalizado entre providers. */
export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Resposta provider-neutra consumida pelo loop agêntico. */
export interface ChatResponse {
  content: AssistantContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | (string & {}) | null;
  usage: ChatUsage;
}

/** Única superfície de chat que o loop agêntico conhece. */
export interface ChatPort {
  create(request: ChatRequest): Promise<ChatResponse>;
}
