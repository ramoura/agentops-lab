import { InMemoryAuditLog } from '@agentops/core';
import { TOOL_NAMES } from '@agentops/types';
import type { InvestigationAssistant, InvestigationOutcome, McpToolDefinition, ToolInvoker, ToolName } from '@agentops/types';
import type { AnthropicChatPort, AssistantContentBlock, ChatMessage, UserContentBlock } from './anthropic-chat.js';
import { LlmEngineError } from './engine-config.js';
import type { LlmEngineConfig } from './engine-config.js';
import { mapMcpToolsToAnthropic } from './tool-mapping.js';

/** Agregado de tokens/rodadas de uma investigação (linha de custo em stderr). */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
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

  constructor(
    private readonly chat: AnthropicChatPort,
    private readonly toolSource: () => Promise<McpToolDefinition[]>,
    private readonly config: LlmEngineConfig,
    private readonly systemPrompt: string,
    private readonly hooks: LlmInvestigationHooks = {},
  ) {}

  get lastUsage(): LlmUsage | null {
    return this.usage;
  }

  async investigate(question: string, tools: ToolInvoker): Promise<InvestigationOutcome> {
    const anthropicTools = mapMcpToolsToAnthropic(await this.toolSource());
    const auditLog = new InMemoryAuditLog();
    const auditedTools = auditLog.wrap(tools);
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, rounds: 0 };
    this.usage = usage;

    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: question }] }];

    for (let round = 1; round <= this.config.maxRounds; round += 1) {
      this.hooks.onRound?.(round, this.config.maxRounds);

      let response;
      try {
        response = await this.chat.create({
          model: this.config.model,
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
          system: this.systemPrompt,
          tools: anthropicTools,
          tool_choice: { type: 'auto' },
          messages,
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

      if (response.stop_reason === 'max_tokens') {
        throw new LlmEngineError(
          'max_tokens_reached',
          'a resposta do modelo foi truncada por max_tokens. ' +
            'Aumente AGENTOPS_LLM_MAX_TOKENS (default 4096) e tente novamente.',
          { audit: auditLog.records },
        );
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: await this.executeToolUses(response.content, auditedTools) });
        continue;
      }

      // end_turn (ou stop_reason equivalente): o markdown final do relatório.
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
