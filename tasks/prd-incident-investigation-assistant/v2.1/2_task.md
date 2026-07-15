# Tarefa 2.0: Fechamento do flake real, validação ponta a ponta e documentação

## Visão geral

Aplica o mecanismo construído na tarefa 1.0 ao flake real documentado no D11: `evals/cases/case-003-missing-data.json` ganha aliases reais para os 2 findings que reprovaram na validação da V2 ("Sem registros" / "Não há registros" / "nenhum registro"; "Sem métricas de latência" / variantes). Valida o fechamento ponta a ponta — runner completo com o `TextReportScorer` real sobre o dado atualizado, regressão do gate principal (`npm run eval`, modo deterministic, 3/3 casos, score médio 1.0) e regressão E2E — e registra a decisão em `docs/roadmap.md` (V2.1 ✅ entregue) e `docs/decisions.md` (nova entrada D14, complementando o D11).

Referência: `../techspec-v2.1.md` — seções "Modelos de dados › `EvalCase`" (JSON completo do case-003 atualizado), "Abordagem de testes › Testes de integração/E2E" e "Sequenciamento › passos 4–6".

<skills>
### Conformidade com skills

- `executar-task`: usar para conduzir a implementação desta tarefa.
- `desenvolver-mcp-tools`: não aplicável — nenhuma tool, schema ou contrato MCP muda.
</skills>

<requirements>
- `case-003-missing-data.json`: os itens `"Sem registros"` e `"Sem métricas de latência"` de `expected_findings` viram arrays de variantes (conforme o JSON completo da techspec); `must_not_include` e os demais campos não mudam.
- `case-001-database-timeout.json` e `case-002-payment-api-timeout.json` **não são alterados** (nenhum flake conhecido neles).
- Runner completo (`runEvals`) com o `TextReportScorer` real e um assistant llm fake respondendo com a frase alternativa "Não há registros de erro" → case-003 aprovado.
- Regressão do gate principal: `runEvals({ engine: 'deterministic' })` com os 3 casos reais (case-003 atualizado incluso) → 3/3 aprovados, score médio 1.0.
- `npm run eval` (default, sem key, CI) permanece verde — nenhuma mudança de comportamento observável do lado de fora.
- `docs/roadmap.md`: seção "V2.1 — Tolerância de fraseado no scorer" marcada como ✅ entregue, no mesmo padrão das seções V2/V2.5 já entregues.
- `docs/decisions.md`: nova entrada **D14**, complementando (não substituindo) o D11 — registra a decisão de lista de aliases *any-of*, o escopo restrito à tolerância léxica (segundo scorer fica para a V2.10) e o comportamento do `DeterministicEvalScorer` só com a variante primária.
</requirements>

## Subtarefas

- [x] 2.1 Atualizar `evals/cases/case-003-missing-data.json` com os aliases reais dos 2 findings do flake documentado.
- [x] 2.2 Escrever/estender `evals/src/runner.integration.test.ts`: teste de fechamento do flake (assistant fake com a frase alternativa) e regressão do gate principal com os 3 casos reais.
- [x] 2.3 Validar regressão E2E (`npm run eval` verde) e rodar o smoke opt-in `npm run eval:llm` manualmente (requer `ANTHROPIC_API_KEY`). O smoke de 2026-07-14 usou novos fraseados fora dos aliases curados e manteve o case-003 reprovado nesses dois findings; risco residual encaminhado à V2.9, sem ampliar o escopo desta tarefa.
- [x] 2.4 Atualizar `docs/roadmap.md` (V2.1 ✅ entregue) e `docs/decisions.md` (nova entrada D14).
- [x] 2.5 Escrever o teste da tarefa (case 90) e garantir suíte verde (`npm test`, `npm run typecheck`, `npm run eval`) com cobertura > 80%.

## Detalhes de implementação

Ver `../techspec-v2.1.md`:

- "Modelos de dados › `EvalCase`" (JSON completo do `case-003-missing-data.json` atualizado).
- "Abordagem de testes › Testes de integração" e "› Testes E2E".
- "Sequenciamento do desenvolvimento › passos 4–6".
- "Considerações técnicas › Riscos conhecidos" (curadoria manual dos aliases; cobertura finita — objeto da V2.9).

## Critérios de sucesso

- `case-003-missing-data.json` válido contra `evalCaseSchema` (carregamento via `loadCases()` sem erro).
- Fixture com a frase alternativa documentada no D11 aprova via o runner real (fecha o loop ponta a ponta do flake).
- `npm run eval` (modo deterministic, default) continua 3/3 aprovado, score médio 1.0 — nenhuma regressão do gate de CI.
- `docs/roadmap.md` e `docs/decisions.md` atualizados e coerentes com a techspec (D14 referencia o D11 em vez de duplicá-lo).
- Cobertura global mantida > 80%.

## Testes da tarefa

Test cases da techspec (numeração da seção "Abordagem de testes"):

### Testes unitários

**`evals` — dataset real:**

- [x] (90) `case-003-missing-data.json` atualizado valida contra `evalCaseSchema` sem erro (regressão de `loadCases()`).

### Testes de integração

- [x] `evals/src/runner.integration.test.ts`: `runEvals()` completo com `TextReportScorer` real e assistant llm fake respondendo "Não há registros de erro" → case-003 aprovado.
- [x] Regressão do gate principal: `runEvals({ engine: 'deterministic' })` com os 3 casos reais (case-003 atualizado incluso) → 3/3 aprovados, score médio 1.0.

### Testes E2E (se aplicável)

- [x] Regressão do default: `npm run eval` (modo deterministic, CI) permanece verde com os mesmos 3 casos.
- [x] Smoke opt-in manual (`npm run eval:llm`, requer `ANTHROPIC_API_KEY`, fora da CI): executado em 2026-07-14; a execução real produziu fraseados novos fora da lista curada e evidenciou o risco residual previsto para medição na V2.9.

## Arquivos relevantes

- `evals/cases/case-003-missing-data.json` — aliases reais (modificar).
- `evals/src/runner.integration.test.ts` — teste de fechamento do flake + regressão do gate (modificar).
- `docs/roadmap.md` — V2.1 marcada como entregue (modificar).
- `docs/decisions.md` — nova entrada D14 (modificar).
