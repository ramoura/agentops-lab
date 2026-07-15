# Resumo das tarefas de implementação de V2.1 — Tolerância de fraseado no scorer

> Fonte: `../techspec-v2.1.md` (complementa `../techspec-v2.md`; PRD: `../prd.md`; roadmap: `docs/roadmap.md`, seção "V2.1").
> Ordem estritamente sequencial: a tarefa 2.0 depende da 1.0 (usa o schema e os scorers da 1.0 sobre o dado real).

## Tarefas

- [x] 1.0 Schema tolerante (`FindingSpec`) e os dois scorers (`DeterministicEvalScorer` intocado em comportamento, `TextReportScorer` com matching *any-of*)
- [x] 2.0 Fechamento do flake real (case-003), validação ponta a ponta (integração/E2E) e documentação (roadmap + D14)
