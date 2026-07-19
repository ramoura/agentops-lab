import type { ChatToolDefinition } from '@agentops/llm-engine';

export interface OpenAiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Wraps the neutral definition without cloning its JSON Schema. */
export function mapChatToolToOpenAiTool(tool: ChatToolDefinition): OpenAiToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

export function mapChatToolsToOpenAiTools(tools: ChatToolDefinition[]): OpenAiToolDefinition[] {
  return tools.map(mapChatToolToOpenAiTool);
}
