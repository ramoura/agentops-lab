# Tarefa 1.0: Bootstrap do monorepo + contratos e schemas (`@agentops/types`)

## Visão geral

Criar a fundação do projeto: monorepo npm workspaces (Node.js ≥ 20, TypeScript ESM estrito), configuração de testes (Vitest + coverage) e runtime `tsx`, e o pacote `@agentops/types` com **todos** os contratos do sistema — tipos das 9 tools, entidades de dataset, relatório, auditoria e eval — com schemas Zod co-localizados e tipos inferidos (`z.infer`). Nenhum outro pacote pode ser iniciado antes desta entrega.

<skills>
### Conformidade com skills

- `desenvolver-mcp-tools` — os contratos in/out das tools vivem em `packages/types` (regra da skill); schemas Zod de entrada com limites e defaults fixados (`limit`, janela ≤ 24h).
</skills>

<requirements>
- Monorepo com workspaces e scripts raiz `investigate`, `eval` e `test` (base para RF1 e RF23).
- Contratos estruturados, tipados e previsíveis para todas as tools (RF9).
- Tipos de entrada/saída das 9 tools (RF12, RF13), `LogEntry`, `MetricPoint`, `DeploymentEvent`, `InvestigationContext`, `InvestigationReport`, `Hypothesis`, `ToolCallRecord`, `EvalCase`, `EvalCaseResult` e envelope `ToolError` (`INVALID_ARGUMENT`, `INVALID_TIME_RANGE`, `EMPTY_QUERY`) — conforme "Modelos de dados" da techspec.
- Interfaces `ToolInvoker`, `AuditLog`, `QuestionParser`, `InvestigationEngine`, `ObservabilityProvider`, `KnowledgeProvider`, `EvalScorer` (RF6, RF7, RF11).
- Campos sem dado normalizados para `null`; timestamps ISO 8601 com offset explícito; janelas `[from, to)`.
</requirements>

## Subtarefas

- [x] 1.1 `package.json` raiz (workspaces, scripts `investigate`/`eval`/`test`), `tsconfig.base.json`, `vitest.config.ts` (projects + coverage-v8), dependências (`@modelcontextprotocol/sdk` v1.x, `zod` v3, `typescript`, `tsx`, `vitest`, `execa`).
- [x] 1.2 `packages/types/src/tools/observability.ts` e `tools/knowledge.ts`: schemas Zod de entrada (com refinements `INVALID_TIME_RANGE`, `EMPTY_QUERY`, limites/máximos) e de saída das 9 tools.
- [x] 1.3 `packages/types/src/datasets.ts`, `report.ts`, `audit.ts`, `eval.ts`: entidades internas e interfaces (`ToolInvoker`, providers, engine, scorer); `index.ts` exportando tudo.
- [x] 1.4 Testes unitários dos schemas (`schemas.test.ts`).

## Detalhes de implementação

Ver techspec: seções **"Arquitetura do sistema"** (estrutura de pastas e responsabilidade do `@agentops/types`), **"Principais interfaces"**, **"Modelos de dados"** (tabelas campo a campo, variantes `hasData: false`/`found: false`) e **"Parâmetros e defaults fixados"**.

## Critérios de sucesso

- `npm install` limpo e `npm test` executa (mesmo com poucos testes) sem erro de compilação TypeScript estrito.
- Todos os contratos citados na techspec existem e são exportados por `@agentops/types`, sem dependências internas.
- Schemas Zod rejeitam entradas inválidas com os códigos de erro definidos.

## Testes da tarefa

Casos da techspec: **60–61**.

### Testes unitários

- [x] 60. Cada schema de entrada de tool aceita o exemplo válido documentado e rejeita: timestamp sem offset, `level` fora do enum, `limit` acima do máximo, `service` vazio.
- [x] 61. `from >= to` rejeitado pelo refinement `INVALID_TIME_RANGE`.

### Testes de integração

- [ ] N/A nesta tarefa (contratos puros).

## Arquivos relevantes

- `package.json`, `tsconfig.base.json`, `vitest.config.ts` (raiz)
- `packages/types/src/tools/observability.ts`, `tools/knowledge.ts`, `datasets.ts`, `report.ts`, `audit.ts`, `eval.ts`, `index.ts`
- `packages/types/src/schemas.test.ts`
