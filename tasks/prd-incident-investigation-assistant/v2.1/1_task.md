# Tarefa 1.0: Schema tolerante (`FindingSpec`) e os dois scorers

## Visão geral

Introduz o tipo compartilhado `FindingSpec = string | string[]` (uma entrada de `expected_findings`/`must_not_include` vira termo único ou lista de variantes aceitas — matching *any-of*) e propaga-o para os dois scorers do eval harness: o `TextReportScorer` (modo llm) passa a considerar qualquer variante como match válido, citando no `details` qual variante bateu; o `DeterministicEvalScorer` (modo V1) recebe o mesmo tipo apenas por compatibilidade — continua comparando só a variante primária (`primaryVariant`), preservando byte a byte o comportamento validado nos testes 52–59. Nenhum dado real (`evals/cases/*.json`) muda nesta tarefa — o mecanismo é validado inteiramente com fixtures sintéticas nos testes unitários; aplicar isso ao case-003 real é a tarefa 2.0.

Referência: `../techspec-v2.1.md` — seções "Principais interfaces", "Modelos de dados" (`FindingSpec`, `EvalCriterionResult`) e "Sequenciamento › passos 1–3".

<skills>
### Conformidade com skills

- `executar-task`: usar para conduzir a implementação desta tarefa.
- `desenvolver-mcp-tools`: não aplicável — nenhuma tool, schema ou contrato MCP muda; a mudança é inteiramente no eval harness (pós-processamento do texto já gerado).
</skills>

<requirements>
- `FindingSpec = string | string[]`, com `findingSpecSchema` Zod (`z.string().min(1)` ou `z.array(z.string().min(1)).min(1)`); `evalCaseSchema.expected_findings`/`.must_not_include` passam a `FindingSpec[]`.
- `primaryVariant(spec)`: string única → ela mesma; array → o 1º elemento (nunca concatenação). `variants(spec)`: string única → array de 1 elemento; array → o mesmo conteúdo, na mesma ordem. Ambos exportados de `evals/scoring/scorer.ts`.
- `TextReportScorer.scoreFinding`/`scoreForbidden` usam `variants(spec)` para matching *any-of* (passa se **qualquer** variante aparecer no texto normalizado; para `must_not_include`, falha se **qualquer** variante aparecer). `criterion.name` usa sempre `primaryVariant(spec)` — estável entre execuções independente de qual variante bateu (RF27). `details` cita a variante encontrada quando `spec` tem mais de 1 variante; sem alias, `details` é byte-idêntico ao formato atual.
- `DeterministicEvalScorer.scoreFinding`/`scoreForbidden` comparam **apenas** `primaryVariant(spec)` — nenhuma tolerância no modo V1, por decisão de escopo explícita da techspec.
- Compatibilidade retroativa: qualquer `EvalCase` 100% `string` (formato de hoje, ex.: case-001, case-002) continua válido e com comportamento idêntico nos dois scorers, sem alteração de dado.
- Componentes intocados: `mcp-servers/agentops-server/**`, `packages/{core,providers}/**`, `packages/llm-engine/**`, `apps/cli-agent/**`, `evals/cases/*.json` (dado não muda nesta tarefa), `evals/src/runner.ts`.
</requirements>

## Subtarefas

- [x] 1.1 Adicionar `FindingSpec` e `findingSpecSchema` em `packages/types/src/eval.ts`; atualizar `evalCaseSchema` para `expected_findings`/`must_not_include: FindingSpec[]`.
- [x] 1.2 Adicionar `primaryVariant`/`variants` em `evals/scoring/scorer.ts` e adaptar `DeterministicEvalScorer.scoreFinding`/`scoreForbidden` ao novo tipo (só variante primária).
- [x] 1.3 Adaptar `TextReportScorer.scoreFinding`/`scoreForbidden` em `evals/scoring/text-scorer.ts` para matching *any-of* com `details` citando a variante encontrada.
- [x] 1.4 Escrever os testes da tarefa (cases 77–89) e garantir suíte verde (`npm test`, `npm run typecheck`) com cobertura > 80%.

## Detalhes de implementação

Ver `../techspec-v2.1.md`:

- "Design de implementação › Principais interfaces" (`FindingSpec`, `findingSpecSchema`, `primaryVariant`, `variants`).
- "Modelos de dados › `FindingSpec`" e "› `EvalCriterionResult`" (tabelas e exemplos de `details`).
- "Considerações técnicas › Principais decisões" (por que a tolerância fica só no `TextReportScorer`, e por que `must_not_include` ganha o mesmo tipo por simetria).
- "Dependências técnicas": nenhuma dependência nova.

## Critérios de sucesso

- `findingSpecSchema` valida string única e `string[]` não vazio; rejeita ambos vazios.
- `TextReportScorer` aprova um finding via qualquer variante da lista, com `details` citando qual bateu; `criterion.name` permanece a variante primária em qualquer cenário.
- `DeterministicEvalScorer` compila com o novo tipo e mantém comportamento observável idêntico ao pré-V2.1 para entradas string únicas; para entradas em array, considera só a primária (sem tolerância).
- Nenhuma regressão nos testes 29–35 (text-scorer) e 52–59 (scorer) existentes.
- Cobertura global mantida > 80%.

## Testes da tarefa

Test cases da techspec (numeração da seção "Abordagem de testes"):

### Testes unitários

**`packages/types` — schema (`findingSpecSchema`/`evalCaseSchema`):**

- [x] (77) String única e `string[]` não vazio validam; `string` vazia e `string[]` vazio são rejeitados.
- [x] (78) `evalCaseSchema.parse()` aceita `EvalCase` misto (entradas string e array) sem erro.

**`evals/scoring/scorer.ts` — helpers compartilhados:**

- [x] (79) `primaryVariant`: string única → ela mesma; array → 1º elemento.
- [x] (80) `variants`: string única → array de 1 elemento; array → mesmo conteúdo, mesma ordem.

**`evals/scoring/scorer.ts` — `DeterministicEvalScorer` (regressão + novo tipo):**

- [x] (81) Regressão: os 8 testes originais (52–59) continuam passando sem alteração.
- [x] (82) Entrada em array com texto contendo só a 2ª variante → critério falha (V1 não ganha tolerância).
- [x] (83) Determinismo: `score()` chamado duas vezes com `EvalCase` contendo entradas em array → resultados `toEqual`.

**`evals/scoring/text-scorer.ts` — matching any-of (`TextReportScorer`):**

- [x] (84) Finding como array: variante não-primária presente no texto → critério passa; `details` cita a variante entre aspas.
- [x] (85) Finding como array: nenhuma variante presente → critério falha; `details` cita o rótulo canônico e quantas variantes foram tentadas.
- [x] (86) Finding como string única (regressão): `criteria`/`details` byte-idênticos aos testes 29–35.
- [x] (87) `criterion.name` usa sempre a variante primária, independente de qual variante bateu.
- [x] (88) `must_not_include` como array: qualquer variante presente reprova; nenhuma presente → aprova.
- [x] (89) Fixture sintética com o texto "Não há registros de erro para o inventory-api..." contra um `EvalCase` com aliases equivalentes ao case-003 → os findings passam (prova o mecanismo antes de tocar no dado real).

### Testes de integração

- Não se aplica nesta tarefa — os dois scorers são validados unitariamente com fixtures; a integração com o dado real do case-003 e com o runner entra na tarefa 2.0.

### Testes E2E (se aplicável)

- Não se aplica nesta tarefa — nenhum dado ou comando de CLI muda; a regressão E2E é validada na tarefa 2.0.

## Arquivos relevantes

- `packages/types/src/eval.ts` — `FindingSpec`, `findingSpecSchema`, `evalCaseSchema` (modificar).
- `evals/scoring/scorer.ts` (+ `scorer.test.ts`) — `primaryVariant`, `variants`, `DeterministicEvalScorer` adaptado (modificar).
- `evals/scoring/text-scorer.ts` (+ `text-scorer.test.ts`) — matching *any-of* no `TextReportScorer` (modificar).
