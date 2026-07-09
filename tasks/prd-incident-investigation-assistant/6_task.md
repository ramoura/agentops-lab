# Tarefa 6.0: Eval harness (`@agentops/evals`), documentação e validação final

## Visão geral

Fechar a v1 com o instrumento de confiabilidade e o material de estudo: workspace `@agentops/evals` com os 3 casos, scorer 100% determinístico (matching de termos, sem LLM) e runner que executa cada investigação pelo mesmo caminho da CLI (client MCP real), imprimindo breakdown de critérios por caso; documentação (README, architecture, roadmap, decisions) e validação final do projeto (install limpo, comandos, cobertura >80%).

<skills>
### Conformidade com skills

- `desenvolver-mcp-tools` — o eval exercita as tools pelo protocolo real, servindo de monitor de regressão do tool layer.
</skills>

<requirements>
- Comando `npm run eval` executando todos os casos, com score por caso e resultado agregado (RF23).
- 3 casos: `case-001-database-timeout`, `case-002-payment-api-timeout`, `case-003-missing-data` (RF24), cada um com `id`, `question`, `expected_findings`, `must_not_include` (RF25).
- Scoring determinístico avaliando: findings esperados, termos proibidos, `cita_evidencias`, `separa_fato_de_hipotese`, `proximos_passos_seguros` (RF26); resultado indica critérios aprovados/reprovados por caso (RF27).
- Meta do PRD: case-001 com 100% dos findings e 0 termos proibidos.
- README documenta instalar/investigar/eval e como adicionar dataset, tool e skill sem mudança de arquitetura (extensibilidade do PRD); `docs/decisions.md` registra server único, SDK v1.x, workspaces e Vitest.
- Validação final: `npm install` limpo, `npm run investigate` e `npm run eval` funcionais, cobertura >80% em `types`, `providers`, `core`, `agentops-server` e `evals/scoring`.
</requirements>

## Subtarefas

- [x] 6.1 `evals/cases/*.json` (3 casos conforme `EvalCase`) e `expected-answers/case-001.md` (golden de referência).
- [x] 6.2 `scoring/scorer.ts`: matching case/acento-insensível sobre o texto renderizado + `InvestigationReport` estruturado; critérios estruturais.
- [x] 6.3 `src/runner.ts`: executa os casos via client MCP real, imprime progresso, score por caso, breakdown de critérios e resumo agregado; script raiz `eval`.
- [x] 6.4 `README.md`, `docs/architecture.md`, `docs/roadmap.md` (migração SDK v2, V2–V5), `docs/decisions.md`.
- [x] 6.5 Testes unitários do scorer, integração do runner e E2E do `npm run eval`; verificação de cobertura >80%.

## Detalhes de implementação

Ver techspec: modelos **`EvalCase`** e **`EvalCaseResult`**, interface `EvalScorer`, seção do `@agentops/evals` em "Visão dos componentes", risco "Eval acoplado ao texto do relatório" (findings com termos técnicos estáveis) e passos 8–10 do **"Sequenciamento do desenvolvimento"**.

## Critérios de sucesso

- `npm run eval` conclui em segundos com case-001 em `score = 1.0` e 0 termos proibidos (meta do PRD), exibindo critérios que passaram/falharam por caso.
- Scorer é puro e determinístico: mesmo input → mesmo resultado.
- Cobertura >80% de linhas/branches nos pacotes-alvo; `npm install` + comandos principais funcionam em máquina limpa.

## Testes da tarefa

Casos da techspec: **52–59**, **70** e **75**.

### Testes unitários — Scorer

- [x] 52. Finding presente no texto → critério `finding:X` passa; matching case/acento-insensível.
- [x] 53. Finding ausente → critério falha e `details` aponta a ausência.
- [x] 54. Termo proibido presente → critério `proibido:X` falha.
- [x] 55. `cita_evidencias`: passa quando toda evidência tem source; falha com evidência sem citação (fixture manipulada).
- [x] 56. `separa_fato_de_hipotese`: exige seções "Evidências" e "Hipótese" distintas e não vazias (missing-data: hipótese vazia + missingData preenchido também passa).
- [x] 57. `proximos_passos_seguros`: falha se lista vazia ou 1º item destrutivo.
- [x] 58. `score` = aprovados/total com 2 casas; `passed` só com 100%.
- [x] 59. Scorer é puro: mesmo input → mesmo resultado (RF26).

### Testes de integração

- [x] 70. `runEvals()` sobre os 3 casos → case-001 com `score = 1.0` e 0 termos proibidos; saída inclui breakdown de critérios por caso (RF27).

### Testes E2E

- [x] 75. `npm run eval` → exit code 0; score por caso + resumo agregado; case-001 = 100% (RF23).

## Arquivos relevantes

- `evals/src/runner.ts`, `evals/scoring/scorer.ts`
- `evals/cases/case-001-database-timeout.json`, `case-002-payment-api-timeout.json`, `case-003-missing-data.json`, `evals/expected-answers/case-001.md`
- `README.md`, `docs/architecture.md`, `docs/roadmap.md`, `docs/decisions.md`
- `package.json` raiz (script `eval`), configuração de coverage
