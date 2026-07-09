# Roadmap — AgentOps Lab

A v1 é 100% local, determinística e read-only; a V2 (motor LLM) está **entregue**. As fases abaixo são direção de evolução — a arquitetura atual foi desenhada para suportá-las **sem reestruturação** (interfaces estáveis de provider, contratos únicos em `types`, superfícies dos SDKs MCP e Anthropic isoladas em arquivos únicos).

## Migração do SDK MCP v1.x → v2 (exercício de estudo)

O projeto usa o SDK oficial `@modelcontextprotocol/sdk` **v1.x** (release estável). O v2 (pacotes `@modelcontextprotocol/server` / `@modelcontextprotocol/client`) traz breaking changes conhecidos. A migração é um exercício de estudo planejado e **localizado por design**: a superfície de contato com o SDK está isolada em

- `mcp-servers/agentops-server/src/server-factory.ts` (+ registro das tools) — lado server;
- `apps/cli-agent/src/mcp-tool-invoker.ts` — lado client.

Nenhum outro pacote importa o SDK. O eval harness serve de rede de segurança da migração: `npm run eval` deve permanecer com case-001 em 100% antes e depois.

## V2 — Motor LLM reutilizando as mesmas MCP tools ✅ (entregue)

Especificação: [`techspec-v2.md`](../tasks/prd-incident-investigation-assistant/techspec-v2.md).

- **Entregue**: `LlmInvestigationAssistant` (`packages/llm-engine`) com loop agêntico manual sobre a Messages API da Anthropic, consumindo as **mesmas 9 tools MCP** descobertas em runtime via `listTools()` (nenhuma mudança em server/providers/datasets). Em vez de forçar a interface `InvestigationEngine` (que exige contexto parseado e report estruturado), a V2 introduziu a abstração `InvestigationAssistant` (pergunta crua → `InvestigationOutcome`), com o caminho da V1 preservado byte-idêntico atrás do adapter `DeterministicInvestigationAssistant`.
- **Entregue**: a skill `investigate-incident` passou de "processo espelhado em código" a **contexto do modelo** (system prompt com contrato de formato + guardrails).
- **Entregue**: seleção de engine por `--engine=deterministic|llm` + env `AGENTOPS_ENGINE` na CLI e no eval, com o determinístico como default sem API key; `npm run eval:llm` como smoke opt-in.
- **Entregue**: scoring do modo llm 100% determinístico via `TextReportScorer` (mesmos 5 grupos de critérios sobre as seções do markdown), com o scorer da V1 intocado.
- **Pendente para uma V2.x**: tolerância de fraseado/sinônimos nos findings (descartada de propósito nesta fase) e, se a taxa de flake incomodar, um segundo scorer.

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
