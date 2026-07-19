import { describe, expect, it } from 'vitest';
import {
  endTurn,
  FakeAnthropicChat,
  makeUsage as makeAnthropicUsage,
  mcpDefinitions,
  StubToolInvoker,
  toolUseBlock as anthropicToolUseBlock,
  toolUseRound as anthropicToolUseRound,
} from '@agentops/llm-engine/testing';
import { LlmEngineError, LlmInvestigationAssistant } from '@agentops/llm-engine';
import type { ChatRequest, LlmEngineConfig } from '@agentops/llm-engine';
import { FakeChatCompletions, completion, toolCall } from './__fixtures__/testing.js';
import { OpenAiChatAdapter } from './openai-chat.js';

const CONFIG: LlmEngineConfig = {
  provider: 'openai',
  baseUrl: null,
  apiKey: 'sk-test',
  model: 'gpt-test',
  maxTokens: 4096,
  maxRounds: 16,
  cacheEnabled: true,
};
const REQUEST: ChatRequest = {
  model: CONFIG.model,
  max_tokens: CONFIG.maxTokens,
  system: [{ type: 'text', text: 'system ' }, { type: 'text', text: 'prompt' }],
  tools: [{ name: 'get_error_summary', description: 'summary', input_schema: { type: 'object' } }],
  tool_choice: { type: 'auto' },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'question' }] }],
};

function adapter(
  fake: FakeChatCompletions,
  provider: 'openrouter' | 'openai' = 'openai',
  apiKey: string = CONFIG.apiKey,
): OpenAiChatAdapter {
  return new OpenAiChatAdapter(fake, provider, apiKey);
}

describe('OpenAiChatAdapter request translation', () => {
  it('UT-017: concatenates system blocks into the initial system message', async () => {
    const fake = new FakeChatCompletions([completion('ok')]);
    await adapter(fake).create(REQUEST);

    expect(fake.requests[0]?.messages[0]).toEqual({ role: 'system', content: 'system prompt' });
  });

  it('UT-018: maps a user text block to a user message', async () => {
    const fake = new FakeChatCompletions([completion('ok')]);
    await adapter(fake).create(REQUEST);

    expect(fake.requests[0]?.messages[1]).toEqual({ role: 'user', content: 'question' });
  });

  it('UT-019: maps assistant tool_use to an OpenAI function tool call', async () => {
    const fake = new FakeChatCompletions([completion(null, 'tool_calls', { toolCalls: [toolCall('call-1', 'get_error_summary', { service: 'checkout-api' })] })]);
    await adapter(fake).create({ ...REQUEST, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'get_error_summary', input: { service: 'checkout-api' } }] }] });

    expect(fake.requests[0]?.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_error_summary', arguments: '{"service":"checkout-api"}' } }],
    });
  });

  it('UT-020: preserves two assistant tool calls in order', async () => {
    const fake = new FakeChatCompletions([completion(null, 'tool_calls', { toolCalls: [toolCall('1', 'get_error_summary'), toolCall('2', 'get_top_exceptions')] })]);
    await adapter(fake).create({ ...REQUEST, messages: [{ role: 'assistant', content: [
      { type: 'tool_use', id: '1', name: 'get_error_summary', input: {} },
      { type: 'tool_use', id: '2', name: 'get_top_exceptions', input: {} },
    ] }] });

    expect(fake.requests[0]?.messages[1]).toMatchObject({ role: 'assistant', tool_calls: [
      { id: '1', function: { name: 'get_error_summary' } },
      { id: '2', function: { name: 'get_top_exceptions' } },
    ] });
  });

  it('UT-021: maps tool results to separate tool messages in order', async () => {
    const fake = new FakeChatCompletions([completion('ok')]);
    await adapter(fake).create({ ...REQUEST, messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: '1', content: 'one' },
      { type: 'tool_result', tool_use_id: '2', content: 'two', is_error: true },
    ] }] });

    expect(fake.requests[0]?.messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: '1', content: 'one' },
      { role: 'tool', tool_call_id: '2', content: 'two' },
    ]);
  });

  it('UT-022: maps tools, auto choice and max_tokens without sampling parameters', async () => {
    const fake = new FakeChatCompletions([completion('ok')]);
    await adapter(fake).create(REQUEST);
    const params = fake.requests[0];

    expect(params).toMatchObject({
      max_tokens: 4096,
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'get_error_summary', parameters: REQUEST.tools[0]?.input_schema } }],
    });
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('top_k');
  });

  it('UT-023: retains cache_control markers by block for OpenRouter', async () => {
    const fake = new FakeChatCompletions([completion('ok')]);
    await adapter(fake, 'openrouter').create({
      ...REQUEST,
      system: [{ type: 'text', text: 'stable' }, { type: 'text', text: 'last', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral' } }] }],
    });

    expect(fake.requests[0]?.messages[0]).toEqual({ role: 'system', content: [
      { type: 'text', text: 'stable' },
      { type: 'text', text: 'last', cache_control: { type: 'ephemeral' } },
    ] });
    expect(fake.requests[0]?.messages[1]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'question', cache_control: { type: 'ephemeral' } },
    ] });
  });

  it('UT-024: discards cache_control markers for OpenAI', async () => {
    const fake = new FakeChatCompletions([completion('ok')]);
    await adapter(fake, 'openai').create({
      ...REQUEST,
      system: [{ type: 'text', text: 'last', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral' } }] }],
    });

    expect(JSON.stringify(fake.requests[0])).not.toContain('cache_control');
  });
});

describe('OpenAiChatAdapter response translation and usage', () => {
  it('UT-025: maps text content and stop to end_turn', async () => {
    const response = await adapter(new FakeChatCompletions([completion('answer')])).create(REQUEST);

    expect(response.content).toEqual([{ type: 'text', text: 'answer' }]);
    expect(response.stop_reason).toBe('end_turn');
  });

  it('UT-026: maps function calls and tool_calls to tool_use', async () => {
    const response = await adapter(new FakeChatCompletions([completion(null, 'tool_calls', { toolCalls: [toolCall('1', 'get_error_summary', { service: 'checkout-api' })] })])).create(REQUEST);

    expect(response.content).toEqual([{ type: 'tool_use', id: '1', name: 'get_error_summary', input: { service: 'checkout-api' } }]);
    expect(response.stop_reason).toBe('tool_use');
  });

  it('UT-027: treats non-empty tool_calls with stop as tool_use', async () => {
    const response = await adapter(new FakeChatCompletions([completion(null, 'stop', { toolCalls: [toolCall('1', 'get_error_summary')] })])).create(REQUEST);

    expect(response.stop_reason).toBe('tool_use');
  });

  it('UT-028: maps length to max_tokens', async () => {
    const response = await adapter(new FakeChatCompletions([completion('truncated', 'length')])).create(REQUEST);

    expect(response.stop_reason).toBe('max_tokens');
  });

  it('UT-029: omits null content and returns an empty content array', async () => {
    const response = await adapter(new FakeChatCompletions([completion(null)])).create(REQUEST);

    expect(response.content).toEqual([]);
  });

  it('UT-030: maps empty arguments to an empty input object', async () => {
    const call = toolCall('1', 'get_error_summary');
    call.function.arguments = '';
    const response = await adapter(new FakeChatCompletions([completion(null, 'tool_calls', { toolCalls: [call] })])).create(REQUEST);

    expect(response.content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('UT-031: reports malformed arguments with the tool name', async () => {
    const call = toolCall('1', 'get_error_summary');
    call.function.arguments = '{not-json';
    await expect(adapter(new FakeChatCompletions([completion(null, 'tool_calls', { toolCalls: [call] })])).create(REQUEST)).rejects.toMatchObject({
      code: 'api_error',
      message: expect.stringContaining('get_error_summary'),
    });
  });

  it('UT-032: normalizes cache usage while preserving the token sum', async () => {
    const response = await adapter(new FakeChatCompletions([completion('ok', 'stop', {
      usage: { prompt_tokens: 1000, completion_tokens: 250, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 50 } },
    })])).create(REQUEST);

    expect(response.usage).toEqual({ input_tokens: 800, output_tokens: 250, cache_creation_input_tokens: 50, cache_read_input_tokens: 200 });
    expect(response.usage.input_tokens + response.usage.cache_creation_input_tokens + response.usage.cache_read_input_tokens).toBe(1050);
  });

  it('UT-033: defaults missing prompt token details to zero', async () => {
    const response = await adapter(new FakeChatCompletions([completion('ok', 'stop', {
      usage: { prompt_tokens: 321, completion_tokens: 45 },
    })])).create(REQUEST);

    expect(response.usage).toEqual({ input_tokens: 321, output_tokens: 45, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(response.usage.cache_read_input_tokens).not.toBeUndefined();
  });

  it('UT-056: sanitizes an API error containing the API key', async () => {
    const key = 'sk-secret-to-never-leak';
    const fake = new FakeChatCompletions([new Error(`gateway body leaked ${key}`)]);
    const result = adapter(fake, 'openai', key);
    const error = await result.create(REQUEST).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(LlmEngineError);
    expect((error as Error).message).not.toContain(key);
  });
});

describe('OpenAiChatAdapter through the provider-neutral investigation loop', () => {
  const question = 'Investigate checkout-api';
  const config: LlmEngineConfig = { ...CONFIG, cacheEnabled: false };
  const toolInput = { service: 'checkout-api' };

  function assistant(chat: OpenAiChatAdapter, localConfig = config): LlmInvestigationAssistant {
    return new LlmInvestigationAssistant(chat, async () => mcpDefinitions(), localConfig, 'system prompt');
  }

  it('UT-034: produces the same logical outcome and audit as the equivalent Anthropic route', async () => {
    const openAiFake = new FakeChatCompletions([
      completion(null, 'tool_calls', { toolCalls: [toolCall('call-1', 'get_error_summary', toolInput)] }),
      completion('final report'),
    ]);
    const openAiOutcome = await assistant(new OpenAiChatAdapter(openAiFake, 'openai', CONFIG.apiKey)).investigate(question, new StubToolInvoker({ get_error_summary: { count5xx: 2 } }));

    const anthropicChat = new FakeAnthropicChat([
      anthropicToolUseRound([anthropicToolUseBlock('call-1', 'get_error_summary', toolInput)]),
      endTurn('final report', makeAnthropicUsage()),
    ]);
    const anthropicOutcome = await new LlmInvestigationAssistant(anthropicChat, async () => mcpDefinitions(), config, 'system prompt').investigate(question, new StubToolInvoker({ get_error_summary: { count5xx: 2 } }));

    expect(openAiOutcome.kind).toBe('markdown');
    expect(anthropicOutcome.kind).toBe('markdown');
    if (openAiOutcome.kind !== 'markdown' || anthropicOutcome.kind !== 'markdown') {
      throw new Error('expected markdown outcomes');
    }
    expect(openAiOutcome).toMatchObject({ kind: 'markdown', markdown: 'final report' });
    expect(anthropicOutcome).toMatchObject({ kind: 'markdown', markdown: 'final report' });
    expect(openAiOutcome.audit.map((record) => ({ seq: record.seq, tool: record.tool, params: record.params }))).toEqual(
      anthropicOutcome.audit.map((record) => ({ seq: record.seq, tool: record.tool, params: record.params })),
    );
  });

  it('UT-035: preserves audit when the API rejects after an executed round', async () => {
    const fake = new FakeChatCompletions([
      completion(null, 'tool_calls', { toolCalls: [toolCall('1', 'get_error_summary', toolInput)] }),
      new Error('connection reset'),
    ]);
    const investigation = assistant(new OpenAiChatAdapter(fake, 'openai', CONFIG.apiKey));

    await expect(investigation.investigate(question, new StubToolInvoker({ get_error_summary: { count5xx: 1 } }))).rejects.toMatchObject({
      code: 'api_error',
      audit: [{ seq: 1, tool: 'get_error_summary' }],
    });
  });

  it('UT-036: maps a length response to max_tokens_reached in the loop', async () => {
    const fake = new FakeChatCompletions([completion('truncated', 'length')]);

    await expect(assistant(new OpenAiChatAdapter(fake, 'openai', CONFIG.apiKey)).investigate(question, new StubToolInvoker({}))).rejects.toMatchObject({ code: 'max_tokens_reached' });
  });

  it('UT-037: aggregates normalized OpenAI usage across rounds', async () => {
    const fake = new FakeChatCompletions([
      completion(null, 'tool_calls', {
        toolCalls: [toolCall('1', 'get_error_summary', toolInput)],
        usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 30 } },
      }),
      completion('final report', 'stop', { usage: { prompt_tokens: 1500, completion_tokens: 300 } }),
    ]);
    const investigation = assistant(new OpenAiChatAdapter(fake, 'openai', CONFIG.apiKey));

    await investigation.investigate(question, new StubToolInvoker({ get_error_summary: { count5xx: 1 } }));

    expect(investigation.lastUsage).toEqual({
      inputTokens: 2300,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 30,
      rounds: 2,
    });
  });
});
