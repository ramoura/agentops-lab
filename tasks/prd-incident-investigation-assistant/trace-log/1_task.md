# Tarefa 1.0: Fundações — schema `InvestigationTraceRecord`, captura de rodadas e módulo `trace-log.ts`

## Visão geral

Cria a base de dados e escrita do trace de investigação, sem tocar nos entrypoints (`main.ts`/`runner.ts`) ainda: o contrato `InvestigationTraceRecord` (+ schemas auxiliares de rodada) em `@agentops/types`; a captura rodada-a-rodada no motor LLM (`LlmInvestigationAssistant.lastTrace`, mesmo padrão do `lastUsage` já existente); e o módulo `apps/cli-agent/src/trace-log.ts` que monta e grava (append-only, JSONL) um registro. Camada 100% unitária/testável com fakes — nenhuma mudança de comportamento observável em `npm run investigate`/`npm run eval` ainda (isso é a tarefa 2.0).

Referência: `../mini-spec-investigation-trace-log.md` — seções "Design › Formato do registro", "Design › Captura das rodadas" e "Design › Onde monta e grava".

<skills>
### Conformidade com skills

- `executar-task`: usar para conduzir a implementação desta tarefa.
- Nenhuma outra skill do projeto se aplica diretamente — esta tarefa não cria/altera MCP tools (`desenvolver-mcp-tools` não se aplica: é consumo read-only de dados já produzidos pelo loop, não uma tool nova).
</skills>

<requirements>
- Nenhum tipo/schema existente muda; tudo é aditivo (`InvestigationReport`, `InvestigationOutcome`, `ToolCallRecord`, `EvalCaseResult`, `LlmUsage` intactos).
- `RoundTrace` captura `round`, `assistantContent`, `stopReason`, `usage` e `toolResults`, sem nunca vazar `cache_control` (metadado de infraestrutura de cache, não conteúdo da investigação).
- No motor LLM, `toolResults[].content` é o texto exato enviado ao modelo (o mesmo `content` que `executeToolUses` já calcula) — não uma versão resumida.
- `appendTraceRecord` é append-only (uma linha por chamada) e cria o diretório de destino se ausente; nunca reescreve o arquivo inteiro.
- `buildTraceRecord` centraliza a extração de `audit` a partir do `outcome` pelos 3 `kind` (`report`/`markdown`/`clarification`), para reuso idêntico pela tarefa 2.0 nos dois entrypoints.
</requirements>

## Subtarefas

- [x] 1.1 Adicionar `engineKindSchema` em `packages/types/src/common.ts` (aditivo — `z.enum(ENGINE_KINDS)`; pré-requisito do schema do trace, referenciado mas não declarado na mini-spec).
- [x] 1.2 Criar `packages/types/src/trace.ts`: `roundContentBlockSchema`, `roundToolResultSchema`, `roundUsageSchema`, `roundTraceSchema`/`RoundTrace`, `investigationTraceRecordSchema`/`InvestigationTraceRecord` (com o `outcomeTraceSchema` discriminado por `kind`); exportar em `packages/types/src/index.ts`.
- [x] 1.3 Estender `packages/llm-engine/src/llm-investigation-assistant.ts`: campo privado `trace: RoundTrace[]`, getter `lastTrace`, captura de um `RoundTrace` por rodada (ramo `tool_use` e ramo final `end_turn`), descartando `cache_control` ao montar `assistantContent`/`toolResults`.
- [x] 1.4 Criar `apps/cli-agent/src/trace-log.ts`: `generateRunId()`, `buildTraceRecord(input)`, `appendTraceRecord(path, record)`; adicionar subpath export `"./trace-log"` em `apps/cli-agent/package.json`.
- [x] 1.5 Escrever os testes da tarefa e garantir suíte existente verde (`npm test`, `npm run typecheck`).

## Detalhes de implementação

Ver `../mini-spec-investigation-trace-log.md`:

- "Design › Formato do registro" (schemas Zod exatos, incluindo o exemplo JSON completo).
- "Design › Captura das rodadas" (onde e o quê capturar no loop, sem alterar sua lógica).
- "Design › Onde monta e grava" (assinaturas de `buildTraceRecord`/`generateRunId`/`appendTraceRecord`, subpath export).
- Nota: a mini-spec referencia `engineKindSchema` no shape de `InvestigationTraceRecord` mas não o declara explicitamente — é a adição pequena e aditiva da subtarefa 1.1.

## Critérios de sucesso

- `investigationTraceRecordSchema.parse(...)` valida um registro de cada `outcome.kind` (`report`/`markdown`/`clarification`) construído a partir de dados reais dos testes existentes (fixtures do `packages/core`/`packages/llm-engine`).
- `LlmInvestigationAssistant.lastTrace` reflete fielmente o loop: uma entrada por rodada, na ordem, sem `cache_control` em nenhum bloco.
- `appendTraceRecord` grava JSONL válido, uma linha por chamada, criando o diretório quando necessário.
- Nenhuma mudança de comportamento observável em `npm run investigate`/`npm run eval` (o módulo novo não é chamado por ninguém ainda).
- Cobertura global mantida > 80%.

## Testes da tarefa

### Testes unitários

- [x] `investigationTraceRecordSchema` aceita um registro válido para cada `outcome.kind` (`report`, `markdown`, `clarification`).
- [x] `investigationTraceRecordSchema` rejeita `eval.score` fora de `[0,1]` (paridade com o teste existente de `evalCaseResultSchema`).
- [x] `LlmInvestigationAssistant` (extensão dos testes existentes com `FakeAnthropicChat`/`StubToolInvoker`): `lastTrace` tem uma entrada por rodada, na ordem correta.
- [x] Rodada com `tool_use` → `toolResults` preenchido e correlacionado por `tool_use_id`; rodada final (`end_turn`) → `toolResults: []`.
- [x] `cache_control` nunca aparece em `assistantContent`/`toolResults` de nenhum `RoundTrace`, mesmo com `cacheEnabled: true` (V2.5 ligado).
- [x] `apps/cli-agent/src/trace-log.test.ts`: `appendTraceRecord` cria o diretório quando ausente; duas chamadas seguidas produzem duas linhas, cada uma um JSON válido via `investigationTraceRecordSchema.safeParse`.
- [x] `buildTraceRecord` monta `audit` corretamente para os 3 `outcome.kind` (`report` → `outcome.report.audit`; `markdown` → `outcome.audit`; `clarification` → `[]`).

### Testes de integração

- [x] Não aplicável nesta tarefa — sem wiring aos entrypoints (cobertura de integração real é da tarefa 2.0).

### Testes E2E (se aplicável)

- [x] Não aplicável nesta tarefa.

## Arquivos relevantes

- `packages/types/src/common.ts` — `engineKindSchema` (modificar).
- `packages/types/src/trace.ts` (+ teste em `packages/types/src/schemas.test.ts`) — schemas do trace (criar/modificar).
- `packages/types/src/index.ts` — export (modificar).
- `packages/llm-engine/src/llm-investigation-assistant.ts` (+ `.test.ts`) — `RoundTrace`/`lastTrace` (modificar).
- `apps/cli-agent/src/trace-log.ts` (+ `.test.ts`) — `buildTraceRecord`/`generateRunId`/`appendTraceRecord` (criar).
- `apps/cli-agent/package.json` — subpath export `./trace-log` (modificar).
