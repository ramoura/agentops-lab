---
status: completed
title: Smoke real opt-in e documentação da bancada
type: docs
complexity: low
---

# Task 5: Smoke real opt-in e documentação da bancada

## Overview

Fecha a V2.4 (passo 7 da ordem de construção) com a validação empírica e a documentação: o smoke E2E opt-in contra um provider real (`openrouter:deepseek/deepseek-chat`, skipped sem chave — único ponto da suíte que gasta tokens), uma rodada manual da bancada, e a documentação de onboarding — variáveis de provider no README, primeira classe vs. best-effort, consideração de privacidade do OpenRouter, atualização do roadmap e o registro D16 em `decisions.md`.

<critical>
- ALWAYS READ the PRD, the TechSpec, and their catalogs (`_user_stories.md`, `_tests.md`) before starting
- REFERENCE TECHSPEC for implementation details — do not duplicate here
- FOCUS ON "WHAT" — describe what needs to be accomplished, not how
- MINIMIZE CODE — show code only to illustrate current structure or problem areas
- TESTS REQUIRED — implement every test case assigned in ## Tests
</critical>

<requirements>
1. MUST implementar o smoke E2E-004 opt-in: `eval:llm` com `AGENTOPS_LLM_PROVIDER=openrouter`, `AGENTOPS_LLM_MODEL=deepseek/deepseek-chat` e `OPENROUTER_API_KEY` real; **skipped (não falho)** sem a chave; asserção leniente — outcome do `case-001` aprovado e, em execução multi-rodada, `cacheReadTokens > 0` a partir da 2ª rodada quando o provider reporta.
2. MUST garantir que o smoke nunca rode na CI nem na suíte default (`npm test` sem a chave permanece sem rede e sem tokens).
3. MUST executar uma rodada manual da bancada (`npm run compare` em modo eval com ao menos 2 modelos) e registrar a evidência no resultado da task.
4. MUST documentar no README: as variáveis novas (`AGENTOPS_LLM_PROVIDER`, `AGENTOPS_LLM_BASE_URL`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`) na tabela de envs; o contrato de suporte (Anthropic default byte-idêntico, OpenRouter/OpenAI primeira classe, custom best-effort com interações conhecidas: `max_completion_tokens`, `finish_reason` inconsistente, cache não reportado); como rodar a bancada (`npm run compare`, dois modos, custo opt-in) (RF6/RF7, US-009.AC-2).
5. MUST documentar a consideração de privacidade: OpenRouter/gateways custom são um terceiro por onde trafegam pergunta e resultados de tool — aceitável no lab (dados fake), a reavaliar na V3 (dados reais).
6. MUST documentar que a comparação é de recursos, não de dinheiro (nenhum US$; "mais tokens ≠ mais caro" entre providers — ADR-003, US-007.EC-3).
7. MUST atualizar `docs/roadmap.md` (V2.4 entregue) e registrar **D16** em `docs/decisions.md` confirmando o modelo-alvo do smoke real (`deepseek/deepseek-chat` via OpenRouter — Open Question do PRD).
8. MUST manter o caminho default documentado como funcionando sem nenhuma configuração nova (RF8).
9. MUST NOT alterar código de produto nesta task; apenas teste opt-in, documentação e registros de decisão.
</requirements>

## Subtasks

- [x] 5.1 Implementar o smoke E2E-004 opt-in (skip sem `OPENROUTER_API_KEY`, asserção leniente) no padrão E2E vigente.
- [x] 5.2 Confirmar que a suíte default e a CI permanecem sem rede/tokens com o smoke presente (rodar `npm test` sem a chave).
- [x] 5.3 Rodar a bancada manualmente (compare em modo eval com 2+ modelos) e registrar a evidência (tabela obtida) no resultado da task.
- [x] 5.4 Atualizar a tabela de variáveis de ambiente e a seção de modo LLM do README (providers, chaves, base URL, bancada).
- [x] 5.5 Documentar primeira classe vs. best-effort, as interações conhecidas de gateways custom e a consideração de privacidade do OpenRouter.
- [x] 5.6 Atualizar `docs/roadmap.md` e registrar D16 em `docs/decisions.md`.

## Implementation Details

Seguir a TechSpec, seções "Abordagem de testes" (smoke opt-in como único ponto que gasta tokens), "Pontos de integração" (privacidade OpenRouter) e "Análise de impacto" (linha README/docs). O smoke segue o padrão dos E2E existentes (`apps/cli-agent/e2e/cli.e2e.test.ts`, `evals/e2e/`, via `execa`), com `describe.skipIf`/`it.skipIf` na ausência da chave.

Pontos de inserção na documentação: a tabela de envs do README (linhas ~75–81, hoje com `ANTHROPIC_API_KEY`, `AGENTOPS_ENGINE`, `AGENTOPS_LLM_*`, `AGENTOPS_TRACE_LOG`) e a seção "Modo LLM" (~linha 58); `docs/roadmap.md` especifica a V2.4 nas linhas ~54–61; `docs/decisions.md` termina hoje em D15 — D16 é o próximo registro.

### Relevant Files

- `evals/e2e/` — local do smoke E2E-004 (padrão E2E do repositório).
- `README.md` — tabela de envs, seção de modo LLM, nova seção/subseção da bancada.
- `docs/roadmap.md` — marca da entrega V2.4 (especificada nas linhas ~54–61).
- `docs/decisions.md` — registro D16 (último atual: D15).
- `evals/src/runner.ts` — caminho exercitado pelo smoke (`eval:llm` com provider por env, via task 3; não modificar).
- `apps/cli-agent/e2e/cli.e2e.test.ts` — referência do padrão E2E com `execa`.

### Dependent Files

- `.github/workflows/` (se existir pipeline) — confirmar que o smoke opt-in não entra na CI; nenhuma mudança esperada, apenas verificação.

### Related ADRs

- [ADR-002: Contrato de providers e seleção por ambiente](adrs/adr-002.md) — o que documentar como promessa vs. best-effort.
- [ADR-003: Custo em tokens e rodadas, sem valor monetário](adrs/adr-003.md) — rótulo de recursos e mitigação "mais tokens ≠ mais caro".
- [ADR-001: Bancada de comparação — execução única + agregador](adrs/adr-001.md) — os dois fluxos de consumo a documentar no onboarding.

## Deliverables

- Smoke E2E-004 opt-in implementado (skipped sem chave; aprovado com chave real) — único ponto da suíte que gasta tokens.
- Evidência de uma rodada manual da bancada (tabela comparativa real) registrada no resultado da task.
- README atualizado: envs de provider, contrato de suporte, bancada, privacidade OpenRouter, custo como recurso.
- `docs/roadmap.md` atualizado e D16 registrado em `docs/decisions.md`.
- Every test case assigned in `## Tests` implemented and passing **(REQUIRED)**

## Tests

Cases assigned from `_tests.md`, the test contract — read each ID's full definition there before writing tests.

- [x] E2E-004 — smoke real opt-in via OpenRouter (`deepseek/deepseek-chat`): outcome do `case-001` aprovado, asserção leniente de cache; skipped (não falho) sem `OPENROUTER_API_KEY`.

## Success Criteria

- Every assigned test case implemented and passing (E2E-004 skipped sem chave; verde com chave real)
- `npm test` sem `OPENROUTER_API_KEY`: suíte inteira verde, zero rede, zero tokens
- README responde sozinho: como escolher provider, quais são promessa vs. best-effort, como rodar a bancada e o que a tabela significa
- D16 registrado e roadmap refletindo a V2.4 entregue
