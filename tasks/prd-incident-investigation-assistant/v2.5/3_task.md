# Tarefa 3.0: Exposição das métricas — linha de custo na CLI e linha de cache por caso no eval

## Visão geral

Torna o cache observável — parte do design, não acessório (mínimo cacheável e invalidação são silenciosos na API; sem métrica, "cache ligado" é indistinguível de "cache quebrado"). A linha de tokens da CLI em stderr ganha o detalhe de cache (`Tokens: 3.9k entrada (44.2k cache lido · 9.2k cache escrito) · 5.1k saída · 5 rodada(s)`), degradando para o formato da V2 quando `cacheReadTokens + cacheCreationTokens === 0`. O eval runner, no modo llm, passa a reportar em stderr o agregado de cache por caso (`Cache: 44.2k lido · 9.2k escrito · 3.9k sem cache`) via `lastUsage` do assistant concreto, quando disponível — stdout (scores, breakdown, resumo) permanece byte-idêntico.

Referência: `../techspec-v2.5.md` — seções "Endpoints da API" (exemplos de saída dos 2 comandos), "Monitoramento e observabilidade" e "Sequenciamento › passo 4".

<skills>
### Conformidade com skills

- `executar-task`: usar para conduzir a implementação desta tarefa.
- `desenvolver-mcp-tools`: não afetada — exposição é na CLI e no runner; camada de tools intocada.
</skills>

<requirements>
- CLI: formato `Tokens: <input> entrada (<read> cache lido · <write> cache escrito) · <output> saída · <N> rodada(s)`; quando cache total == 0 (opt-out ou prefixo abaixo do mínimo), formato da V2 preservado — sem parêntese vazio.
- `formatTokenCount` reutilizado para os campos de cache (mesma formatação `12.4k`).
- stdout da CLI byte-idêntico ao da V2 em todos os cenários; argumentos e exit codes inalterados.
- Eval: linha `Cache: <read> lido · <write> escrito · <input> sem cache` por caso, em stderr, apenas no modo llm; stdout de scores/resumo inalterado (RF23/RF27 intactos).
- Modo `deterministic` → nenhuma linha de cache; assistant sem `lastUsage` (fake injetado) → runner não quebra, linha omitida (instrumentação opcional e não intrusiva).
- Componentes intocados: scorers, casos de eval, datasets, `apps/cli-agent/src/renderer.ts`.
</requirements>

## Subtarefas

- [x] 3.1 Estender a linha de custo em `apps/cli-agent/src/main.ts` com o detalhe de cache e a degradação para o formato V2 quando cache == 0, reutilizando `formatTokenCount`.
- [x] 3.2 Adicionar ao `evals/src/runner.ts` a linha de cache por caso em stderr no modo llm, lendo `lastUsage` do assistant concreto quando disponível (omitir quando ausente).
- [x] 3.3 Escrever os testes unitários da tarefa (cases 17–22).
- [x] 3.4 Estender o teste de integração do runner (`runEvals` com assistant fake sem `lastUsage` → sem linha de cache, resultados inalterados); suíte verde com cobertura > 80%.

## Detalhes de implementação

Ver `../techspec-v2.5.md`:

- "Endpoints da API › `npm run investigate -- --engine=llm`" (exemplos exatos de stderr com cache ligado e desligado).
- "Endpoints da API › `npm run eval -- --engine=llm`" (formato da linha por caso; stdout intacto).
- "Monitoramento e observabilidade" (linha de custo como instrumento primário do experimento; diagnóstico de cache frio).

## Critérios de sucesso

- Saída em stderr da CLI e do eval conforme os exemplos da techspec, nos dois cenários (cache efetivo e cache zero).
- stdout de ambos os comandos byte-idêntico ao da V2 (relatório e scores não mudam).
- Instrumentação comprovadamente opcional: fake sem `lastUsage` não quebra o runner.
- Cobertura global mantida > 80%.

## Testes da tarefa

Test cases da techspec (numeração da seção "Abordagem de testes"):

### Testes unitários

**cli-agent — linha de custo:**

- [x] (17) `LlmUsage` com cache > 0 → linha `Tokens: 3.9k entrada (44.2k cache lido · 9.2k cache escrito) · 5.1k saída · 5 rodada(s)`.
- [x] (18) `LlmUsage` com cache == 0 → formato da V2 preservado (`Tokens: 57.3k entrada · 5.1k saída · 5 rodada(s)`), sem parêntese vazio.
- [x] (19) `formatTokenCount` reutilizado para os campos de cache (mesma formatação `12.4k`).

**evals — runner:**

- [x] (20) Modo llm com assistant expondo `lastUsage` com cache → linha `Cache: … lido · … escrito · … sem cache` em stderr, por caso; stdout (scores/resumo) byte-idêntico ao da V2.
- [x] (21) Modo `deterministic` → nenhuma linha de cache (o assistant não expõe usage).
- [x] (22) Assistant llm injetado (fake, sem `lastUsage`) → runner não quebra; linha de cache simplesmente omitida.

### Testes de integração

- [x] Eval runner com engine fake: `runEvals({ engine: 'llm', assistant: fake })` → nenhuma linha de cache (fake não expõe usage) e resultados inalterados — prova que a instrumentação é opcional e não intrusiva.

### Testes E2E (se aplicável)

- [x] Regressão do default: suíte E2E existente (investigate e eval sem flag, sem envs novas) permanece verde — o modo deterministic não passa perto do código de cache.
- [x] CLI, modo llm sem key: inalterado (validação de key vem antes de qualquer request; regressão).

## Arquivos relevantes

- `apps/cli-agent/src/main.ts` (+ `main.test.ts`) — linha de custo com cache (modificar).
- `evals/src/runner.ts` (+ `runner.integration.test.ts`) — linha de cache por caso em stderr (modificar).
- `evals/e2e/eval.e2e.test.ts`, `apps/cli-agent` E2E — regressões do default (verificar, sem modificação esperada nesta tarefa).
