# Resumo das tarefas de implementação de V2.5 — Prompt caching no loop agêntico

> Fonte: `../techspec-v2.5.md` (complementa `../techspec-v2.md`; PRD: `../prd.md`; roadmap: `docs/roadmap.md`, seção "V2.5").
> Ordem estritamente sequencial: cada tarefa depende da anterior.

## Tarefas

- [x] 1.0 Fundações do cache: config (`AGENTOPS_LLM_CACHE`) + porta/adapter (`SystemBlock[]`, `cache_control`, `ChatUsage`)
- [x] 2.0 Loop agêntico: posicionamento dos 2 breakpoints e agregação de cache no `LlmUsage`
- [x] 3.0 Exposição das métricas: linha de custo na CLI e linha de cache por caso no eval
- [x] 4.0 Validação real e documentação: smoke leniente, experimento antes/depois e registro dos números
