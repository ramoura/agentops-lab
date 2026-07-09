# Tarefa 1.0: Fundações — contratos `InvestigationAssistant`, adapter determinístico e `McpToolInvoker.listTools()`

## Visão geral

Refactor **sem mudança de comportamento** que prepara o terreno para o motor LLM: cria os contratos novos em `@agentops/types` (`InvestigationOutcome`, `InvestigationAssistant`, `EngineKind`, `McpToolDefinition`), encapsula o caminho determinístico da V1 no adapter `DeterministicInvestigationAssistant` (parser + engine), migra CLI e eval runner para consumir o adapter, e adiciona `listTools()` ao `McpToolInvoker`. A suíte inteira da V1 permanecendo verde é o critério central — nada muda para o usuário.

Referência: `../techspec-v2.md` — seções "Principais interfaces", "Modelos de dados › InvestigationOutcome" e "Sequenciamento › etapas 1–2".

<skills>
### Conformidade com skills

- `desenvolver-mcp-tools`: `listTools()` é consumo do protocolo MCP — não cria nem altera tools; nomes validados contra `TOOL_NAMES`; superfície do SDK MCP continua isolada em `mcp-tool-invoker.ts`.
- `executar-task`: usar para conduzir a implementação desta tarefa.
</skills>

<requirements>
- Nenhum tipo existente de `@agentops/types` muda (`InvestigationEngine`, `InvestigationReport` intactos) — mudanças 100% aditivas.
- `DeterministicInvestigationAssistant` apenas compõe `PtBrQuestionParser` + `DeterministicInvestigationEngine`: report byte-idêntico ao da V1 (RF4–RF7 preservados por construção).
- Pergunta ambígua → `kind: 'clarification'` sem nenhuma tool invocada (RF3/US10).
- `listTools()` adapta `client.listTools()` do SDK MCP v1.x e valida nomes contra `TOOL_NAMES` (RF12/RF13).
- Componentes intocados: `mcp-servers/agentops-server/**`, `packages/providers/**`, engine, parser, datasets, casos de eval.
</requirements>

## Subtarefas

- [x] 1.1 Adicionar `InvestigationOutcome`, `InvestigationAssistant` em `packages/types/src/report.ts` e `ENGINE_KINDS`/`EngineKind` em `packages/types/src/common.ts` (aditivo).
- [x] 1.2 Criar `packages/core/src/deterministic-assistant.ts` com `DeterministicInvestigationAssistant` (adapter parser + engine) e exportar em `index.ts`.
- [x] 1.3 Migrar `apps/cli-agent/src/main.ts` e `evals/src/runner.ts` para consumir o adapter (fluxo e saída idênticos aos da V1).
- [x] 1.4 Adicionar `McpToolDefinition` e `listTools()` em `apps/cli-agent/src/mcp-tool-invoker.ts`.
- [x] 1.5 Escrever os testes da tarefa e garantir suíte completa da V1 verde (`npm test`, `npm run typecheck`, `npm run eval` com case-001 em 100%).

## Detalhes de implementação

Ver `../techspec-v2.md`:

- "Design de implementação › Principais interfaces" (assinaturas exatas dos contratos).
- "Modelos de dados › `InvestigationOutcome`" (variantes `report`/`markdown`/`clarification`).
- "Modelos de dados › Mapeamento MCP `listTools()`" (validação de nomes; `readOnlyHint`).
- "Considerações técnicas › Nova interface `InvestigationAssistant`" (justificativa).

## Critérios de sucesso

- Suíte completa da V1 passa sem alteração de expectativas (regressão zero).
- `npm run investigate` e `npm run eval` produzem saída idêntica à da V1 (mesmos bytes no relatório).
- `listTools()` retorna as 9 definições com descrição e JSON Schema, pronto para consumo pela tarefa 2.0.
- Cobertura global mantida > 80%.

## Testes da tarefa

Test cases da techspec (numeração da seção "Abordagem de testes"):

### Testes unitários

- [x] (21) `DeterministicInvestigationAssistant` com pergunta válida → `kind: 'report'` com report **byte-idêntico** ao da V1 (mesmo engine, mesmo `StubToolInvoker`).
- [x] (22) Pergunta ambígua → `kind: 'clarification'` com os mesmos `MissingField[]` do parser; **nenhuma** tool invocada.

### Testes de integração

- [x] `listTools()` real (invoker + agentops-server via stdio, padrão do `investigation.integration.test.ts`): retorna exatamente as 9 tools de `TOOL_NAMES`; cada uma com `description` não vazia e `inputSchema.type === 'object'`; `annotations.readOnlyHint === true` em todas (verificação de segurança RF10 pelo lado consumidor).

### Testes E2E (se aplicável)

- [x] Regressão: suíte E2E existente (`cli.e2e.test.ts`, `eval.e2e.test.ts`) permanece verde sem modificação.

## Arquivos relevantes

- `packages/types/src/report.ts`, `packages/types/src/common.ts` — contratos novos (modificar).
- `packages/core/src/deterministic-assistant.ts` (+ `.test.ts`) — adapter (criar).
- `packages/core/src/index.ts` — export (modificar).
- `apps/cli-agent/src/mcp-tool-invoker.ts` — `listTools()` + `McpToolDefinition` (modificar).
- `apps/cli-agent/src/main.ts`, `evals/src/runner.ts` — migração para o adapter (modificar).
- `apps/cli-agent/src/investigation.integration.test.ts` — teste de integração de `listTools()` (modificar).
- `packages/core/src/engine.test.ts` — fonte do `StubToolInvoker` reutilizado.
