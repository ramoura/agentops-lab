# Tarefa 3.0: Integração — CLI `--engine`, eval nos 2 motores e documentação

## Visão geral

Torna o motor LLM utilizável e mensurável: a CLI ganha `resolveEngineArgs` (`--engine` + env `AGENTOPS_ENGINE`, default `deterministic`), validação de API key antes do spawn do server, `renderAuditSection`/`renderOutcome` no renderer e o fluxo llm completo (progresso por rodada e tokens em stderr). O eval harness passa a rodar os 3 casos em qualquer motor: `extractSections` + `TextReportScorer` avaliam os mesmos 5 grupos de critérios sobre o markdown, e o script `eval:llm` vira o smoke opt-in com LLM real. Fecha com a documentação da V2 (README, roadmap, decisions, architecture).

Referência: `../techspec-v2.md` — "Endpoints da API" (contrato dos 2 comandos), "Monitoramento e observabilidade" e "Sequenciamento › etapas 4–6".

Depende das tarefas 1.0 (adapter/contratos) e 2.0 (`@agentops/llm-engine`).

<skills>
### Conformidade com skills

- `desenvolver-mcp-tools`: nenhum contrato de tool muda; a CLI continua sendo o único consumidor MCP, via `McpToolInvoker`.
- `executar-task`: usar para conduzir a implementação desta tarefa.
</skills>

<requirements>
- Default `deterministic` sem API key: `npm run investigate`, `npm run eval`, `npm test` e CI continuam verdes sem nenhuma env nova (regressão zero da V1).
- Modo llm: validação de `ANTHROPIC_API_KEY` **antes** de spawnar o agentops-server; erros orientativos em stderr com exit 1, nunca stack trace cru (fluxo de erro do PRD).
- Relatório llm em stdout = markdown do modelo + seção "Tools chamadas" anexada por código (RF7); sem ANSI quando redirecionado (`NO_COLOR`/TTY — requisito de acessibilidade do PRD).
- Scoring do modo llm 100% determinístico (RF26) com breakdown por critério (RF27); `DeterministicEvalScorer` e casos JSON byte-idênticos aos da V1.
- Resumo do eval indica o engine usado; exit codes preservados (RF23).
- `ANTHROPIC_API_KEY` jamais aparece em progresso, relatório, audit ou mensagens de erro.
</requirements>

## Subtarefas

- [x] 3.1 Implementar `resolveEngineArgs` e o fluxo do modo llm em `apps/cli-agent/src/main.ts` (validação de key, montagem do assistant, progresso por rodada, linha de tokens em stderr).
- [x] 3.2 Refatorar `renderer.ts`: extrair `renderAuditSection` (regressão por snapshot) e adicionar `renderOutcome` (despacho por `kind`).
- [x] 3.3 Implementar `evals/scoring/text-scorer.ts` (`extractSections` + `TextReportScorer` com os 5 grupos de critérios).
- [x] 3.4 Adicionar seleção de engine ao `evals/src/runner.ts` (assistant injetável para testes) e o script `eval:llm` no `package.json` raiz.
- [x] 3.5 Escrever os novos cenários E2E (`cli.e2e.test.ts`, `eval.e2e.test.ts`) incluindo o smoke opt-in (skipped sem `ANTHROPIC_API_KEY`).
- [x] 3.6 Atualizar documentação: README (modo llm, envs, custo, gap do RF6 como objeto de estudo), `docs/roadmap.md` (V2 entregue), `docs/decisions.md` (decisões e risco de prompt injection → pré-requisito V3/V4), `docs/architecture.md` (novo pacote e fluxo).
- [x] 3.7 Validação manual de ponta a ponta com API key real (`npm run investigate -- --engine=llm ...` e `npm run eval:llm`).

## Detalhes de implementação

Ver `../techspec-v2.md`:

- "Endpoints da API" (tabelas de argumentos, exit codes e exemplos dos 2 comandos).
- "Modelos de dados › Contrato de formato do markdown" (base do `TextReportScorer`).
- "Monitoramento e observabilidade" (progresso, tokens, segredos).
- "Considerações técnicas › Scorer text-mode" e "Riscos conhecidos" (drift de formato, não-determinismo).

## Critérios de sucesso

- `npm run investigate -- --engine=llm "<pergunta>"` produz relatório completo + auditoria com key real; sem key, falha rápida e orientativa.
- `npm run eval` (default) idêntico à V1; `npm run eval -- --engine=llm` pontua os 3 casos com breakdown por critério e indica `engine: llm`.
- Suíte completa (`npm test`) verde sem `ANTHROPIC_API_KEY` definida; cobertura global > 80%.
- Documentação permite a um leitor novo rodar o modo llm só com o README (objetivo de extensibilidade do PRD).

## Testes da tarefa

Test cases da techspec (numeração da seção "Abordagem de testes"):

### Testes unitários

CLI — args, renderer e fluxo:

- [x] (23) `resolveEngineArgs`: sem flag → `deterministic`; `--engine=llm` → `llm`; flag removida do `rest`; `AGENTOPS_ENGINE=llm` sem flag → `llm`; flag vence env; `--engine=foo` → erro de uso.
- [x] (24) `--engine=llm` com pergunta vazia → mensagem de uso, exit 1 (mesmo comportamento da V1).
- [x] (25) `renderAuditSection`: saída idêntica à seção atual do `renderReport` (regressão por snapshot); registros vazios → "Nenhuma tool foi chamada.".
- [x] (26) `renderOutcome`: `markdown` → markdown + "Tools chamadas" anexada; `report` → delega a `renderReport` (byte-idêntico à V1); `clarification` → delega a `renderMissingFields`.
- [x] (27) Modo llm sem `ANTHROPIC_API_KEY` → mensagem orientativa em stderr, exit 1, **sem** spawn do server MCP.
- [x] (28) Saída do modo llm respeita `NO_COLOR`/não-TTY (sem ANSI quando redirecionada).

Eval — `extractSections` e `TextReportScorer`:

- [x] (29) `extractSections`: títulos com sublinhado (`Título\n------`) e com prefixo `## Título`; acentos/caixa normalizados; seção ausente → `undefined`; conteúdo atribuído à seção correta.
- [x] (30) `finding:`/`proibido:`: matching case/acento-insensível sobre o texto completo (reuso de `normalize`), paridade com o scorer da V1.
- [x] (31) `cita_evidencias` (text-mode): item numerado com linha `Fonte:` → passa; item sem `Fonte:` → falha com detalhe; seção vazia + "Dados faltantes" preenchida → passa (paridade com US9).
- [x] (32) `separa_fato_de_hipotese` (text-mode): "Evidências encontradas" e "Hipótese principal" presentes → passa; ausência de qualquer uma → falha listando o problema.
- [x] (33) `proximos_passos_seguros` (text-mode): lista vazia → falha; 1º item com termo de `DESTRUCTIVE_TERMS` → falha; destrutivo em posição ≥ 2 com ressalva → passa.
- [x] (34) Seção "Tools chamadas" gerada por código não interfere nos critérios.
- [x] (35) Score/`passed`: mesmos arredondamentos e agregação do scorer da V1 (2 casas, `passed` só com 100%).

Eval — runner:

- [x] (36) Default `deterministic` inalterado (incluindo erro quando `question` do caso não parseia); `--engine=llm` monta assistant LLM + `TextReportScorer`.
- [x] (37) Assistant LLM fake injetado devolvendo markdown roteirizado → breakdown por critério impresso e resumo indica `engine: llm`.
- [x] (38) Outcome `clarification` num caso (modo deterministic) → erro orientativo apontando o caso (comportamento V1 preservado).

### Testes de integração

- [x] Eval runner com engine fake: `runEvals({ engine: 'llm', assistant: fake })` sobre os 3 casos reais → `TextReportScorer` aplicado, resumo agregado correto.

### Testes E2E (se aplicável)

- [x] CLI, modo llm sem key (`execa`): `npm run --silent investigate -- --engine=llm "<pergunta>"` sem `ANTHROPIC_API_KEY` → exit 1, stderr orientativo, stdout vazio.
- [x] CLI, flag inválida: `--engine=foo` → exit 1 + mensagem de uso.
- [x] Regressão do default: suíte E2E existente (investigate e eval sem flag) permanece verde sem nenhuma env nova.
- [x] Smoke opt-in com LLM real (`npm run eval:llm`, case-001): **skipped** quando `ANTHROPIC_API_KEY` não está definida (nunca roda em CI por default).

## Arquivos relevantes

- `apps/cli-agent/src/main.ts` — `resolveEngineArgs` + fluxo llm (modificar).
- `apps/cli-agent/src/renderer.ts` (+ `renderer.test.ts`) — `renderAuditSection`/`renderOutcome` (modificar).
- `evals/scoring/text-scorer.ts` (+ `.test.ts`) — `extractSections` + `TextReportScorer` (criar).
- `evals/src/runner.ts` (+ `runner.integration.test.ts`) — seleção de engine (modificar).
- `apps/cli-agent/e2e/cli.e2e.test.ts`, `evals/e2e/eval.e2e.test.ts` — novos cenários (modificar).
- `package.json` (raiz) — script `eval:llm` (modificar).
- `README.md`, `docs/{architecture,roadmap,decisions}.md` — documentação (modificar).
- `evals/scoring/scorer.ts`, `evals/cases/*.json` — **não modificar** (garantia de escopo).
