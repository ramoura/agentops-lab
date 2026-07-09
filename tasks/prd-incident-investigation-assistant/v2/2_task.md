# Tarefa 2.0: Motor LLM — workspace `packages/llm-engine` com loop agêntico completo

## Visão geral

Cria o workspace `@agentops/llm-engine` inteiro: resolução de config por env (`engine-config` + `LlmEngineError`), construção do system prompt a partir da skill `investigate-incident` (`prompt-builder`), porta fina sobre o `@anthropic-ai/sdk` (`AnthropicChatPort`), mapeamento MCP → tool definitions da Messages API (`tool-mapping`) e o núcleo da V2: `LlmInvestigationAssistant` com o loop agêntico manual (`while stop_reason === 'tool_use'`), auditoria por código via `InMemoryAuditLog` e outcome em markdown. Toda a lógica é testável **sem gastar tokens** via `FakeAnthropicChat`.

Referência: `../techspec-v2.md` — "Arquitetura › fluxo de dados (modo llm)", "Modelos de dados › `LlmEngineConfig`/`LlmEngineError`/Mapeamento/Contrato de formato" e "Sequenciamento › etapa 3".

Depende da tarefa 1.0 (contratos `InvestigationAssistant`/`InvestigationOutcome`/`McpToolDefinition`).

<skills>
### Conformidade com skills

- `desenvolver-mcp-tools`: consumo das 9 tools existentes via definições do `listTools()` (descrições ricas do server orientam o modelo); read-only reforçado pela checagem `readOnlyHint === true` na inicialização; "a investigação passa pelas tools, não pelo prompt" — o prompt carrega processo e regras (skill), nunca dados.
- `executar-task`: usar para conduzir a implementação desta tarefa.
</skills>

<requirements>
- `@anthropic-ai/sdk` instalado **apenas** em `packages/llm-engine` (core/server/providers permanecem sem dependência da Anthropic).
- Loop agêntico com pergunta crua (sem parser — RF2 pelo modelo), `temperature: 0`, `tool_choice: auto`, teto `maxRounds`.
- Auditoria coletada por código (`InMemoryAuditLog.wrap`), nunca gerada pelo modelo (RF7); falhas de tool viram `tool_result` com `is_error: true` sem abortar (RF14).
- System prompt = `skill.md` + contrato de formato (7 títulos exatos de `SECTION_TITLES`, linha `Fonte:` por evidência — RF5, seção "Tools chamadas" proibida no texto) + guardrails (RF6, RF17, RF3 por instrução).
- Erros tipados `LlmEngineError` com os 5 códigos da techspec; `ANTHROPIC_API_KEY` nunca logada.
- Envs e defaults: `AGENTOPS_LLM_MODEL=claude-sonnet-5`, `AGENTOPS_LLM_MAX_TOKENS=4096`, `AGENTOPS_LLM_MAX_ROUNDS=16`.
</requirements>

## Subtarefas

- [ ] 2.1 Criar o workspace `packages/llm-engine` (`package.json` com `@anthropic-ai/sdk` + `@agentops/types`/`@agentops/core`, `tsconfig.json`, registro em `vitest.config.ts` se necessário).
- [ ] 2.2 Implementar `engine-config.ts` (resolução de env, defaults, validação, `LlmEngineError`).
- [ ] 2.3 Implementar `prompt-builder.ts` (leitura de `skills/investigate-incident/skill.md` + contrato de formato + guardrails).
- [ ] 2.4 Implementar `anthropic-chat.ts` (`AnthropicChatPort` + adapter do SDK com tipos `ChatRequest`/`ChatResponse`).
- [ ] 2.5 Implementar `tool-mapping.ts` (MCP `McpToolDefinition[]` → tools Anthropic; validação das 9 tools, nomes e `readOnlyHint`).
- [ ] 2.6 Implementar `llm-investigation-assistant.ts` (loop agêntico, auditoria, agregação de `usage`, outcome markdown).
- [ ] 2.7 Escrever a bateria unitária completa com `FakeAnthropicChat` + `StubToolInvoker` e o teste de integração com MCP real.

## Detalhes de implementação

Ver `../techspec-v2.md`:

- "Arquitetura do sistema › Fluxo de dados (modo llm)" (sequência exata do loop).
- "Modelos de dados" (tabelas de `LlmEngineConfig`, `LlmEngineError`, mapeamento MCP→Anthropic, parâmetros fixados da Messages API, contrato de formato do markdown, variáveis de ambiente).
- "Pontos de integração › API Anthropic" (retries do SDK, tratamento de falha de tool, timeout).
- "Considerações técnicas" (auditoria por código; workspace isolado; temperature 0).

## Critérios de sucesso

- `LlmInvestigationAssistant` completa uma investigação de ponta a ponta com `FakeAnthropicChat` roteirizado, sem rede e sem tokens.
- Nenhuma dependência da Anthropic fora de `packages/llm-engine` (verificável em `package-lock.json`/imports).
- Todos os 20 test cases unitários + integração passando; cobertura global > 80%.
- `npm run typecheck` e suíte completa verdes.

## Testes da tarefa

Test cases da techspec (numeração da seção "Abordagem de testes"):

### Testes unitários

Loop agêntico (`LlmInvestigationAssistant` + `FakeAnthropicChat` + `StubToolInvoker`):

- [ ] (1) Resposta única `end_turn` sem tool_use → outcome `markdown` com o texto do modelo e `audit` vazio.
- [ ] (2) Rodada com um `tool_use` → tool invocada com os argumentos exatos; `tool_result` com o `tool_use_id` correspondente; markdown final da 2ª rodada retornado.
- [ ] (3) Múltiplos blocos `tool_use` na mesma resposta → todas invocadas na ordem; um `tool_result` por `tool_use_id`, todos na mesma mensagem `user` seguinte.
- [ ] (4) Encadeamento multi-rodada (3+) → histórico de `messages` cresce corretamente (assistant/user alternados, conteúdo preservado).
- [ ] (5) `ToolInvocationError` → `tool_result` com `is_error: true` e a mensagem; loop **continua** e outcome final é produzido.
- [ ] (6) Tool desconhecida pedida pelo modelo → `tool_result` com `is_error: true` ("tool desconhecida"), sem invocar o `ToolInvoker`.
- [ ] (7) Auditoria: `ToolCallRecord` com `seq` incremental, `params` e `durationMs`; falhas com `resultSummary: "ERRO: …"`; `outcome.audit` idêntico a `auditLog.records`.
- [ ] (8) `maxRounds` excedido → `LlmEngineError('max_rounds_exceeded')`; audit das rodadas executadas preservado no erro.
- [ ] (9) `stop_reason: 'max_tokens'` → `LlmEngineError('max_tokens_reached')`.
- [ ] (10) `end_turn` sem bloco de texto → `LlmEngineError('empty_response')`.
- [ ] (11) Erro da API (rejeição do port) → `LlmEngineError('api_error')` com causa encadeada.
- [ ] (12) Requisição enviada: `model`, `max_tokens`, `temperature: 0`, `system` e `tools` conforme config e definições; `tool_choice` é `auto`.
- [ ] (13) Pergunta do usuário entra como primeira mensagem `user`, crua (sem parser).

Mapeamento de tools:

- [ ] (14) `McpToolDefinition[]` → formato Anthropic: `name`/`description` preservados, `inputSchema` → `input_schema` (passthrough).
- [ ] (15) 9 tools presentes → ok; lista sem uma das 9 → erro orientativo.
- [ ] (16) Nome fora de `TOOL_NAMES` → erro de inicialização.

Config e prompt:

- [ ] (17) `ANTHROPIC_API_KEY` ausente → `LlmEngineError('missing_api_key')` sem tocar rede.
- [ ] (18) Defaults aplicados; overrides por env respeitados; `AGENTOPS_LLM_MAX_TOKENS=abc`/`0`/negativo → erro orientativo.
- [ ] (19) System prompt contém: `skill.md` integral, os 7 títulos exatos, regra da linha `Fonte:`, proibição de inventar dados e de seção "Tools chamadas".
- [ ] (20) `skill.md` ausente/ilegível → erro orientativo citando o caminho esperado.

### Testes de integração

- [ ] Loop LLM com MCP real e modelo fake: `FakeAnthropicChat` roteirizado pedindo `get_error_summary` e `get_top_exceptions` do cenário checkout-api via `McpToolInvoker` real → `tool_result` com dados reais dos datasets; audit com 2 registros; markdown final gerado.

### Testes E2E (se aplicável)

- Não se aplica nesta tarefa (E2E entram na 3.0, junto com a CLI).

## Arquivos relevantes

- `packages/llm-engine/{package.json,tsconfig.json}` — workspace novo (criar).
- `packages/llm-engine/src/llm-investigation-assistant.ts` (+ `.test.ts`) — loop agêntico (criar).
- `packages/llm-engine/src/anthropic-chat.ts` (+ `.test.ts`) — porta do SDK Anthropic (criar).
- `packages/llm-engine/src/prompt-builder.ts` (+ `.test.ts`) — system prompt (criar).
- `packages/llm-engine/src/engine-config.ts` (+ `.test.ts`) — config/erros (criar).
- `packages/llm-engine/src/tool-mapping.ts` (+ `.test.ts`) — mapeamento (criar).
- `skills/investigate-incident/skill.md` — fonte do system prompt (ler; não modificar).
- `packages/core/src/audit-log.ts` — `InMemoryAuditLog` reutilizado.
- `packages/core/src/engine.test.ts` — padrão do `StubToolInvoker` reutilizado.
