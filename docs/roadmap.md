# Roadmap — AgentOps Lab

A v1 é 100% local, determinística e read-only. As fases abaixo são direção de evolução — a arquitetura atual foi desenhada para suportá-las **sem reestruturação** (interfaces estáveis de provider, contratos únicos em `types`, superfície do SDK MCP isolada em dois arquivos).

## Migração do SDK MCP v1.x → v2 (exercício de estudo)

O projeto usa o SDK oficial `@modelcontextprotocol/sdk` **v1.x** (release estável). O v2 (pacotes `@modelcontextprotocol/server` / `@modelcontextprotocol/client`) traz breaking changes conhecidos. A migração é um exercício de estudo planejado e **localizado por design**: a superfície de contato com o SDK está isolada em

- `mcp-servers/agentops-server/src/server-factory.ts` (+ registro das tools) — lado server;
- `apps/cli-agent/src/mcp-tool-invoker.ts` — lado client.

Nenhum outro pacote importa o SDK. O eval harness serve de rede de segurança da migração: `npm run eval` deve permanecer com case-001 em 100% antes e depois.

## V2 — Motor LLM reutilizando as mesmas MCP tools

- Adicionar um `LlmInvestigationEngine` implementando a mesma interface `InvestigationEngine`, usando a API da Anthropic com tool use apontando para as **mesmas 9 tools MCP** (nenhuma mudança em server/providers).
- A skill `investigate-incident` passa de "processo espelhado em código" a **contexto carregado no prompt** do modelo.
- O eval determinístico continua válido (matching sobre o relatório final); avaliar acrescentar tolerância de fraseado e, se necessário, um segundo scorer.
- Seleção de engine por flag/env na CLI (`--engine=deterministic|llm`), mantendo o determinístico como default sem API key.

## V3 — Providers reais de observabilidade

- Implementar `ObservabilityProvider` para CloudWatch, Splunk, Prometheus e/ou OpenTelemetry — **sem tocar no contrato das tools** (RF11).
- Knowledge base real: repositório de runbooks/ADRs da organização (git) atrás de `KnowledgeProvider`.
- Credenciais de menor privilégio (somente leitura), validação de host/escopo, e seleção de provider por configuração do server.
- Datasets fake permanecem como fixtures dos testes e dos evals.

## V4 — Tracing, policies e governança

- Exportar o audit log como spans OpenTelemetry (`ToolCallRecord.durationMs` já existe nos contratos).
- Policies declarativas de acesso por tool (que serviços/janelas podem ser consultados) e rate limiting.
- Audit log persistente (arquivo/banco) com correlação por investigação.
- Hardening: sandboxing do server, allowlist de diretórios dos providers de filesystem.

## V5 — Interfaces adicionais

- Integração com Slack (perguntas no canal de incidente) e/ou Jira (anexar relatório ao ticket), se fizer sentido.
- UI web de leitura dos relatórios e do histórico de investigações.
- Catálogo maior de cenários simulados e de casos de eval.
