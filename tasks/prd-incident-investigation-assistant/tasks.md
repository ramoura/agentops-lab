# Resumo das tarefas de implementação de AgentOps Lab — Incident Investigation Assistant (v1)

> PRD: [`prd.md`](./prd.md) · Techspec: [`techspec.md`](./techspec.md)
>
> Lista mínima: 6 tarefas cobrindo os 10 passos de sequenciamento da techspec e os 76 casos de teste (1–76), na ordem de dependências: contratos → dados/providers → server MCP → core → CLI → evals/docs.

## Tarefas

- [x] 1.0 Bootstrap do monorepo + contratos e schemas (`@agentops/types`)
- [x] 2.0 Datasets simulados, knowledge base, skill `investigate-incident` e fake providers (`@agentops/providers`)
- [x] 3.0 MCP server `agentops-server` com as 9 tools read-only
- [x] 4.0 Core determinístico: QuestionParser, InvestigationEngine e AuditLog (`@agentops/core`)
- [x] 5.0 CLI `npm run investigate`: MCP client, renderer e fluxos de erro (`@agentops/cli-agent`)
- [x] 6.0 Eval harness (`@agentops/evals`), documentação e validação final
