# Arquitetura — AgentOps Lab v1

> Especificação completa: [`tasks/prd-incident-investigation-assistant/techspec.md`](../tasks/prd-incident-investigation-assistant/techspec.md) · Requisitos: [`prd.md`](../tasks/prd-incident-investigation-assistant/prd.md)

## Visão geral

Monorepo **npm workspaces** (Node.js 20+, TypeScript ESM estrito) com seis workspaces. O princípio central: **o engine não contém dados** — todo fato do relatório nasce de uma chamada de tool MCP, e a auditoria é estrutural (decorator), não opcional.

| Workspace | Papel |
| --- | --- |
| `@agentops/types` | Fonte única dos contratos: schemas Zod + tipos inferidos (`z.infer`) das 9 tools, entidades de dataset, `InvestigationReport`, `ToolCallRecord`, `EvalCase`/`EvalCaseResult`. Sem dependências internas. |
| `@agentops/providers` | `FakeObservabilityProvider` (lê `datasets/`) e `FakeKnowledgeProvider` (lê `knowledge-base/`), atrás das interfaces estáveis `ObservabilityProvider`/`KnowledgeProvider`. Toda agregação (contagens, percentis, ranking de busca) acontece aqui. |
| `@agentops/agentops-server` | MCP server **real** via stdio (SDK oficial v1.x): módulos `observability/` (5 tools) e `knowledge/` (4 tools) compostos por uma factory. Valida entrada com Zod, delega ao provider, responde `structuredContent` tipado. Logs só em stderr. |
| `@agentops/core` | `PtBrQuestionParser` (extração determinística de serviço/janela/sintoma), `DeterministicInvestigationEngine` (pipeline de 11 passos espelhando a skill), regras de hipótese/confiança e `InMemoryAuditLog`. Depende só de `types` — não conhece MCP nem filesystem. |
| `@agentops/cli-agent` | Entrypoint `npm run investigate`: MCP **client** (`StdioClientTransport` spawna o server via tsx), `McpToolInvoker` adapta `callTool()` à interface `ToolInvoker`, renderer em texto puro PT-BR. |
| `@agentops/evals` | `npm run eval`: runner que executa os casos pelo mesmo caminho da CLI e scorer 100% determinístico. |

## Fluxo de dados (investigação)

```text
pergunta (argv)
  → PtBrQuestionParser → InvestigationContext | faltas → mensagem orientativa (nenhuma tool chamada)
  → DeterministicInvestigationEngine ── ToolInvoker (AuditLog → McpToolInvoker → MCP stdio → agentops-server → provider → datasets/knowledge-base)
        ├─ get_error_summary / get_top_exceptions / get_recent_logs
        ├─ get_latency_summary ×2 (janela do incidente + baseline anterior de mesma duração)
        ├─ get_deployment_events (janela estendida 15 min para trás)
        └─ search_runbooks → get_runbook (top 1) → search_adrs / search_tech_specs (se há exception dominante)
  → regras de hipótese (R1–R3) + classifyConfidence → InvestigationReport
  → renderer (7 seções do relatório + registro de auditoria) → stdout
```

### Raciocínio determinístico (regras de hipótese)

- **R1 — Regressão de deploy**: deploy na janela estendida **e** exception dominante (≥50% dos erros) **e** p99 ≥ 2× baseline → "regressão introduzida no deploy X"; alternativa: degradação da dependência citada na exception.
- **R2 — Dependência degradada**: sem deploy **e** exception dominante de timeout → "dependência externa/banco degradado".
- **R3 — Dados insuficientes**: telemetria toda com `hasData: false` → sem hipótese; o relatório declara o que não foi encontrado.

**Confiança**: `alta` = 3+ classes independentes de evidência convergentes e runbook corrobora; `media` = 2 classes; `baixa` = 0–1 classe ou dados ausentes (`classifyConfidence`, função pura).

## Decisões estruturais (resumo)

1. **Server MCP único** na v1 (fallback autorizado do RF8), com módulos internos `observability/` e `knowledge/` — separar em dois servers no futuro é criar um segundo entrypoint. Registrado em [`decisions.md`](./decisions.md).
2. **`ToolInvoker` como única fronteira do engine** com o mundo externo (RF6): o `InMemoryAuditLog` decora o invoker e materializa o registro de auditoria (RF7) — seq, tool, params, resumo do resultado e duração.
3. **Providers substituíveis** (RF11): trocar `FakeObservabilityProvider` por CloudWatch/Splunk/Prometheus na V3 não altera o contrato das tools.
4. **Ausência de dados é resultado válido** (`hasData: false` / `found: false` / `matches: []`), nunca `isError` (RF14) — o engine distingue "não há dados" (informação investigativa) de "chamada inválida" (bug). Erros de validação usam o envelope MCP `isError: true` com códigos `INVALID_ARGUMENT` / `INVALID_TIME_RANGE` / `EMPTY_QUERY`.
5. **Baseline de latência por segunda chamada de tool** (janela anterior de mesma duração): a comparação fica visível no audit log, em vez de escondida na tool.

## Contratos

Todos em `packages/types` (Zod + `z.infer`), com convenções fixas: campos sem dado normalizados para `null` (nunca omitidos), timestamps ISO 8601 com offset explícito, janelas semiabertas `[from, to)`, buckets de 5 min, limites com defaults (`limit=50` logs, `limit=5` buscas, janela ≤ 24h).

## Eval harness

`evals/cases/*.json` declara `id`, `question`, `expected_findings`, `must_not_include`. O runner conecta um client MCP real, investiga cada caso e o `DeterministicEvalScorer` avalia o texto renderizado + o `InvestigationReport` estruturado: findings, termos proibidos, `cita_evidencias`, `separa_fato_de_hipotese`, `proximos_passos_seguros`. A lista de termos destrutivos do scorer é **independente** da lista do engine — o eval é juiz, não espelho: se o core regredir, o eval acusa.

## Observabilidade da v1

- **Audit log** exibido ao final de cada investigação (feature e instrumento de observabilidade do agente).
- **Logs do server** exclusivamente em stderr (`[agentops-server] LEVEL mensagem`; nível via `AGENTOPS_LOG_LEVEL`, default `warn`) — stdout é o canal JSON-RPC do protocolo.
- **CLI**: progresso em stderr, relatório em stdout (redirecionamento limpo).
- **Eval como monitor de regressão**: `npm run eval` é o health check do agente.
- `ToolCallRecord.durationMs` já prepara a exportação de spans/tracing na V4 sem mudar contratos.

## Testes

Vitest (projects por workspace) + `@vitest/coverage-v8`; meta >80% de linhas/branches em `types`, `providers`, `core`, `agentops-server` e `evals/scoring`. Camadas: unitários (parser, providers, engine com stub de `ToolInvoker`, renderer, scorer), integração via protocolo MCP real (server spawnado por stdio + variante in-process para instrumentação de cobertura) e E2E da CLI e do eval como processos reais (`execa`). Os datasets versionados servem de fixtures — são determinísticos por design.
