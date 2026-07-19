import type {
  AssistantContentBlock,
  ChatUsage,
} from '@agentops/llm-engine';
import type { ChatCompletionsApi, OpenAiChatCompletion, OpenAiChatParams } from '../openai-chat.js';

export const DEFAULT_USAGE: ChatUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export function makeUsage(partial: Partial<ChatUsage> = {}): ChatUsage {
  return { ...DEFAULT_USAGE, ...partial };
}

/** A deterministic chat/completions boundary fake: it never touches the network. */
export class FakeChatCompletions implements ChatCompletionsApi {
  readonly requests: OpenAiChatParams[] = [];
  private cursor = 0;

  constructor(private readonly script: Array<OpenAiChatCompletion | Error>) {}

  async create(request: OpenAiChatParams): Promise<OpenAiChatCompletion> {
    this.requests.push(structuredClone(request));
    const entry = this.script[Math.min(this.cursor, this.script.length - 1)];
    this.cursor += 1;
    if (entry === undefined) {
      throw new Error('FakeChatCompletions: roteiro vazio');
    }
    if (entry instanceof Error) {
      throw entry;
    }
    return structuredClone(entry);
  }
}

export function completion(
  content: string | null,
  finishReason: string | null = 'stop',
  options: {
    toolCalls?: OpenAiChatCompletion['choices'][number]['message']['tool_calls'];
    usage?: OpenAiChatCompletion['usage'];
  } = {},
): OpenAiChatCompletion {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: { content, ...(options.toolCalls === undefined ? {} : { tool_calls: options.toolCalls }) },
      },
    ],
    usage: options.usage ?? {
      prompt_tokens: DEFAULT_USAGE.input_tokens,
      completion_tokens: DEFAULT_USAGE.output_tokens,
    },
  };
}

export function toolCall(id: string, name: string, input: Record<string, unknown> = {}): NonNullable<OpenAiChatCompletion['choices'][number]['message']['tool_calls']>[number] {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

export function toolUseBlock(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Extract<AssistantContentBlock, { type: 'tool_use' }> {
  return { type: 'tool_use', id, name, input };
}
