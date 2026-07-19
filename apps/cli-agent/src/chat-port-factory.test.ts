import { describe, expect, it } from 'vitest';
import { AnthropicChatAdapter, type ChatPort, type LlmEngineConfig } from '@agentops/llm-engine';
import { OpenAiChatAdapter } from '@agentops/openai-engine';
import { FakeChatCompletions, completion } from '@agentops/openai-engine/testing';
import { createChatPort } from './chat-port-factory.js';

const BASE_CONFIG: LlmEngineConfig = {
  provider: 'anthropic',
  baseUrl: null,
  apiKey: 'sk-test',
  model: 'claude-sonnet-5',
  maxTokens: 4096,
  maxRounds: 16,
  cacheEnabled: true,
};

function noOpPort(): ChatPort {
  return { create: async () => ({ content: [], stop_reason: 'end_turn', usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  } }) };
}

describe('createChatPort', () => {
  it('UT-039: selects the adapter by provider without making a request', () => {
    expect(createChatPort(BASE_CONFIG)).toBeInstanceOf(AnthropicChatAdapter);
    expect(createChatPort({ ...BASE_CONFIG, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' })).toBeInstanceOf(OpenAiChatAdapter);
    expect(createChatPort({ ...BASE_CONFIG, provider: 'openai', model: 'gpt-4o-mini' })).toBeInstanceOf(OpenAiChatAdapter);
  });

  it('IT-003: passes provider config to injected factories, including baseUrl overrides', () => {
    const calls: Array<{ provider: LlmEngineConfig['provider']; baseUrl: string | null }> = [];
    const dependencies = {
      anthropicFromApiKey: () => noOpPort(),
      openAiFromConfig: (config: LlmEngineConfig) => {
        calls.push({ provider: config.provider, baseUrl: config.baseUrl });
        return new OpenAiChatAdapter(
          new FakeChatCompletions([completion('ok')]),
          config.provider === 'openrouter' ? 'openrouter' : 'openai',
          config.apiKey,
        );
      },
    };

    const defaultOpenRouter = createChatPort(
      { ...BASE_CONFIG, provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
      dependencies,
    );
    const customOpenAi = createChatPort(
      { ...BASE_CONFIG, provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'gpt-test' },
      dependencies,
    );

    expect(defaultOpenRouter).toBeInstanceOf(OpenAiChatAdapter);
    expect(customOpenAi).toBeInstanceOf(OpenAiChatAdapter);
    expect(calls).toEqual([
      { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
      { provider: 'openai', baseUrl: 'http://localhost:11434/v1' },
    ]);
  });
});
