# Decisões arquiteturais — AgentOps Lab

Registro exigido pelo `AGENTS.md` (§4 e §12). Formato: contexto → decisão → consequências.

## D1 — Um único MCP server na v1 (`agentops-server`)

- **Contexto**: o `AGENTS.md` prevê dois servers (`observability-server` e `knowledge-server`); o RF8 do PRD autoriza explicitamente o fallback de server único quando dois gerarem complexidade excessiva na primeira versão.
- **Decisão**: um único server MCP real via stdio, com as tools organizadas em módulos internos `observability/` (5 tools) e `knowledge/` (4 tools) compostos por uma factory comum (`server-factory.ts`).
- **Consequências**: menos processos para orquestrar na PoC; a separação futura é criar um segundo entrypoint chamando apenas o módulo correspondente e ajustar o spawn na CLI — factory e módulos não mudam.

## D2 — SDK MCP oficial v1.x (não o v2 beta)

- **Contexto**: o v2 do SDK (`@modelcontextprotocol/server`/`client`) tem lançamento previsto para 28/07/2026, com breaking changes.
- **Decisão**: usar `@modelcontextprotocol/sdk` v1.x, o release estável e suportado.
- **Consequências**: a superfície de contato com o SDK fica isolada em dois arquivos (`server-factory.ts` + registro de tools; `mcp-tool-invoker.ts`), tornando a migração v2 um exercício localizado — planejado no [`roadmap.md`](./roadmap.md).

## D3 — Monorepo npm workspaces

- **Contexto**: o projeto precisa de separação clara entre domínio, providers, server, CLI e evals (AGENTS.md §3), sem overhead de tooling.
- **Decisão**: npm workspaces nativo (`packages/*`, `mcp-servers/*`, `apps/*`, `evals`), sem Nx/Turbo/Lerna.
- **Consequências**: dependências internas por nome de pacote (`@agentops/*` apontando para `src/*.ts` via `exports`), um único `node_modules`, zero configuração extra. Suficiente para um laboratório local.

## D4 — Vitest como framework de testes

- **Contexto**: TypeScript ESM estrito; necessidade de unitários, integração com processos MCP e E2E de CLI no mesmo runner.
- **Decisão**: Vitest com `projects` por workspace + `@vitest/coverage-v8`; E2E via `execa` (não há frontend — Playwright não se aplica).
- **Consequências**: suite única (`npm test`), cobertura consolidada, ESM/TS sem transpilação adicional.

## D5 — `tsx` em runtime, sem etapa de build

- **Contexto**: a CLI precisa spawnar o server TypeScript; um passo de build criaria dessincronia código/dist num laboratório em edição constante.
- **Decisão**: executar tudo com `tsx` (CLI, server spawnado e eval runner).
- **Consequências**: `tsx` vira dependência de runtime do lab (aceitável: não é pacote publicado); nenhum artefato compilado no repositório.

## D6 — Ausência de dados ≠ erro nas tools

- **Contexto**: o engine precisa distinguir "não há dados" (informação investigativa, US9) de "chamada inválida" (bug), conforme RF14 e a skill `desenvolver-mcp-tools`.
- **Decisão**: consultas válidas sem dados retornam resultado bem formado (`hasData: false`, `found: false`, `matches: []`); o envelope MCP `isError: true` fica reservado a erros de validação de entrada, com códigos `INVALID_ARGUMENT`/`INVALID_TIME_RANGE`/`EMPTY_QUERY`.
- **Consequências**: o relatório declara dados faltantes em vez de abortar; o eval consegue pontuar o cenário de ausência (case-003).

## D7 — Scorer do eval como juiz independente

- **Contexto**: o critério `proximos_passos_seguros` poderia reutilizar o validador de passos destrutivos do core, mas um eval que usa a própria função do sistema sob teste passa trivialmente.
- **Decisão**: o `DeterministicEvalScorer` mantém a própria lista de termos destrutivos e a própria normalização, sem importar as regras do engine.
- **Consequências**: se as regras de segurança do core regredirem, `npm run eval` acusa; custo de manter duas listas semelhantes é aceito de propósito.

## D8 — Entrypoints fora da medição de cobertura

- **Contexto**: `apps/cli-agent/src/main.ts` e `mcp-servers/agentops-server/src/main.ts` são composition roots exercitados pelos testes E2E/integração como **processos filhos**, que o coverage v8 do Vitest não instrumenta — apareceriam como 0% mesmo cobertos.
- **Decisão**: excluí-los do cálculo de cobertura (`vitest.config.ts`), mantendo-os cobertos pelos testes E2E (71–76 da techspec).
- **Consequências**: a métrica de cobertura reflete o código efetivamente instrumentável; a meta >80% de linhas/branches vale para `types`, `providers`, `core`, `agentops-server` e `evals/scoring`.
