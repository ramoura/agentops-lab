import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '@agentops/types';
import type { McpToolDefinition } from '@agentops/types';
import { mcpDefinitions } from './__fixtures__/testing.js';
import { LlmEngineError } from './engine-config.js';
import { mapMcpToolsToAnthropic } from './tool-mapping.js';

// ---------------------------------------------------------------------------
// Test cases 14–16 da techspec V2 (mapeamento de tools)
// ---------------------------------------------------------------------------

describe('mapMcpToolsToAnthropic', () => {
  // Teste 14
  it('preserva name/description e faz passthrough de inputSchema → input_schema (por referência)', () => {
    const definitions = mcpDefinitions();
    const mapped = mapMcpToolsToAnthropic(definitions);

    expect(mapped).toHaveLength(9);
    mapped.forEach((tool, index) => {
      const source = definitions[index] as McpToolDefinition;
      expect(tool.name).toBe(source.name);
      expect(tool.description).toBe(source.description);
      // Passthrough: mesmo objeto, sem cópia nem transformação
      expect(tool.input_schema).toBe(source.inputSchema);
    });
  });

  // Teste 15 — as 9 presentes → ok
  it('aceita a lista completa das 9 tools de TOOL_NAMES', () => {
    const mapped = mapMcpToolsToAnthropic(mcpDefinitions());
    expect(mapped.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  // Teste 15 — lista incompleta → erro orientativo
  it('lista sem uma das 9 tools → erro orientativo citando a faltante', () => {
    const incomplete = mcpDefinitions().filter((definition) => definition.name !== 'get_runbook');
    expect.assertions(3);
    try {
      mapMcpToolsToAnthropic(incomplete);
    } catch (error) {
      expect(error).toBeInstanceOf(LlmEngineError);
      expect((error as LlmEngineError).code).toBe('invalid_config');
      expect((error as LlmEngineError).message).toContain('get_runbook');
    }
  });

  // Teste 16
  it('nome fora de TOOL_NAMES → erro de inicialização', () => {
    const definitions = [
      ...mcpDefinitions(),
      {
        name: 'delete_all_data',
        description: 'tool intrusa',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      } as unknown as McpToolDefinition,
    ];
    expect(() => mapMcpToolsToAnthropic(definitions)).toThrowError(
      expect.objectContaining({ code: 'invalid_config', message: expect.stringContaining('delete_all_data') }),
    );
  });

  // Reforço read-only (RF10): readOnlyHint ausente ou false → erro
  it.each([undefined, false])('readOnlyHint=%s → erro de inicialização (garantia read-only)', (hint) => {
    const definitions = mcpDefinitions();
    const first = definitions[0] as McpToolDefinition;
    first.annotations = hint === undefined ? undefined : { readOnlyHint: hint };
    expect(() => mapMcpToolsToAnthropic(definitions)).toThrowError(
      expect.objectContaining({ code: 'invalid_config', message: expect.stringContaining('readOnlyHint') }),
    );
  });
});
