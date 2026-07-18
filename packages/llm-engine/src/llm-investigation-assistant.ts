import { InMemoryAuditLog } from '@agentops/core';
import { TOOL_NAMES } from '@agentops/types';
import type {
  InvestigationAssistant,
  InvestigationOutcome,
  McpToolDefinition,
  RoundContentBlock,
  RoundToolResult,
  RoundTrace,
  ToolInvoker,
  ToolName,
} from '@agentops/types';
import type {
  AssistantContentBlock,
  CacheControl,
  ChatMessage,
  ChatPort,
  SystemBlock,
  UserContentBlock,
} from './chat-port.js';
import { LlmEngineError } from './engine-config.js';
import type { LlmEngineConfig } from './engine-config.js';
import { mapMcpToolsToChatTools } from './tool-mapping.js';

/**
 * Agregado de tokens/rodadas de uma investigação (linha de custo em stderr).
 * A entrada total é `inputTokens + cacheCreationTokens + cacheReadTokens` —
 * `inputTokens` carrega apenas a parcela não cacheada (após o último
 * breakpoint); os campos de cache somam as rodadas.
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  rounds: number;
}

/** Hooks opcionais de observabilidade (progresso por rodada, para a CLI). */
export interface LlmInvestigationHooks {
  onRound?: (round: number, maxRounds: number) => void;
}

/**
 * Motor LLM da V2: loop agêntico manual sobre a Messages API
 * (`while stop_reason === 'tool_use'`). A pergunta entra crua como primeira
 * mensagem `user` (RF2 pelo modelo, sem parser); cada `tool_use` do modelo é
 * executado pelo `ToolInvoker` embrulhado no `InMemoryAuditLog` (auditoria por
 * código, nunca pelo modelo — RF7) e devolvido como `tool_result`; falha de
 * tool vira `tool_result` com `is_error: true` sem abortar (RF14). O markdown
 * final segue o contrato de formato do system prompt (RF4/RF5).
 */
export class LlmInvestigationAssistant implements InvestigationAssistant {
  /** Uso agregado da última investigação (null antes da primeira). */
  private usage: LlmUsage | null = null;
  /** Trace rodada a rodada da última investigação (mesmo padrão do `lastUsage`). */
  private trace: RoundTrace[] = [];

  constructor(
    private readonly chat: ChatPort,
    private readonly toolSource: () => Promise<McpToolDefinition[]>,
    private readonly config: LlmEngineConfig,
    private readonly systemPrompt: string,
    private readonly hooks: LlmInvestigationHooks = {},
  ) {}

  get lastUsage(): LlmUsage | null {
    return this.usage;
  }

  get lastTrace(): RoundTrace[] {
    return this.trace;
  }

  async investigate(question: string, tools: ToolInvoker): Promise<InvestigationOutcome> {
    const chatTools = mapMcpToolsToChatTools(await this.toolSource());
    const auditLog = new InMemoryAuditLog();
    const auditedTools = auditLog.wrap(tools);
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 0 };
    this.usage = usage;
    const trace: RoundTrace[] = [];
    this.trace = trace;

    const { cacheEnabled } = this.config;
    // Breakpoint estável (V2.5): no último bloco do system — pela ordem de
    // renderização `tools → system → messages`, cacheia tools + system juntos.
    // Marker no *bloco*, não no texto: o prompt é byte-idêntico com cache
    // ligado ou desligado.
    const system: SystemBlock[] = cacheEnabled
      ? [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral' } }]
      : [{ type: 'text', text: this.systemPrompt }];

    // O histórico permanece sempre SEM markers: o breakpoint móvel é aplicado
    // por request em uma cópia (`withMobileBreakpoint`), então o marker da
    // rodada anterior some por construção — nunca mais de 2 por request
    // (teto de 4 da API respeitado com folga).
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: question }] }];

    for (let round = 1; round <= this.config.maxRounds; round += 1) {
      this.hooks.onRound?.(round, this.config.maxRounds);

      let response;
      try {
        response = await this.chat.create({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          system,
          tools: chatTools,
          tool_choice: { type: 'auto' },
          messages: cacheEnabled ? withMobileBreakpoint(messages) : messages,
        });
      } catch (error) {
        throw new LlmEngineError(
          'api_error',
          `falha na API da Anthropic: ${error instanceof Error ? error.message : String(error)}. ` +
            'Verifique a ANTHROPIC_API_KEY, os limites da conta e a conectividade.',
          { cause: error, audit: auditLog.records },
        );
      }

      usage.rounds = round;
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens;
      usage.cacheCreationTokens += response.usage.cache_creation_input_tokens;

      if (response.stop_reason === 'max_tokens') {
        throw new LlmEngineError(
          'max_tokens_reached',
          'a resposta do modelo foi truncada por max_tokens. ' +
            'Aumente AGENTOPS_LLM_MAX_TOKENS (default 4096) e tente novamente.',
          { audit: auditLog.records },
        );
      }

      if (response.stop_reason === 'tool_use') {
        const toolResults = await this.executeToolUses(response.content, auditedTools);
        trace.push({
          round,
          assistantContent: response.content.map(toRoundContentBlock),
          stopReason: response.stop_reason,
          usage: { ...response.usage },
          toolResults: toolResults.flatMap(toRoundToolResult),
        });
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // end_turn (ou stop_reason equivalente): o markdown final do relatório.
      trace.push({
        round,
        assistantContent: response.content.map(toRoundContentBlock),
        stopReason: response.stop_reason,
        usage: { ...response.usage },
        toolResults: [],
      });

      const markdown = response.content
        .filter((block): block is Extract<AssistantContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (markdown === '') {
        throw new LlmEngineError(
          'empty_response',
          'o modelo encerrou a resposta sem nenhum bloco de texto — relatório inutilizável. Tente novamente.',
          { audit: auditLog.records },
        );
      }
      return { kind: 'markdown', markdown, audit: auditLog.records };
    }

    throw new LlmEngineError(
      'max_rounds_exceeded',
      `o loop agêntico ultrapassou o teto de ${this.config.maxRounds} rodada(s) sem produzir o relatório final. ` +
        'Aumente AGENTOPS_LLM_MAX_ROUNDS ou simplifique a pergunta.',
      { audit: auditLog.records },
    );
  }

  /**
   * Executa todos os blocos `tool_use` na ordem em que o modelo os pediu e
   * devolve um `tool_result` por `tool_use_id`, todos na mesma mensagem `user`
   * seguinte (contrato da Messages API para tool use paralelo). Tool
   * desconhecida ou falha de invocação viram `is_error: true` — o modelo
   * decide degradar (RF14); a falha fica no audit pelo próprio wrapper.
   */
  private async executeToolUses(content: AssistantContentBlock[], tools: ToolInvoker): Promise<UserContentBlock[]> {
    const results: UserContentBlock[] = [];
    for (const block of content) {
      if (block.type !== 'tool_use') {
        continue;
      }
      if (!isKnownToolName(block.name)) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `tool desconhecida: "${block.name}" (disponíveis: ${TOOL_NAMES.join(', ')})`,
          is_error: true,
        });
        continue;
      }
      try {
        const result = await tools.invoke(block.name, block.input);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      } catch (error) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: error instanceof Error ? error.message : String(error),
          is_error: true,
        });
      }
    }
    return results;
  }
}

function isKnownToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Bloco do trace a partir do bloco da resposta do modelo — descarta `cache_control` (nunca presente aqui). */
function toRoundContentBlock(block: AssistantContentBlock): RoundContentBlock {
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }
  return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
}

/** Resultado do trace a partir do `tool_result` enviado ao modelo — descarta `cache_control`. */
function toRoundToolResult(block: UserContentBlock): RoundToolResult[] {
  if (block.type !== 'tool_result') {
    return [];
  }
  return [{ type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error }];
}

/**
 * Breakpoint móvel (V2.5): cópia do histórico com `cache_control` no último
 * bloco da última mensagem — o padrão multi-turn da Messages API (cada rodada
 * lê o prefixo escrito pela anterior e estende o cache). Com múltiplos
 * tool_use na rodada, o marker cai apenas no último `tool_result` da mensagem
 * `user` seguinte. O histórico original não é tocado.
 */
function withMobileBreakpoint(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.at(-1);
  if (last === undefined || last.content.length === 0) {
    return messages;
  }
  const marked: ChatMessage =
    last.role === 'user'
      ? { role: 'user', content: markLastBlock(last.content) }
      : { role: 'assistant', content: markLastBlock(last.content) };
  return [...messages.slice(0, -1), marked];
}

function markLastBlock<T extends { cache_control?: CacheControl }>(blocks: T[]): T[] {
  return blocks.map((block, index) =>
    index === blocks.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block,
  );
}
