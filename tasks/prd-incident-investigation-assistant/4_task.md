# Tarefa 4.0: Core determinístico: QuestionParser, InvestigationEngine e AuditLog (`@agentops/core`)

## Visão geral

Implementar o raciocínio da v1 sem LLM: `QuestionParser` (extração determinística de serviço/janela/sintoma em PT-BR por regex/dicionário, sem adivinhar), `InvestigationEngine` (pipeline fixo de 11 passos espelhando a skill, regras de hipótese R1–R3 e `classifyConfidence`), montagem do `InvestigationReport` e `AuditLog` como decorator de `ToolInvoker`. O pacote depende só de `@agentops/types` — não conhece MCP nem filesystem — e é testável com `ToolInvoker` stub, em paralelo à Tarefa 3.0.

<skills>
### Conformidade com skills

- `desenvolver-mcp-tools` — o engine consome tools exclusivamente via `ToolInvoker` (nunca providers direto); trata `matches: []`/`hasData: false` como informação investigativa, registrando em `missingData`.
</skills>

<requirements>
- Extração de serviço, janela e sintoma da pergunta (RF2); sem serviço ou janela → curto-circuito com orientação, sem chamar tool e sem adivinhar (RF3).
- Investigação conduzida exclusivamente via tools; nenhum fato no relatório sem origem em chamada de tool (RF6).
- Relatório com as 7 seções na ordem do RF4; toda evidência com `source.tool` + `source.reference` (RF5).
- Ordem das etapas e formato conforme a skill `investigate-incident` (RF16); hipóteses com confiança baixa/média/alta, dados faltantes declarados, nenhuma recomendação perigosa em 1ª posição (RF17).
- Auditoria completa: `seq`, tool, params exatos e resumo por chamada (RF7).
- Regras determinísticas R1 (regressão de deploy), R2 (dependência degradada), R3 (dados insuficientes → `primaryHypothesis: null`, US9); baseline por segunda chamada de `get_latency_summary`; deploys com janela estendida 15 min para trás.
</requirements>

## Subtarefas

- [x] 4.1 `question-parser.ts`: serviço (crases/kebab-case), janelas PT-BR ("entre 10h e 10h30 em 2026-07-08", "das/às", ISO), sintomas ("erro 5xx", "timeout", "latência alta"), normalização de acentos/caixa, `ParseResult` com `missing` + hints.
- [x] 4.2 `tool-invoker.ts` e `audit-log.ts`: interface + decorator que grava `ToolCallRecord` (seq incremental, params ecoados, resultSummary, durationMs).
- [x] 4.3 `engine.ts`: pipeline dos 11 passos (passos 2–8 auditados; passo 8 condicionado a exception dominante; tool com `isError` degrada para `missingData` sem abortar).
- [x] 4.4 `rules/hypotheses.ts` (R1–R3) e `rules/confidence.ts` (`classifyConfidence` como função pura).
- [x] 4.5 `report.ts`: montagem do `InvestigationReport` + validador de `safeNextSteps` (1º passo nunca destrutivo).
- [x] 4.6 Testes unitários do parser e do engine com `ToolInvoker` stub.

## Detalhes de implementação

Ver techspec: **"Pipeline do Investigation Engine"** (tabela dos 11 passos, regras R1–R3, classificação de confiança), **"Principais interfaces"**, variante de pergunta ambígua em `InvestigationContext` e decisões 3, 4 e 6 em **"Principais decisões"**.

## Critérios de sucesso

- Com stubs devolvendo dados do case-001, o engine produz hipótese de regressão de deploy com confiança `alta` e ordem de chamadas idêntica aos passos 2–8 da skill.
- Com stubs vazios, o relatório não contém nenhum fato inventado (anti-alucinação) e declara dados faltantes.
- Parser nunca adivinha: toda ausência vira `missing` com hint acionável.

## Testes da tarefa

Casos da techspec: **1–14** e **36–47**.

### Testes unitários — QuestionParser

- [x] 1. Extrai serviço entre crases: `` `checkout-api` `` → `checkout-api`.
- [x] 2. Extrai serviço kebab-case sem crases: "o checkout-api teve…".
- [x] 3. Janela "entre 10h e 10h30 em 2026-07-08" → `10:00`/`10:30` com offset `-03:00`.
- [x] 4. Janela "entre 10:00 e 10:30 em 2026-07-08" (formato com dois-pontos).
- [x] 5. Janela "das 14h às 14h20 em 2026-07-08" (variação "das/às").
- [x] 6. Timestamps ISO completos na pergunta são aceitos diretamente.
- [x] 7. Hora sem data → `ok: false`, `missing` contém `window` com hint pedindo a data (não adivinha "hoje").
- [x] 8. Pergunta sem serviço identificável → `missing` contém `service`.
- [x] 9. Pergunta sem nenhuma referência temporal → `missing` contém `window`.
- [x] 10. Pergunta sem serviço **e** sem janela → `missing` lista ambos.
- [x] 11. Sintomas "erro 5xx", "timeout" e "latência alta" detectados.
- [x] 12. Pergunta sem sintoma → `symptom: null` (investigação genérica prossegue).
- [x] 13. Range invertido ("entre 10h30 e 10h") → `missing`/erro orientativo, nunca janela negativa.
- [x] 14. Acentos e caixa não afetam a extração ("LATÊNCIA", "latencia").

### Testes unitários — InvestigationEngine (ToolInvoker stub)

- [x] 36. Cenário principal: ordem das chamadas corresponde exatamente aos passos 2–8 da skill (RF16).
- [x] 37. Relatório contém as 7 seções na ordem do RF4.
- [x] 38. Toda evidência tem `source.tool` e `source.reference` não vazios (RF5).
- [x] 39. R1 dispara: deploy + exception dominante + p99 ≥2× baseline → hipótese "regressão do deploy", confiança `alta` (runbook corrobora).
- [x] 40. R1 sem corroboração de runbook → confiança `media` e `missingData` menciona runbook não encontrado.
- [x] 41. R2 dispara: sem deploy + timeout dominante → hipótese "dependência degradada".
- [x] 42. R3 dispara: tudo `hasData: false` → `primaryHypothesis: null`, `confidence: baixa`, `missingData` preenchido; nenhuma evidência fabricada (US9).
- [x] 43. Passo 8 (ADRs/tech specs) pulado sem exception dominante — auditoria comprova a ausência da chamada.
- [x] 44. `safeNextSteps[0]` nunca contém termos destrutivos (RF17).
- [x] 45. Com stubs vazios, o relatório não menciona `DatabaseTimeoutException` (anti-alucinação, RF6).
- [x] 46. AuditLog: `seq` incremental, params ecoados byte a byte, um registro por chamada (RF7).
- [x] 47. Tool retornando `isError` → falha registrada na auditoria e degradada para `missingData` (não aborta).

### Testes de integração

- [ ] Engine + server reais ficam na Tarefa 5.0 (testes 67–69), pois dependem do `McpToolInvoker`.

## Arquivos relevantes

- `packages/core/src/question-parser.ts`, `engine.ts`, `rules/hypotheses.ts`, `rules/confidence.ts`, `report.ts`, `audit-log.ts`, `tool-invoker.ts`
- `packages/core/src/question-parser.test.ts`, `engine.test.ts`
- `skills/investigate-incident/skill.md` (fonte da ordem dos passos — Tarefa 2.0)
