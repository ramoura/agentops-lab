import { OpenAiChatAdapter } from '@agentops/openai-engine';
import {
  AnthropicChatAdapter,
  type ChatPort,
  type LlmEngineConfig,
} from '@agentops/llm-engine';

export interface ChatPortFactoryDependencies {
  anthropicFromApiKey: (apiKey: string) => ChatPort;
  openAiFromConfig: (config: LlmEngineConfig) => ChatPort;
}

const DEFAULT_DEPENDENCIES: ChatPortFactoryDependencies = {
  anthropicFromApiKey: (apiKey) => AnthropicChatAdapter.fromApiKey(apiKey),
  openAiFromConfig: (config) => OpenAiChatAdapter.fromConfig(config),
};

/**
 * Materializes the provider-neutral chat port at the composition root.
 * Construction does not invoke either provider; the first network call only
 * happens when the returned port receives a ChatRequest.
 */
export function createChatPort(
  config: LlmEngineConfig,
  dependencies: ChatPortFactoryDependencies = DEFAULT_DEPENDENCIES,
): ChatPort {
  return config.provider === 'anthropic'
    ? dependencies.anthropicFromApiKey(config.apiKey)
    : dependencies.openAiFromConfig(config);
}
