# Resumo das tarefas de implementação — Trace completo de investigação em disco (JSONL)

> Fonte: `../mini-spec-investigation-trace-log.md` (complementa `../techspec-v2.md`/`../techspec-v2.5.md`; PRD: `../prd.md`). Não numerada no `docs/roadmap.md` — candidata a V2.13 quando aprovada.
> Ordem estritamente sequencial: cada tarefa depende da anterior.

## Tarefas

- [x] 1.0 Fundações: schema `InvestigationTraceRecord`, captura de rodadas (`LlmInvestigationAssistant.lastTrace`) e módulo `trace-log.ts`
- [x] 2.0 Integração: `AGENTOPS_TRACE_LOG` no `investigate` e no `eval`, `runId` compartilhado e regressão de saída
