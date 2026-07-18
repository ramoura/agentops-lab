import OpenAI from 'openai';
import type {
  AssistantContentBlock,
  ChatMessage,
  ChatPort,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  LlmEngineConfig,
  UserContentBlock,
} from '@agentops/llm-engine';
import { LlmEngineError } from '@agentops/llm-engine';
import type { LlmProvider } from '@agentops/types';
import { mapChatToolsToOpenAiTools, type OpenAiToolDefinition } from './openai-tool-mapping.js';

export type OpenAiContentPart = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

export type OpenAiMessageContent = string | OpenAiContentPart[] | null;

export type OpenAiChatMessage =
  | { role: 'system'; content: OpenAiMessageContent }
  | { role: 'user'; content: OpenAiMessageContent }
  | {
      role: 'assistant';
      content: OpenAiMessageContent;
      tool_calls?: OpenAiToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: OpenAiMessageContent };

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAiChatParams {
  model: string;
  max_tokens: number;
  messages: OpenAiChatMessage[];
  tools: OpenAiToolDefinition[];
  tool_choice: 'auto';
}

export interface OpenAiChatCompletion {
  choices: Array<{
    finish_reason: string | null;
    message: {
      content: string | null;
      tool_calls?: OpenAiToolCall[] | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number | null;
      cache_write_tokens?: number | null;
    } | null;
  } | null;
}

/** The small SDK surface used by the adapter, injectable for every test. */
export interface ChatCompletionsApi {
  create(params: OpenAiChatParams): Promise<OpenAiChatCompletion>;
}

export class OpenAiChatAdapter implements ChatPort {
  constructor(
    private readonly completions: ChatCompletionsApi,
    private readonly provider: Extract<LlmProvider, 'openrouter' | 'openai'> = 'openai',
    private readonly apiKey = '',
  ) {}

  static fromConfig(config: LlmEngineConfig): OpenAiChatAdapter {
    const client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl === null ? {} : { baseURL: config.baseUrl }),
    });
    const completions = client.chat.completions as unknown as ChatCompletionsApi;
    const provider = config.provider === 'openrouter' ? 'openrouter' : 'openai';
    return new OpenAiChatAdapter(completions, provider, config.apiKey);
  }

  async create(request: ChatRequest): Promise<ChatResponse> {
    let response: OpenAiChatCompletion;
    try {
      response = await this.completions.create(toOpenAiRequest(request, this.provider));
    } catch (error) {
      // The original SDK error may contain the secret in a response body. It
      // must not become an inspectable cause of the propagated error.
      throw new LlmEngineError('api_error', this.apiErrorMessage(error));
    }

    return fromOpenAiResponse(response);
  }

  private apiErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : stringifyError(error);
    const safe = redactSecret(raw, this.apiKey);
    return `falha na API OpenAI-compatible: ${safe}. Verifique o endpoint, o modelo, os limites da conta e a conectividade.`;
  }
}

export function toOpenAiRequest(
  request: ChatRequest,
  provider: Extract<LlmProvider, 'openrouter' | 'openai'> = 'openai',
): OpenAiChatParams {
  return {
    model: request.model,
    max_tokens: request.max_tokens,
    messages: [
      toSystemMessage(request.system, provider),
      ...request.messages.flatMap((message) => toOpenAiMessages(message, provider)),
    ],
    tools: mapChatToolsToOpenAiTools(request.tools),
    tool_choice: 'auto',
  };
}

function toSystemMessage(
  blocks: ChatRequest['system'],
  provider: Extract<LlmProvider, 'openrouter' | 'openai'>,
): OpenAiChatMessage {
  return { role: 'system', content: toTextContent(blocks, provider) };
}

function toOpenAiMessages(
  message: ChatMessage,
  provider: Extract<LlmProvider, 'openrouter' | 'openai'>,
): OpenAiChatMessage[] {
  if (message.role === 'assistant') {
    return [toAssistantMessage(message.content, provider)];
  }

  const textBlocks = message.content.filter(isTextBlock);
  const toolResults = message.content.filter(isToolResultBlock);
  const messages: OpenAiChatMessage[] = [];
  if (textBlocks.length > 0) {
    messages.push({ role: 'user', content: toTextContent(textBlocks, provider) });
  }
  messages.push(...toolResults.map((block) => toToolMessage(block, provider)));
  return messages;
}

function toAssistantMessage(
  blocks: AssistantContentBlock[],
  provider: Extract<LlmProvider, 'openrouter' | 'openai'>,
): OpenAiChatMessage {
  const textBlocks = blocks.filter(isTextBlock);
  const toolBlocks = blocks.filter(isToolUseBlock);
  const message: Extract<OpenAiChatMessage, { role: 'assistant' }> = {
    role: 'assistant',
    content: textBlocks.length === 0 ? null : toTextContent(textBlocks, provider),
  };
  if (toolBlocks.length > 0) {
    message.tool_calls = toolBlocks.map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.input) },
    }));
  }
  return message;
}

function toToolMessage(
  block: Extract<UserContentBlock, { type: 'tool_result' }>,
  provider: Extract<LlmProvider, 'openrouter' | 'openai'>,
): OpenAiChatMessage {
  const content =
    provider === 'openrouter' && block.cache_control !== undefined
      ? [{ type: 'text' as const, text: block.content, cache_control: block.cache_control }]
      : block.content;
  return { role: 'tool', tool_call_id: block.tool_use_id, content };
}

function toTextContent(
  blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>,
  provider: Extract<LlmProvider, 'openrouter' | 'openai'>,
): OpenAiMessageContent {
  const hasMarkers = provider === 'openrouter' && blocks.some((block) => block.cache_control !== undefined);
  if (!hasMarkers) {
    return blocks.map((block) => block.text).join('');
  }
  return blocks.map((block) => ({
    type: 'text' as const,
    text: block.text,
    ...(block.cache_control === undefined ? {} : { cache_control: block.cache_control }),
  }));
}

function fromOpenAiResponse(response: OpenAiChatCompletion): ChatResponse {
  const choice = response.choices[0];
  const content = choice?.message.content;
  const toolCalls = choice?.message.tool_calls ?? [];
  const assistantContent: AssistantContentBlock[] = [];
  if (content !== null && content !== undefined && content !== '') {
    assistantContent.push({ type: 'text', text: content });
  }
  assistantContent.push(...toolCalls.map(toToolUseBlock));

  return {
    content: assistantContent,
    stop_reason: resolveStopReason(choice?.finish_reason ?? null, toolCalls.length > 0),
    usage: normalizeUsage(response.usage),
  };
}

function toToolUseBlock(call: OpenAiToolCall): Extract<AssistantContentBlock, { type: 'tool_use' }> {
  return {
    type: 'tool_use',
    id: call.id,
    name: call.function.name,
    input: parseToolArguments(call.function.name, call.function.arguments),
  };
}

function parseToolArguments(toolName: string, rawArguments: string): Record<string, unknown> {
  if (rawArguments === '') {
    return {};
  }
  try {
    return JSON.parse(rawArguments) as Record<string, unknown>;
  } catch {
    throw new LlmEngineError(
      'api_error',
      `resposta da API OpenAI-compatible contém arguments JSON malformado para a tool "${toolName}". ` +
        'Verifique o modelo ou o gateway OpenAI-compatible e tente novamente.',
    );
  }
}

function resolveStopReason(finishReason: string | null, hasToolCalls: boolean): ChatResponse['stop_reason'] {
  if (hasToolCalls) {
    return 'tool_use';
  }
  if (finishReason === 'stop') {
    return 'end_turn';
  }
  if (finishReason === 'tool_calls') {
    return 'tool_use';
  }
  if (finishReason === 'length') {
    return 'max_tokens';
  }
  return finishReason;
}

export function normalizeUsage(usage: OpenAiChatCompletion['usage']): ChatUsage {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    input_tokens: promptTokens - cachedTokens,
    output_tokens: completionTokens,
    cache_creation_input_tokens: cacheWriteTokens,
    cache_read_input_tokens: cachedTokens,
  };
}

function isTextBlock(block: AssistantContentBlock | UserContentBlock): block is Extract<AssistantContentBlock, { type: 'text' }> {
  return block.type === 'text';
}

function isToolUseBlock(block: AssistantContentBlock): block is Extract<AssistantContentBlock, { type: 'tool_use' }> {
  return block.type === 'tool_use';
}

function isToolResultBlock(block: UserContentBlock): block is Extract<UserContentBlock, { type: 'tool_result' }> {
  return block.type === 'tool_result';
}

function stringifyError(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function redactSecret(message: string, secret: string): string {
  return secret === '' ? message : message.split(secret).join('<redacted>');
}
