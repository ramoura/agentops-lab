# Tarefa 4.0: Validação real e documentação — smoke leniente, experimento antes/depois e registro dos números

## Visão geral

Fecha a V2.5 com o experimento que a motiva: o smoke opt-in (`npm run eval:llm`, case-001 — único ponto que gasta tokens) ganha a asserção **leniente** de cache (`cacheReadTokens > 0` no agregado quando há 2+ rodadas; valores exatos proibidos — variam por execução); uma rodada manual de `investigate --engine=llm` compara o custo com `AGENTOPS_LLM_CACHE=off` vs. ligado (mesmo binário); os números medidos e a decisão são registrados em `README.md` e `docs/{roadmap,decisions}.md`, incluindo o troubleshooting de cache frio (`cache lido == 0` em execução multi-rodada = invalidação silenciosa).

Referência: `../techspec-v2.5.md` — seções "Testes E2E", "Sequenciamento › passo 5", "Monitoramento e observabilidade" e "Riscos conhecidos" (asserção pode flakear → leniência; smoke fora da CI).

<skills>
### Conformidade com skills

- `executar-task`: usar para conduzir a implementação desta tarefa.
- `criar-techspec`: os números medidos alimentam de volta o roadmap/decisions no padrão das specs anteriores.
</skills>

<requirements>
- Asserção leniente no smoke: `cacheReadTokens > 0` apenas quando a investigação teve 2+ rodadas; nunca valores exatos; skipped sem `ANTHROPIC_API_KEY`, como hoje; fora da CI.
- Experimento antes/depois com o mesmo binário: uma execução com `AGENTOPS_LLM_CACHE=off` e uma com default, mesma pergunta; números (entrada, cache lido/escrito, saída, rodadas) registrados.
- `README.md`: env `AGENTOPS_LLM_CACHE` documentada + troubleshooting de cache frio como primeiro passo de diagnóstico.
- `docs/roadmap.md`: V2.5 marcada como concluída com os números medidos; `docs/decisions.md`: decisão registrada (2 breakpoints, TTL 5 min, opt-out por env, marker no bloco).
- Segredos: `ANTHROPIC_API_KEY` jamais aparece em progresso, audit, relatório ou erros (inalterado).
</requirements>

## Subtarefas

- [x] 4.1 Adicionar a asserção leniente de cache ao smoke `eval:llm` em `evals/e2e/eval.e2e.test.ts` (condicionada a 2+ rodadas; skip sem key preservado).
- [x] 4.2 Executar o experimento antes/depois (`AGENTOPS_LLM_CACHE=off` vs. default) com `investigate --engine=llm` e coletar os números da linha de custo.
- [x] 4.3 Documentar: `README.md` (env + troubleshooting de cache frio), `docs/roadmap.md` (números medidos) e `docs/decisions.md` (decisão da V2.5).
- [x] 4.4 Rodada final de verificação: `npm test`, `npm run typecheck`, suíte E2E default verde e smoke `eval:llm` passando com a asserção nova.

## Detalhes de implementação

Ver `../techspec-v2.5.md`:

- "Testes E2E › Smoke opt-in com LLM real" (asserção leniente; o que é proibido assertar).
- "Monitoramento e observabilidade" (diagnóstico de cache frio a documentar no README).
- "Considerações técnicas › Principais decisões" (conteúdo da entrada em `decisions.md`).
- "Riscos conhecidos" (flakiness da asserção; investigação de rodada única paga write sem read — aceito).

## Critérios de sucesso

- Smoke `eval:llm` passa com a asserção leniente usando API real (e continua skipped sem key).
- Números do experimento registrados — evidência da redução esperada (~70–80% no custo de entrada) ou análise do desvio se não confirmada.
- Documentação atualizada nos 3 lugares (README, roadmap, decisions).
- Suíte completa verde; nenhum teste da suíte default gasta tokens.

## Testes da tarefa

Test cases da techspec (seção "Testes E2E"):

### Testes unitários

- Não se aplica — esta tarefa não adiciona lógica de produção nova (cobertura pelas tarefas 1.0–3.0).

### Testes de integração

- Não se aplica (cobertos nas tarefas 2.0 e 3.0).

### Testes E2E (se aplicável)

- [x] Smoke opt-in com LLM real (`npm run eval:llm`, case-001): em investigação com 2+ rodadas, `cacheReadTokens > 0` no agregado; sem asserção de valores exatos; skipped sem `ANTHROPIC_API_KEY`.
- [x] Regressão do default: suíte E2E existente (investigate e eval sem flag, sem envs novas) permanece verde.

## Arquivos relevantes

- `evals/e2e/eval.e2e.test.ts` — asserção leniente no smoke (modificar).
- `README.md` — env `AGENTOPS_LLM_CACHE` e troubleshooting de cache frio (modificar).
- `docs/roadmap.md`, `docs/decisions.md` — números medidos e decisão registrada (modificar).
