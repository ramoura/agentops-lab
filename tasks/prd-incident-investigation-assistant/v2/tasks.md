# Resumo das tarefas de implementação de V2 — Motor LLM reutilizando as mesmas MCP tools

> Fonte: `../techspec-v2.md` (PRD: `../prd.md`, seção "Direção de evolução futura" / V2).
> Ordem estritamente sequencial: cada tarefa depende da anterior.

## Tarefas

- [x] 1.0 Fundações: contratos `InvestigationAssistant`, adapter determinístico e `McpToolInvoker.listTools()`
- [x] 2.0 Motor LLM: workspace `packages/llm-engine` com loop agêntico completo
- [x] 3.0 Integração: CLI `--engine`, eval nos 2 motores e documentação
