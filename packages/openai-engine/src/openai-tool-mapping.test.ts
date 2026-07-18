import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '@agentops/types';
import { mapChatToolsToOpenAiTools, mapChatToolToOpenAiTool } from './openai-tool-mapping.js';
import type { ChatToolDefinition } from '@agentops/llm-engine';

function tools(): ChatToolDefinition[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: `desc:${name}`,
    input_schema: { type: 'object', properties: { service: { type: 'string' } } },
  }));
}

describe('openai tool mapping', () => {
  it('UT-015: wraps one neutral definition and preserves the schema reference', () => {
    const input_schema = { type: 'object', properties: { service: { type: 'string' } } };
    const tool: ChatToolDefinition = { name: 'get_error_summary', description: 'desc', input_schema };

    const mapped = mapChatToolToOpenAiTool(tool);

    expect(mapped).toEqual({ type: 'function', function: { name: tool.name, description: tool.description, parameters: input_schema } });
    expect(mapped.function.parameters).toBe(input_schema);
  });

  it('UT-016: preserves the nine tools and their order', () => {
    const mapped = mapChatToolsToOpenAiTools(tools());

    expect(mapped).toHaveLength(9);
    expect(mapped.map((tool) => tool.function.name)).toEqual([...TOOL_NAMES]);
    expect(mapped.map((tool) => tool.function.parameters)).toEqual(tools().map((tool) => tool.input_schema));
  });
});
