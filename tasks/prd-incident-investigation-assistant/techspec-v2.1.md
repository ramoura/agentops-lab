# Especificação técnica — V2.1: Tolerância de fraseado no scorer

> Complementa a `techspec-v2.md`. Cobre exclusivamente a evolução V2.1 do roadmap (`docs/roadmap.md`, seção "V2.1 — Tolerância de fraseado no scorer"): tolerância de sinônimos/fraseado nos `expected_findings` (e, por simetria de schema, em `must_not_include`) do modo llm — sem introduzir um segundo scorer (essa alternativa já tem V2.10 dedicada) e sem alterar o comportamento observável do `DeterministicEvalScorer` (modo V1).

## Resumo executivo

O D11 aceitou como risco conhecido que o `TextReportScorer` (modo llm) reprova findings semanticamente corretos quando o fraseado difere do termo literal esperado — confirmado na prática pelo case-003, onde o modelo escreveu "Não há registros de erro" em vez do termo `Sem registros`. A V2.1 resolve isso trocando o formato de cada entrada de `expected_findings`/`must_not_include` de string única para `FindingSpec = string | string[]`: uma lista de variantes aceitas (matching *any-of*), mantendo o mesmo mecanismo de sempre — substring literal, case/acento-insensível via `normalize()` — sem dependência nova, sem threshold de similaridade e sem perda de determinismo. Abordagens com distância de edição (Levenshtein) ou embeddings foram avaliadas e descartadas: a primeira aproxima strings sem verificar sentido (ex.: "Sem registros" e "Há registros" ficam próximas em edit-distance apesar do sentido oposto) e a segunda introduz custo, latência e um eixo de não-determinismo/threshold que contraria a decisão já registrada no D11 ("scoring 100% determinístico").

A mudança de schema é compartilhada (`packages/types/src/eval.ts`), mas o comportamento tolerante fica isolado no `TextReportScorer`: o `DeterministicEvalScorer` (modo V1) passa a aceitar o novo tipo apenas por compatibilidade — usa sempre a 1ª variante (o rótulo canônico, que é o texto literal que o motor determinístico já gera hoje via template fixo) e ignora as demais, preservando byte a byte o comportamento validado pelos testes 52–59. O case-003 real ganha os aliases que fecham o flake documentado no D11; o breakdown do eval (RF27) passa a citar qual variante bateu, mantendo — e melhorando — a diagnosticabilidade. Fica explicitamente fora de escopo (reservado à V2.10) qualquer segundo scorer: a V2.1 é só a mitigação léxica que o roadmap descreve como primeira tentativa.

## Arquitetura do sistema

### Visão dos componentes

Nenhum componente novo — extensão pontual em 3 arquivos existentes do eval harness, mais o dado de um caso:

- **`packages/types/src/eval.ts`** (modificado): novo tipo `FindingSpec = string | string[]` e schema Zod `findingSpecSchema`; `evalCaseSchema.expected_findings` e `.must_not_include` passam de `string[]` para `FindingSpec[]`.
- **`evals/scoring/scorer.ts`** (modificado): ganha dois helpers puros exportados — `primaryVariant(spec)` (rótulo canônico; usado no nome do critério pelos dois scorers) e `variants(spec)` (candidatos de matching any-of). `DeterministicEvalScorer.scoreFinding`/`scoreForbidden` passam a receber `FindingSpec`, mas continuam comparando apenas `primaryVariant(spec)` — nenhuma tolerância entra no modo V1; comportamento observável idêntico ao de hoje.
- **`evals/scoring/text-scorer.ts`** (modificado): `TextReportScorer`'s `scoreFinding`/`scoreForbidden` usam `variants(spec)` para matching any-of — passa se **qualquer** variante aparecer no texto (e, para `must_not_include`, falha se **qualquer** variante aparecer); `details` passa a citar a variante que bateu quando há mais de uma.
- **`evals/cases/case-003-missing-data.json`** (modificado — dado, não código): os 2 findings que causaram o flake documentado (`Sem registros`, `Sem métricas de latência`) ganham variantes reais observadas.

**Intocados** (garantia de escopo): `mcp-servers/agentops-server/**`, `packages/{core,providers}/**`, `packages/llm-engine/**` (prompt, loop, cache — nada muda no que o modelo recebe ou como é chamado; a V2.1 é pós-processamento do texto já gerado), `apps/cli-agent/**` (renderer e CLI não mudam), `evals/cases/case-001*.json` e `case-002*.json` (continuam `string[]` puro — nenhum flake conhecido ali), `evals/src/runner.ts` (o dispatch de scoring por `outcome.kind` já existe e não muda).

Fluxo de dados (case com alias, modo llm):

```
case JSON: expected_findings: ["inventory-api", ["Sem registros", "Não há registros", ...], ...]
  → evalCaseSchema.parse() valida FindingSpec[] (string ou string[] não vazio)
  → TextReportScorer.score(): para cada spec, variants(spec) tenta cada candidato contra o texto normalizado
      1ª variante que bate → passed=true, details cita a variante
      nenhuma bate         → passed=false, details cita o rótulo primário + nº de variantes tentadas
  → criterion.name usa sempre primaryVariant(spec) — estável entre execuções (RF27)
```

Mesmo case JSON, modo deterministic (V1) — nenhuma tolerância:

```
DeterministicEvalScorer.scoreFinding(spec, text): compara só primaryVariant(spec)
  → primaryVariant(["Sem registros", "Não há registros", ...]) === "Sem registros"
  → o motor V1 gera esse texto literal por template fixo (packages/core/src/engine.ts:145) → sempre passa, como hoje
```

## Design de implementação

### Principais interfaces

```typescript
// packages/types/src/eval.ts
/** Uma entrada de expected_findings/must_not_include: termo único ou variantes aceitas (any-of). */
export type FindingSpec = string | string[];

export const findingSpecSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);
```

```typescript
// evals/scoring/scorer.ts — helpers compartilhados pelos 2 scorers
/** Rótulo canônico de um FindingSpec — 1ª variante; nome estável do critério (RF27). */
export function primaryVariant(spec: FindingSpec): string {
  return Array.isArray(spec) ? spec[0]! : spec;
}

/** Candidatos de matching any-of — string única vira lista de 1 elemento. */
export function variants(spec: FindingSpec): string[] {
  return Array.isArray(spec) ? spec : [spec];
}
```

### Modelos de dados

Contratos internos do eval harness (não há API HTTP). Nenhum campo é normalizado para `null` — todas as entradas continuam obrigatórias como hoje; a única mudança é a *forma* aceita por item.

#### `FindingSpec` — termo esperado (`expected_findings`) ou proibido (`must_not_include`), com variantes aceitas

| Forma | Validação (Zod) | Significado |
| --- | --- | --- |
| `string` | `z.string().min(1)` | Termo único — comportamento idêntico ao pré-V2.1 (nenhuma tolerância). |
| `string[]` | `z.array(z.string().min(1)).min(1)` | Lista de variantes aceitas; passa (ou, em `must_not_include`, falha) se **qualquer** variante bater. A 1ª posição é o rótulo canônico — nome do critério e único termo considerado pelo `DeterministicEvalScorer`. |

```json
{
  "expected_findings": [
    "inventory-api",
    ["Sem registros", "Não há registros", "nenhum registro"],
    "baixa"
  ]
}
```

#### `EvalCase` — caso de teste do eval harness (`evals/cases/*.json`, RF25)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `id` | `string` | sim | Identificador do caso (nome do arquivo, sem extensão). |
| `question` | `string` | sim | Pergunta enviada ao motor sob teste. |
| `expected_findings` | `FindingSpec[]` | sim | Antes: `string[]`. A partir da V2.1, cada item aceita `string` ou `string[]` (variantes). |
| `must_not_include` | `FindingSpec[]` | sim | Mesma mudança de tipo, por simetria de schema — nenhum caso real usa variantes aqui hoje. |

`case-003-missing-data.json` completo, com os aliases que fecham o flake documentado no D11:

```json
{
  "id": "case-003-missing-data",
  "question": "Investigue por que o inventory-api teve erro 5xx entre 10h e 10h30 em 2026-07-08",
  "expected_findings": [
    "inventory-api",
    ["Sem registros", "Não há registros", "nenhum registro"],
    ["Sem métricas de latência", "sem dados de latência", "não há métricas de latência"],
    "baixa"
  ],
  "must_not_include": [
    "DatabaseTimeoutException",
    "PaymentGatewayTimeoutException",
    "POST /checkout",
    "deploy da versão"
  ]
}
```

> `case-001-database-timeout.json` e `case-002-payment-api-timeout.json` **não mudam**: nenhum flake foi observado neles; continuam `string[]` puro (equivalente a `FindingSpec[]` sem nenhum item em forma de array).

#### `EvalCriterionResult` — mudança de comportamento no `details`, mesma forma (RF27)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `name` | `string` | sim | Sem mudança de forma. A partir da V2.1, para findings/proibidos com variantes, usa sempre `primaryVariant(spec)` — estável entre execuções mesmo quando o match ocorre por uma variante diferente. |
| `passed` | `boolean` | sim | Sem mudança. |
| `details` | `string` | sim | A partir da V2.1, quando `spec` tem mais de 1 variante, cita qual variante bateu (ou quantas foram tentadas, em caso de falha). |

```json
{
  "name": "finding:Sem registros",
  "passed": true,
  "details": "encontrado no relatório via variante \"Não há registros\""
}
```

> **Sem alias (comportamento pré-V2.1, preservado):** `spec` com 1 variante só não muda o texto de `details`.

```json
{
  "name": "finding:inventory-api",
  "passed": true,
  "details": "encontrado no relatório"
}
```

### Endpoints da API

Não há endpoints HTTP nem comandos de CLI novos ou alterados nesta evolução. A mudança é interna ao par schema/scorer do eval harness; `npm run eval` e `npm run eval:llm` continuam com a mesma assinatura e a mesma saída (stdout: score + breakdown; stderr: progresso), exatamente como documentado nas techspecs V2 e V2.5.

## Pontos de integração

Não há integrações externas novas nesta evolução (nenhuma dependência adicionada; nenhum contrato de tool MCP ou de provider alterado). O único "consumidor" externo do formato mudado é quem escreve casos de eval (`evals/cases/*.json`) — a mudança de schema é aditiva e retrocompatível: qualquer `EvalCase` 100% `string[]` (o formato de hoje) continua válido sem alteração.

## Abordagem de testes

Meta: manter a cobertura global > 80% (padrão do projeto: Vitest, testes co-localizados, sem gasto de tokens na suíte default). Numeração sequencial global do projeto — o último teste existente é o 76 (`apps/cli-agent/e2e/cli.e2e.test.ts`); os novos começam em 77.

### Testes unitários

**`packages/types` — schema (`findingSpecSchema` / `evalCaseSchema`):**

77. String única e `string[]` não vazio validam via `findingSpecSchema`; `string` vazia e `string[]` vazio são rejeitados pelos `.min(1)`.
78. `evalCaseSchema.parse()` aceita um `EvalCase` misto (algumas entradas `string`, outras `string[]`) sem erro — compatibilidade com os casos legados (case-001, case-002, 100% `string[]` de itens únicos).

**`evals/scoring/scorer.ts` — helpers compartilhados (`primaryVariant`, `variants`):**

79. `primaryVariant`: string única → ela mesma; array → o 1º elemento (nunca concatenação/join).
80. `variants`: string única → array de 1 elemento; array → o mesmo conteúdo recebido, na mesma ordem.

**`evals/scoring/scorer.ts` — `DeterministicEvalScorer` (regressão + novo tipo):**

81. Regressão: os 8 testes originais (52–59) continuam passando sem alteração de import/comportamento para os casos 100% `string` existentes.
82. Entrada em array (ex.: `["Sem registros", "Não há registros"]`) com texto contendo **só** a 2ª variante → critério falha — o V1 não ganha tolerância; só a variante primária é considerada (comportamento documentado nesta spec).
83. Determinismo (extensão do teste 59): `score()` chamado duas vezes com um `EvalCase` contendo entradas em array → resultados `toEqual`.

**`evals/scoring/text-scorer.ts` — matching any-of (`TextReportScorer`):**

84. Finding como array: variante que **não** é a primária presente no texto → critério passa; `details` cita a variante encontrada entre aspas.
85. Finding como array: nenhuma variante presente no texto → critério falha; `details` cita o rótulo canônico (`primaryVariant`) e quantas variantes foram tentadas.
86. Finding como string única (regressão): `criteria` e `details` byte-idênticos aos testes 29–35 — nenhuma mudança de wording quando não há alias.
87. `criterion.name` usa sempre a variante primária, independente de qual variante bateu — garante estabilidade do breakdown entre execuções (RF27) mesmo com resposta do modelo variando.
88. `must_not_include` como array: qualquer variante presente reprova o critério (`passed=false`, `details` cita a variante encontrada); nenhuma variante presente → aprova.
89. Regressão do flake original: fixture com o texto "Não há registros de erro para o inventory-api..." (a frase que causou o flake documentado no D11) contra `case-003-missing-data.json` atualizado → os 2 findings antes flakeados agora passam.

**`evals` — dataset real:**

90. `case-003-missing-data.json` atualizado valida contra `evalCaseSchema` sem erro (regressão de `loadCases()` — carregamento e parsing de todos os `evals/cases/*.json`).

### Testes de integração

- **`evals/src/runner.integration.test.ts`**: `runEvals()` completo com o `TextReportScorer` real e um assistant llm fake configurado para responder com a frase alternativa "Não há registros de erro" → case-003 aprovado (fecha o loop ponta a ponta do flake, sem gastar tokens).
- **Regressão do gate principal**: `runEvals({ engine: 'deterministic' })` com os 3 casos reais (incluindo o case-003 atualizado) → 3/3 aprovados, score médio 1.0 — `npm run eval` (default, sem key, CI) continua verde.

### Testes E2E

- **Regressão do default**: `npm run eval` (modo deterministic, CI) permanece verde com os mesmos 3 casos — nenhuma mudança de comportamento observável do lado de fora.
- **Smoke opt-in com LLM real** (`npm run eval:llm`, requer `ANTHROPIC_API_KEY`, fora da CI): validação qualitativa e manual de que o case-003 deixa de reprovar pela frase alternativa documentada no D11. Não é uma asserção automatizada de ausência de flake — medir a taxa de flake é o objeto da V2.9, fora do escopo desta spec.

> Não há frontend — Playwright não se aplica (mesma justificativa das techspecs anteriores).

## Sequenciamento do desenvolvimento

### Ordem de construção

1. **`packages/types/src/eval.ts`**: `FindingSpec` + `findingSpecSchema` (testes 77–78). Primeiro porque os dois scorers dependem do tipo novo.
2. **`evals/scoring/scorer.ts`**: helpers `primaryVariant`/`variants` + adaptação do `DeterministicEvalScorer` ao novo tipo, sem mudar comportamento (testes 79–83). Segundo porque `text-scorer.ts` já importa `normalize` deste mesmo arquivo — os novos helpers entram no mesmo ponto de reuso.
3. **`evals/scoring/text-scorer.ts`**: matching any-of no `TextReportScorer` (testes 84–89). Depende dos helpers do passo 2.
4. **`evals/cases/case-003-missing-data.json`**: aliases reais que fecham o flake documentado (teste 90).
5. **Integração + E2E**: runner real com os 3 casos e o smoke opt-in `eval:llm`.
6. **Documentação**: `docs/roadmap.md` (marcar V2.1 como ✅ entregue) e `docs/decisions.md` (nova entrada D14, complementando — não substituindo — o risco assumido no D11).

### Dependências técnicas

- Nenhuma dependência nova: matching continua sobre `normalize()` (já existente), sem lib de similaridade/NLP.
- Nenhuma variável de ambiente nova.
- `ANTHROPIC_API_KEY` segue necessária apenas para o smoke opcional (`eval:llm`), como hoje.

## Monitoramento e observabilidade

Mesma filosofia das techspecs anteriores (lab local, saída textual, sem Prometheus/Grafana no projeto):

- **Breakdown do eval (RF27, stdout)** é o instrumento desta evolução: o `details` de cada critério de finding/proibido passa a citar a variante que bateu (`via variante "..."`) sempre que houver mais de uma — permite, olhando uma execução, decidir se a lista de aliases de um caso precisa crescer.
- **Nome do critério estável** (`primaryVariant`) preserva a possibilidade de comparar breakdowns de execuções diferentes lado a lado (ex.: grep por `finding:Sem registros` continua funcionando independente de qual variante bateu naquela execução).
- **Sem sinal novo de erro**: `findingSpecSchema` inválido (`string` ou `string[]` vazios) falha no carregamento do caso (`loadCases()`), com o mesmo erro de validação Zod que já existe para o schema atual — nenhum modo de falha novo.

## Considerações técnicas

### Principais decisões

- **Lista de aliases (*any-of*) em vez de distância de edição ou embeddings** (escolha do usuário, com base em pesquisa: Levenshtein aproxima strings sem verificar sentido — "Sem registros" e "Há registros" ficam próximos em edit-distance apesar do sentido oposto; embeddings introduzem custo, latência e um novo eixo de não-determinismo/threshold). A lista de aliases mantém o scoring 100% determinístico (decisão já registrada no D11) sem dependência nova.
- **Escopo restrito à tolerância léxica; segundo scorer explicitamente fora** (escolha do usuário): o roadmap junta as duas ideias na mesma entrada V2.1, mas a V2.10 (LLM-as-judge, opt-in) já é a evolução reservada para "segundo scorer" — antecipá-la aqui gastaria escopo numa decisão que a V2.9 (medição de flake) deveria informar com dados, não intuição.
- **Tolerância só no `TextReportScorer`; `DeterministicEvalScorer` recebe o novo tipo apenas por compatibilidade** (escolha do usuário): o modo V1 gera texto por template fixo, sem variação de fraseado — não há flake a resolver ali. Para não duplicar o schema (`FindingSpec` é campo único e compartilhado, escolha explícita abaixo), o V1 precisa aceitar o tipo `FindingSpec`, mas usa sempre `primaryVariant(spec)` — que, para os 3 casos reais, é exatamente o texto literal que o V1 já gera hoje. Resultado: nenhuma mudança de comportamento observável no modo determinístico (mesma rede de segurança do `npm run eval` sem key).
- **Schema por união inline (`string | string[]`) em vez de campo paralelo** (escolha do usuário): `expected_findings: FindingSpec[]` em vez de manter `expected_findings: string[]` e adicionar um campo novo (`expected_findings_any_of` ou similar). Motivo: menor diff nos casos que não precisam de alias (case-001, case-002 seguem `string[]` puro, zero mudança), e um único campo continua com um único papel — sem duplicar o conceito "finding esperado" em dois lugares do mesmo `EvalCase`.
- **`must_not_include` ganha o mesmo formato por simetria de schema** (escolha do usuário), mesmo sem caso de uso real hoje: custo zero de implementação (mesma função `variants`/`primaryVariant` serve aos dois campos), e evita dois formatos de entrada divergentes dentro do mesmo arquivo de caso.
- **`details` cita a variante que bateu; `criterion.name` continua usando a variante primária** (escolha do usuário): preserva a chave estável usada por quem compara breakdowns entre execuções (RF27), enquanto ainda expõe no texto qual variante específica casou — os dois objetivos (estabilidade de nome + diagnosticabilidade de conteúdo) não colidem porque vivem em campos diferentes do mesmo `EvalCriterionResult`.

### Riscos conhecidos

- **Aliases mal calibrados mascaram regressões reais**: uma lista de variantes ampla ou genérica demais pode aprovar textos que, na prática, mudaram de sentido. Mitigação: aliases são curados manualmente por caso (não gerados automaticamente por nenhuma heurística de similaridade); o `details` sempre expõe qual variante bateu, tornando o "match por alias" visível e revisável no breakdown, não silencioso.
- **Cobertura de aliases é finita**: a lista resolve o fraseado já observado (case-003), mas não garante que o modelo nunca produza uma variante nova. Mitigação: é exatamente o objeto de estudo da V2.9 (medição de flake, N execuções); se a taxa residual incomodar mesmo com aliases, o roadmap já reserva a V2.10 (LLM-as-judge) como alternativa — não esta spec, por decisão explícita de escopo.
- **`must_not_include` com aliases pode ficar permissivo demais**: um alias genérico demais (ex.: um termo muito curto ou comum) proibiria frases legítimas que apenas contêm a palavra incidentalmente. Mitigação: mesma curadoria manual do `expected_findings`; nenhum caso real usa variantes em `must_not_include` hoje — o campo só ganha o tipo por simetria, o risco é teórico até o primeiro caso real usar a forma array ali.
- **`DeterministicEvalScorer` com tipo mais permissivo que o comportamento**: `FindingSpec` aceita array, mas o V1 só considera `primaryVariant` — um autor de caso poderia esperar (por engano) tolerância também no modo determinístico e não obtê-la. Mitigação: comentário no código de `scoreFinding`/`scoreForbidden` do V1 explicando a decisão; esta techspec e o D14 documentam o comportamento explicitamente.

### Conformidade com skills

Skills em `.claude/skills/` aplicáveis a esta especificação:

- **`criar-techspec`**: esta especificação segue o template e o fluxo da skill.
- **`criar-tasks` / `executar-task`**: próximos passos naturais para decompor e implementar esta spec.
- **`desenvolver-mcp-tools`**: não aplicável — nenhuma tool, schema ou contrato MCP muda nesta evolução (mudança inteiramente do lado do eval harness, pós-processamento do texto já gerado).

> `.claude/rules/` não existe no repositório (verificado; mesma constatação das techspecs anteriores). As convenções vigentes vêm de `AGENTS.md` e das skills acima.

### Arquivos relevantes e dependentes

**Modificados:**

- `packages/types/src/eval.ts` — `FindingSpec`, `findingSpecSchema`, `evalCaseSchema` atualizado.
- `evals/scoring/scorer.ts` (+ `scorer.test.ts`) — helpers `primaryVariant`/`variants`; `DeterministicEvalScorer` adaptado ao novo tipo sem mudar comportamento.
- `evals/scoring/text-scorer.ts` (+ `text-scorer.test.ts`) — matching any-of no `TextReportScorer`; `details` cita a variante encontrada.
- `evals/cases/case-003-missing-data.json` — aliases reais para os 2 findings que causaram o flake.
- `evals/src/runner.integration.test.ts` — regressão com os 3 casos reais e novo teste de fechamento do flake.
- `docs/roadmap.md`, `docs/decisions.md` — V2.1 marcada como entregue; nova entrada D14 complementando o D11.

**Dependentes (não modificados — garantia de escopo):** `mcp-servers/agentops-server/**`, `packages/core/**`, `packages/providers/**`, `packages/llm-engine/**` (prompt-builder, loop, cache, tool-mapping), `apps/cli-agent/**` (renderer, CLI, mcp-tool-invoker), `evals/cases/case-001-database-timeout.json`, `evals/cases/case-002-payment-api-timeout.json`, `evals/src/runner.ts` (dispatch por `outcome.kind` já existente), `datasets/**`, `knowledge-base/**`, `skills/**`.
