# Especificação técnica

## Resumo executivo

A V2.6 adicionará avaliação determinística da trajetória de investigação sem alterar o motor, as tools MCP ou o gate atual baseado no relatório. Um novo `TrajectoryScorer` receberá o `ToolCallRecord[]` já presente em todos os resultados bem-sucedidos e avaliará seleção de tools, parâmetros relevantes, redundância, volume de chamadas e relações parciais de precedência. O resultado será exibido ao lado do score de outcome, mas permanecerá informativo: não modificará `EvalCaseResult.score`, `EvalCaseResult.passed`, o exit code nem o comportamento de `npm run eval` na CI.

Os casos poderão declarar um bloco opcional `expected_trajectory`. A ausência desse bloco preservará integralmente o comportamento existente. As expectativas serão compostas por restrições locais e verificáveis, não por uma sequência completa idealizada. Essa escolha permite comparar os motores `deterministic` e `llm` sobre o mesmo contrato de auditoria, evitando acoplamento ao `RoundTrace` específico da Anthropic ou a uma estratégia única de investigação.

## Arquitetura do sistema

### Visão dos componentes

- **`packages/types/src/eval.ts` (modificado):** define e valida as expectativas de trajetória e o resultado informativo do scorer. `EvalCase` ganha `expected_trajectory` opcional; `EvalCaseResult` permanece inalterado para preservar o gate atual.
- **`evals/scoring/trajectory-scorer.ts` (novo):** scorer puro e determinístico sobre `ToolCallRecord[]`. Produz critérios independentes, score entre 0 e 1 e métricas diagnósticas.
- **`evals/scoring/trajectory-scorer.test.ts` (novo):** cobre matching parcial de parâmetros, precedência, duplicatas, limites e entradas vazias/inválidas.
- **`evals/src/runner.ts` (modificado):** extrai o audit de `InvestigationOutcome`, executa o scorer quando o caso contém expectativas e imprime um bloco separado de trajetória.
- **`evals/src/runner.integration.test.ts` (modificado):** verifica integração nos motores determinístico e LLM fake, compatibilidade de casos legados e invariância do gate/exit code.
- **`evals/cases/*.json` (modificados):** passam a conter expectativas específicas e conservadoras por cenário. O case-003 aceita uma trajetória menor porque a ausência de dados encerra legitimamente a investigação antes da knowledge base.
- **`packages/types/src/schemas.test.ts` (modificado):** valida os novos schemas e a compatibilidade retroativa.
- **`docs/decisions.md` (modificado):** registra que trajectory evals começam informativos e que restrições parciais são preferidas a uma sequência exata.
- **`docs/roadmap.md` e `README.md` (modificados):** documentam a entrega, a leitura dos dois scores e como configurar expectativas em novos casos.

Fluxo de dados:

```text
EvalCase.expected_trajectory (opcional)
                +
InvestigationOutcome.audit / report.audit
                |
                v
       TrajectoryScorer.score()
                |
                v
     TrajectoryEvalResult informativo
                |
                +--> breakdown separado em stdout
                +--> EvalRunCaseResult retornado pelo runner

Outcome scorer existente ----------------> gate, exit code e score atuais
```

O scorer não lerá o markdown, `RoundTrace`, conteúdo integral de `tool_result`, tokens ou duração como condição de aprovação. `durationMs` poderá ser agregado para diagnóstico, mas não será critério, pois varia conforme máquina e transporte MCP.

## Design de implementação

### Principais interfaces

```typescript
interface TrajectoryScorer {
  score(
    expectation: ExpectedTrajectory,
    records: readonly ToolCallRecord[],
  ): TrajectoryEvalResult;
}
```

```typescript
interface EvalRunCaseResult {
  outcome: EvalCaseResult;
  trajectory: TrajectoryEvalResult | null;
}
```

O runner será responsável por extrair a auditoria sem depender do motor concreto:

```typescript
function auditFromOutcome(outcome: InvestigationOutcome): ToolCallRecord[] {
  if (outcome.kind === 'report') return outcome.report.audit;
  if (outcome.kind === 'markdown') return outcome.audit;
  return [];
}
```

`EvalRunSummary.results` passará a expor `EvalRunCaseResult[]`. Para reduzir impacto nos consumidores internos, os campos de outcome usados atualmente (`caseId`, `score`, `passed`, `criteria`) poderão ser mantidos no nível superior por interseção ou getters de montagem, mas o contrato canônico recomendado é a composição explícita acima. A implementação deve atualizar todos os usos estaticamente; não deve recorrer a cast ou `any` para simular compatibilidade.

### Modelos de dados

Os contratos são locais ao eval harness e não representam payloads de backend/UI. Campos ausentes em `expected_trajectory` não são normalizados para `null`: o bloco inteiro é opcional, e propriedades internas têm defaults definidos pelo schema quando indicado. Isso preserva casos legados sem migração obrigatória.

#### `ExpectedTrajectory` — expectativas informativas de processo por caso

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `required_calls` | `RequiredToolCallExpectation[]` | não | Chamadas que devem existir com tool e parâmetros compatíveis. Default `[]`. |
| `order_constraints` | `ToolOrderConstraint[]` | não | Relações parciais de precedência entre expectativas nomeadas. Default `[]`. |
| `forbid_exact_duplicates` | `boolean` | não | Reprova chamadas repetidas com mesma tool e parâmetros semanticamente iguais. Default `true`. |
| `max_calls` | `number` inteiro ≥ 0 | não | Teto conservador para o total de chamadas. Ausente significa sem teto. |

```json
{
  "required_calls": [
    {
      "id": "latency_incident",
      "tool": "get_latency_summary",
      "params": {
        "service": "checkout-api",
        "from": "2026-07-08T10:00:00-03:00",
        "to": "2026-07-08T10:30:00-03:00"
      },
      "min_occurrences": 1,
      "max_occurrences": 1
    },
    {
      "id": "latency_baseline",
      "tool": "get_latency_summary",
      "params": {
        "service": "checkout-api",
        "from": "2026-07-08T09:30:00-03:00",
        "to": "2026-07-08T10:00:00-03:00"
      },
      "min_occurrences": 1,
      "max_occurrences": 1
    }
  ],
  "order_constraints": [
    {
      "before": "latency_incident",
      "after": "knowledge_search"
    }
  ],
  "forbid_exact_duplicates": true,
  "max_calls": 12
}
```

> **Caso legado:** quando `expected_trajectory` estiver ausente, o runner não executará o scorer nem imprimirá o bloco de trajetória. O outcome continuará sendo pontuado exatamente como hoje.

```json
{
  "id": "case-legado",
  "question": "Investigue o incidente informado",
  "expected_findings": ["timeout"],
  "must_not_include": ["drop table"]
}
```

#### `RequiredToolCallExpectation` — padrão de chamada esperado

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `id` | `string` não vazia | sim | Identificador único dentro do caso, usado nas restrições de ordem e no breakdown. |
| `tool` | `ToolName` | sim | Nome exato de uma das nove tools conhecidas. |
| `params` | `Record<string, unknown>` | não | Subconjunto de parâmetros que precisa estar presente e ser igual no registro. Default `{}`. |
| `min_occurrences` | `number` inteiro ≥ 0 | não | Quantidade mínima de chamadas compatíveis. Default `1`. |
| `max_occurrences` | `number` inteiro ≥ 0 | não | Quantidade máxima compatível. Ausente significa sem máximo específico. |

```json
{
  "id": "deploy_window",
  "tool": "get_deployment_events",
  "params": {
    "service": "checkout-api",
    "from": "2026-07-08T09:45:00-03:00",
    "to": "2026-07-08T10:30:00-03:00"
  },
  "min_occurrences": 1,
  "max_occurrences": 1
}
```

O matching de `params` será recursivo por subconjunto: todas as chaves declaradas devem existir e ter valor semanticamente igual; chaves adicionais no registro são permitidas. Arrays mantêm ordem e tamanho exatos quando declarados. Objetos ignoram ordem de propriedades. Não haverá coerção de strings, datas ou números.

#### `ToolOrderConstraint` — precedência parcial entre chamadas

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `before` | `string` | sim | `id` de uma expectativa em `required_calls`. |
| `after` | `string` | sim | `id` de outra expectativa em `required_calls`. |

```json
{
  "before": "error_summary",
  "after": "knowledge_search"
}
```

A restrição passa quando existe ao menos uma chamada compatível com `before` cujo `seq` seja menor que ao menos uma chamada compatível com `after`. Se um dos lados não casar, a restrição falha com detalhe explícito; o critério da chamada obrigatória também falhará separadamente, oferecendo diagnóstico e crédito parcial. Não será exigida adjacência.

#### `TrajectoryCriterionResult` — resultado de uma regra de trajetória

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `name` | `string` | sim | Nome estável, como `trajectory:required:latency_baseline`. |
| `passed` | `boolean` | sim | Resultado determinístico da regra. |
| `details` | `string` | sim | Quantidade observada, registros envolvidos ou motivo da falha. |

```json
{
  "name": "trajectory:required:latency_baseline",
  "passed": true,
  "details": "1 chamada compatível encontrada (seq: 5)"
}
```

#### `TrajectoryMetrics` — diagnóstico agregado da execução

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `total_calls` | `number` | sim | Total de registros auditados. |
| `unique_call_signatures` | `number` | sim | Total de combinações únicas tool + params canônicos. |
| `duplicate_calls` | `number` | sim | Ocorrências excedentes de assinaturas repetidas. |
| `failed_calls` | `number` | sim | Registros cujo `resultSummary` começa com `ERRO:`. |
| `total_duration_ms` | `number` | sim | Soma observacional das durações, nunca usada no score. |

```json
{
  "total_calls": 10,
  "unique_call_signatures": 10,
  "duplicate_calls": 0,
  "failed_calls": 0,
  "total_duration_ms": 31.42
}
```

#### `TrajectoryEvalResult` — score informativo da trajetória

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `criteria` | `TrajectoryCriterionResult[]` | sim | Breakdown na ordem declarativa: obrigatórias, ordem, duplicatas e teto. |
| `score` | `number` entre 0 e 1 | sim | Fração de critérios aprovados, arredondada em duas casas. |
| `passed` | `boolean` | sim | `true` quando todos os critérios de trajetória passam; apenas informativo. |
| `metrics` | `TrajectoryMetrics` | sim | Diagnóstico independente do score. |

```json
{
  "criteria": [
    {
      "name": "trajectory:required:latency_baseline",
      "passed": true,
      "details": "1 chamada compatível encontrada (seq: 5)"
    },
    {
      "name": "trajectory:no_exact_duplicates",
      "passed": true,
      "details": "0 chamada duplicada"
    }
  ],
  "score": 1,
  "passed": true,
  "metrics": {
    "total_calls": 10,
    "unique_call_signatures": 10,
    "duplicate_calls": 0,
    "failed_calls": 0,
    "total_duration_ms": 31.42
  }
}
```

#### `EvalRunCaseResult` — composição entre outcome e trajetória

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `outcome` | `EvalCaseResult` | sim | Resultado canônico existente, único responsável pelo gate. |
| `trajectory` | `TrajectoryEvalResult \| null` | sim | Resultado informativo; `null` para caso sem expectativa. |

```json
{
  "outcome": {
    "caseId": "case-001-database-timeout",
    "criteria": [],
    "score": 1,
    "passed": true
  },
  "trajectory": {
    "criteria": [],
    "score": 0.88,
    "passed": false,
    "metrics": {
      "total_calls": 11,
      "unique_call_signatures": 10,
      "duplicate_calls": 1,
      "failed_calls": 0,
      "total_duration_ms": 40.1
    }
  }
}
```

> **Sem expectativa de trajetória:** `trajectory: null`; isso não representa falha nem degradação.

```json
{
  "outcome": {
    "caseId": "case-legado",
    "criteria": [],
    "score": 1,
    "passed": true
  },
  "trajectory": null
}
```

#### `InvalidTrajectoryExpectation` — erro de configuração do caso

Não há envelope HTTP. Erros são produzidos pelo Zod durante `loadCases()` e encerram o eval antes de iniciar o MCP server.

| Código | HTTP | Significado |
| --- | --- | --- |
| `INVALID_EVAL_CASE` | não se aplica | Schema inválido, `id` duplicado, referência de ordem inexistente ou limites incoerentes. |

```json
{
  "error": {
    "code": "INVALID_EVAL_CASE",
    "message": "case-001-database-timeout: order_constraints[0].after referencia required_call inexistente: knowledge_search"
  }
}
```

Validações semânticas via `superRefine`:

- `RequiredToolCallExpectation.id` deve ser único no caso.
- `max_occurrences`, quando presente, deve ser maior ou igual a `min_occurrences`.
- `before` e `after` devem referenciar IDs existentes e distintos.
- `max_calls`, quando presente, deve ser compatível com a soma mínima possível das expectativas que não podem compartilhar uma mesma chamada. A implementação pode aceitar sobreposição entre padrões; portanto essa verificação deve ser conservadora, evitando rejeitar casos válidos.

#### Mapeamento auditoria → contrato de trajetória

| Origem (`ToolCallRecord`) | Destino |
| --- | --- |
| `seq` | resolução de precedência e detalhe dos critérios |
| `tool` | seleção da expectativa e assinatura de duplicata |
| `params` | matching parcial e assinatura canônica de duplicata |
| `resultSummary` prefixado por `ERRO:` | `TrajectoryMetrics.failed_calls` |
| `durationMs` | `TrajectoryMetrics.total_duration_ms` |

#### Parâmetros fixados no upstream (backend)

| API | Parâmetros principais |
| --- | --- |
| **Nenhuma API externa** | O scorer é local, puro e determinístico; não chama LLM, MCP ou filesystem. |

### Endpoints da API

Não há endpoints HTTP. A superfície permanece a CLI existente; nenhuma flag nova é necessária na V2.6.

#### Visão geral

| Método | Rota | Descrição |
| --- | --- | --- |
| CLI | `npm run eval` | Executa outcome eval e, quando configurado no caso, trajectory eval informativo. |
| CLI | `npm run eval:llm` | Executa o mesmo fluxo com motor LLM; trajectory eval usa o mesmo audit normalizado. |

---

#### `CLI npm run eval [-- --engine=deterministic|llm]`

Executa os casos, mantém o breakdown atual e adiciona um bloco separado quando `expected_trajectory` existir.

**Argumentos**

| Param | Tipo | Default | Regras |
| --- | --- | --- | --- |
| `--engine` | `deterministic \| llm` | `deterministic` | Inalterado; `llm` exige configuração já existente. |

**Respostas**

| Status | Corpo | Quando |
| --- | --- | --- |
| exit `0` | texto em stdout | Todos os outcomes passam, independentemente do trajectory score. |
| exit `1` | texto/erro em stderr | Algum outcome falha ou há erro de configuração/execução. Trajectory isoladamente nunca causa exit `1`. |

**Exemplo — outcome e trajetória aprovados**

```http
npm run eval
```

```text
case-001-database-timeout — outcome 1.00 (13/13 critérios) — APROVADO
  [OK] finding:DatabaseTimeoutException — encontrado no relatório
  ...
  Trajetória — score 1.00 (9/9 critérios) — INFORMATIVO: OK
    [OK] trajectory:required:latency_baseline — 1 chamada compatível encontrada (seq: 5)
    [OK] trajectory:no_exact_duplicates — 0 chamada duplicada
  Métricas: 10 chamadas · 10 únicas · 0 duplicadas · 0 falhas

Resumo: 3/3 outcome(s) aprovado(s) · score médio 1.00 · trajetória média 0.96 (informativa) · engine: deterministic
```

**Exemplo — trajetória abaixo da expectativa, outcome aprovado**

```http
npm run eval -- --engine=llm
```

```text
case-001-database-timeout — outcome 1.00 (13/13 critérios) — APROVADO
  Trajetória — score 0.78 (7/9 critérios) — INFORMATIVO: ATENÇÃO
    [FALHOU] trajectory:no_exact_duplicates — 2 duplicatas: get_recent_logs params={...}

Resumo: 3/3 outcome(s) aprovado(s) · score médio 1.00 · trajetória média 0.85 (informativa) · engine: llm
```

> Mesmo com trajectory score inferior a 1, o comando termina com exit `0` porque todos os outcomes passaram. O rótulo `INFORMATIVO` deve aparecer explicitamente para evitar interpretação equivocada como gate.

**Exemplo — caso legado sem expectativa**

```http
npm run eval
```

```text
case-legado — outcome 1.00 (8/8 critérios) — APROVADO
```

> A ausência de `expected_trajectory` não imprime aviso nem score zero.

**Exemplo — erro de configuração antes do spawn MCP**

```http
npm run eval
```

```json
{
  "error": {
    "code": "INVALID_EVAL_CASE",
    "message": "case-001-database-timeout: required_calls possui id duplicado: latency"
  }
}
```

---

## Pontos de integração

- **Audit log do core:** única fonte do trajectory scorer. Ambos os motores já retornam `ToolCallRecord[]` em `InvestigationOutcome`; nenhuma captura paralela será criada.
- **Eval runner:** combina dois scorers independentes. Outcome continua sendo o gate; trajetória é diagnóstico. Uma falha interna do trajectory scorer por dado já validado é bug e deve encerrar a execução, não ser silenciosamente convertida em score zero.
- **Trace JSONL:** o trace persistido já contém `audit` e o `EvalCaseResult` de outcome. A V2.6 não precisa persistir o resultado de trajetória no primeiro incremento; se for incluído, deve ser um campo opcional para manter leitura dos traces existentes. A decisão final deve privilegiar uma única fonte: não recalcular resultados antigos automaticamente.
- **Sem integrações externas:** não há rede, autenticação, timeout ou nova dependência. Zod e Vitest existentes são suficientes.

As referências técnicas consultadas sustentam a combinação de outcome e processo, mas também alertam contra sequências rígidas. A orientação da Anthropic recomenda graders determinísticos quando possível, métricas como número de chamadas, erros e redundâncias, e evitar sobre-especificar um único caminho válido. O TRAJECT-Bench organiza diagnósticos por seleção de tool, correção de argumentos e dependências/ordem, dimensões adotadas aqui em escala local. Fontes: [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents), [TRAJECT-Bench](https://arxiv.org/abs/2510.04550).

## Abordagem de testes

Meta: manter cobertura global acima de 80% e obter cobertura acima de 90% de linhas e branches para `trajectory-scorer.ts`, por ser lógica pura de decisão. Todos os testes usam Vitest; nenhum teste da suíte default chama API LLM real. Playwright não se aplica porque não existe frontend.

### Testes unitários

**Schemas em `packages/types`:**

1. Caso sem `expected_trajectory` continua válido e não recebe bloco artificial.
2. Bloco vazio aplica defaults (`required_calls=[]`, `order_constraints=[]`, `forbid_exact_duplicates=true`).
3. `required_calls` aceita cada uma das nove `ToolName` e rejeita nome desconhecido.
4. Rejeita `id` vazio e IDs duplicados dentro do caso.
5. `params` ausente normaliza para `{}`.
6. `min_occurrences` ausente normaliza para `1`; aceita `0`; rejeita negativo e fracionário.
7. `max_occurrences` aceita `0`, rejeita negativo/fracionário e rejeita valor menor que `min_occurrences`.
8. `max_calls` aceita zero e inteiro positivo; rejeita negativo, fracionário e string numérica.
9. `order_constraints` aceita referências válidas.
10. Rejeita `before` inexistente, `after` inexistente e autorreferência.
11. Rejeita campos desconhecidos se os schemas do projeto forem definidos como strict nesta evolução; caso se mantenha o padrão strip do Zod atual, documenta e testa esse comportamento consistentemente.
12. `TrajectoryEvalResult` aceita score nos limites 0 e 1 e rejeita valores fora deles.
13. `TrajectoryMetrics` rejeita contagens negativas e duração negativa.

**Matching de parâmetros:**

14. Padrão `{}` casa qualquer chamada da tool correta.
15. Subconjunto simples casa mesmo quando o registro contém parâmetros adicionais.
16. Falha quando uma chave esperada está ausente.
17. Falha quando string, número, booleano ou `null` divergem.
18. Objeto aninhado usa matching recursivo por subconjunto.
19. Array exige mesma ordem, tamanho e valores.
20. Ordem das propriedades de objetos não altera o matching.
21. Não ocorre coerção entre `1` e `"1"`, nem entre offsets de data semanticamente equivalentes escritos de forma diferente.
22. Chaves com valor `undefined`, quando construídas programaticamente, não equivalem a chave ausente.

**Chamadas obrigatórias e ocorrências:**

23. Uma chamada compatível satisfaz o default mínimo 1.
24. Tool correta com parâmetros incompatíveis falha e detalha zero compatíveis.
25. Parâmetros compatíveis em tool diferente não casam.
26. `min_occurrences=2` passa com duas chamadas e falha com uma.
27. `max_occurrences=1` falha com duas chamadas compatíveis.
28. Intervalo `min=1/max=2` passa com uma e duas chamadas.
29. `min=0/max=0` expressa chamada proibida e passa quando ausente.
30. Duas expectativas distintas podem casar chamadas diferentes da mesma tool.
31. Breakdown preserva a ordem declarada das expectativas.
32. Detalhes incluem os `seq` das chamadas compatíveis em ordem crescente.

**Precedência parcial:**

33. Passa quando existe `before.seq < after.seq`.
34. Falha quando todas as chamadas de `before` ocorrem depois das de `after`.
35. Com múltiplas ocorrências, passa se ao menos um par satisfaz a precedência.
36. Falha de chamada obrigatória também produz falha de ordem explicando qual lado não foi encontrado.
37. Não exige adjacência; tools intermediárias são permitidas.
38. Usa `seq`, não a posição física do item no array.
39. Registros recebidos fora de ordem física são avaliados corretamente por `seq`.

**Duplicatas e canonicalização:**

40. Mesma tool e mesmos parâmetros são duplicata.
41. Ordem diferente de chaves no objeto de parâmetros continua sendo duplicata.
42. Parâmetros aninhados com chaves em ordem diferente continuam sendo duplicata.
43. Arrays em ordem diferente não são duplicatas.
44. Mesmos parâmetros em tools diferentes não são duplicata.
45. Três chamadas iguais produzem duas ocorrências excedentes, não três.
46. `forbid_exact_duplicates=true` gera um único critério agregado reprovado com assinaturas/contagens.
47. `forbid_exact_duplicates=false` não cria critério de duplicata, mas mantém a métrica observacional.
48. Diferença apenas em `durationMs`, `seq` ou `resultSummary` não altera a assinatura.

**Teto, métricas e agregação:**

49. `max_calls` passa no limite exato e falha acima dele.
50. `max_calls=0` passa com audit vazio e falha com uma chamada.
51. Ausência de `max_calls` não cria critério correspondente.
52. `total_calls` conta todos os registros, inclusive falhas.
53. `failed_calls` reconhece somente prefixo estrutural `ERRO:`; texto contendo “erro” em outro ponto não conta.
54. `total_duration_ms` soma decimais sem participar de `passed` ou `score`.
55. Audit vazio com expectativas obrigatórias produz score zero ou a fração correta quando há critérios que legitimamente passam.
56. Bloco sem critérios pontuáveis retorna score 1 e `passed=true`, com métricas preenchidas; evita divisão por zero.
57. Score usa quantidade de critérios, atribui crédito parcial e arredonda em duas casas como os scorers existentes.
58. Execuções repetidas com mesmas expectativas e audit, variando apenas duração, produzem critérios e score idênticos.

### Testes de integração

59. `loadCases()` carrega os três casos reais com `expected_trajectory` e preserva ordem alfabética.
60. Motor determinístico produz audit não vazio e trajectory score esperado em todos os casos.
61. Case-001 valida resumo de erros, exceptions, logs, latência do incidente, baseline, deploy e knowledge base sem exigir sequência total.
62. Case-002 permite ausência legítima de deploy relacionado sem exigir hipótese de regressão, mas exige coleta do evento de deploy para concluir a ausência.
63. Case-003 exige somente as consultas de observabilidade necessárias e aceita encerramento antes de runbooks/ADRs/tech specs.
64. Fake LLM com trajetória eficiente obtém trajectory score 1 sem API key.
65. Fake LLM com relatório perfeito e chamada redundante mantém outcome aprovado/score 1, mas trajectory falha parcialmente.
66. Fake LLM com relatório perfeito e sem baseline mantém outcome aprovado, enquanto critério `latency_baseline` falha.
67. Fake LLM que consulta knowledge base antes de dados operacionais falha apenas na precedência configurada.
68. Fake assistant sem audit e caso com expectativas gera breakdown informativo reprovado sem quebrar o outcome scorer.
69. Caso legado em diretório temporário não imprime bloco de trajetória e retorna `trajectory: null`.
70. Caso com expectativa semanticamente inválida falha durante `loadCases()` antes de `McpToolInvoker.connect()`.
71. O stdout diferencia explicitamente “outcome” e “Trajetória — INFORMATIVO”.
72. O resumo calcula média de trajetória apenas entre casos que possuem expectativa.
73. Nenhum caso com expectativa resulta em ausência da parcela “trajetória média” no resumo.
74. Trajectory score abaixo de 1 não altera `passedCount`, `averageScore` de outcome nem engine reportado.
75. Falha de outcome continua reprovando o comando mesmo quando trajetória passa.
76. Modo deterministic e modo llm usam exatamente o audit contido no respectivo outcome, sem consultar `lastTrace`.
77. Gravação opt-in de trace existente continua válida; schema antigo ainda lê registros sem resultado de trajetória.
78. Se o resultado de trajetória for persistido como opcional, round-trip JSONL preserva breakdown e métricas sem alterar traces antigos.

### Testes E2E

79. `npm run eval` executa os três casos reais, mantém exit `0`, outcomes em 100% e exibe trajectory score informativo.
80. A saída E2E contém ao menos um critério de chamada obrigatória, um de duplicata e as métricas agregadas.
81. Um fixture E2E com trajectory score reprovado e outcome aprovado termina com exit `0`.
82. Um fixture E2E com outcome reprovado e trajetória aprovada termina com exit `1`.
83. `npm run eval:llm` permanece opt-in e não é executado na CI/default; sua montagem aceita o mesmo contrato sem dependência adicional.
84. `npm test`, `npm run typecheck` e `npm run test:coverage` passam, com cobertura global acima de 80%.

Não existe frontend; portanto o requisito genérico de Playwright do template não se aplica. Os E2E usam o padrão existente de processos CLI/MCP via Vitest e `execa`.

## Sequenciamento do desenvolvimento

### Ordem de construção

1. **Contratos e schemas:** adicionar expectativas e resultados em `@agentops/types`, incluindo validações semânticas e testes. Isso fixa a linguagem declarativa antes do scorer.
2. **Scorer puro:** implementar matching parcial, canonicalização, métricas e critérios em módulo isolado, com a suíte unitária extensa.
3. **Casos reais:** definir expectativas conservadoras para os três cenários e validar primeiro contra o motor determinístico conhecido.
4. **Integração no runner:** compor outcome e trajetória, atualizar tipos do resumo e renderizar blocos separados sem alterar o gate.
5. **Integração LLM fake e regressões:** provar paridade do contrato entre motores e compatibilidade de casos legados/traces.
6. **Documentação e decisão:** registrar a natureza informativa, exemplos de configuração e critérios para futura promoção seletiva a gate.
7. **Validação final:** rodar typecheck, testes, cobertura e E2E; confirmar que case-001 mantém outcome 100%.

### Dependências técnicas

- Nenhuma biblioteca nova. Usar Zod, TypeScript e Vitest existentes.
- `ToolCallRecord` e auditoria em `InvestigationOutcome` já estão entregues e são pré-requisitos satisfeitos.
- Não depende de `RoundTrace`, API Anthropic, trace JSONL habilitado ou MCP SDK v2.
- A futura V2.12 deverá preservar `seq` determinístico para que restrições de ordem continuem válidas com chamadas concorrentes.

## Monitoramento e observabilidade

A V2.6 é uma ferramenta local de avaliação e não exporá métricas Prometheus nem dashboard Grafana. A observabilidade apropriada é a própria saída determinística do runner:

- score médio de outcome, inalterado;
- trajectory score médio, explicitamente informativo;
- total de chamadas, assinaturas únicas, duplicatas e falhas por caso;
- breakdown por expectativa, com IDs e `seq` relevantes;
- engine utilizado.

Não serão emitidos payloads integrais de tools, evitando duplicação e vazamento acidental de conteúdo no stdout. Parâmetros exibidos em diagnóstico de duplicatas devem usar representação compacta e determinística; no futuro, providers reais podem exigir redaction antes de persistência, mas isso está fora da V2.6.

Logs de erro seguem o padrão atual:

- erro de schema/configuração: stderr e exit `1` antes do spawn MCP;
- resultado informativo abaixo do esperado: stdout, sem mudança de exit code;
- falha inesperada do scorer: stderr e exit `1`, pois representa defeito do harness.

## Considerações técnicas

### Principais decisões

1. **Outcome e trajetória permanecem independentes.** O gate atual responde “o relatório é aceitável?”; o novo score responde “o caminho observado foi eficiente e coerente?”. Misturar ambos esconderia a causa de regressões e quebraria o contrato existente.
2. **Trajectory eval começa informativo.** Critérios de processo são mais frágeis diante de estratégias alternativas válidas. Promoção futura a gate deve ocorrer critério a critério, após dados de estabilidade — nunca promovendo automaticamente o score agregado.
3. **Contrato comum é `ToolCallRecord[]`.** Ele existe nos dois motores, satisfaz RF7 e evita acoplamento ao formato de mensagens da Anthropic. `RoundTrace` permanece recurso de inspeção, não requisito do scorer.
4. **Expectativas são parciais.** O caso descreve capacidades essenciais e limites, não uma lista completa e exata de passos. Isso preserva criatividade legítima enquanto detecta ausência de baseline, consulta desnecessária e duplicação.
5. **Parâmetros usam matching por subconjunto, duplicatas usam igualdade canônica integral.** Expectativas resistem à adição legítima de parâmetros; redundância continua definida com precisão.
6. **Duração é métrica, não critério.** Tools locais variam em milissegundos e providers reais terão características de rede distintas. Teto de chamadas e duplicatas são proxies determinísticos melhores para eficiência nesta fase.
7. **Desenvolvimento próprio em vez de biblioteca de eval.** A lógica é pequena, específica do domínio e opera sobre contratos existentes. Adotar plataforma externa de eval adicionaria rede, persistência e outro formato sem resolver melhor o problema local.
8. **Sem sequência exata da skill.** A recomendação de avaliar dados antes da knowledge base será expressa por poucas precedências entre expectativas nomeadas. Não haverá comparação do array inteiro com uma trajetória dourada.

### Riscos conhecidos

- **Overfitting aos três casos:** expectativas excessivamente específicas podem premiar o motor determinístico e punir estratégias LLM válidas. Mitigação: padrões parciais, tetos folgados e revisão de falhas reais antes de endurecer regras.
- **Dupla penalização:** chamada ausente pode falhar no critério obrigatório e na precedência. Isso é aceito para diagnóstico/crédito parcial, mas deve ficar visível no breakdown; o score não é gate.
- **Audit insuficiente para “formulou hipótese depois dos dados”:** `ToolCallRecord` registra somente tools, não o instante semântico da formulação. A V2.6 não alegará medir isso; avaliar raciocínio intermediário exigiria `RoundTrace` ou judge e fica fora do escopo.
- **Duplicata legítima:** repetir a mesma consulta após mudança de estado poderia ser válido em providers reais. As tools atuais são determinísticas sobre fixtures imutáveis; na V3, esse critério precisará ser reavaliado ou considerar versão/tempo da fonte.
- **Assinatura canônica:** uma implementação incorreta para objetos aninhados pode gerar falsos duplicados. Mitigação: canonicalizador puro, arrays preservados e testes de propriedades/ordem de chaves.
- **Mudança de `EvalRunSummary.results`:** consumidores internos e testes esperam `EvalCaseResult[]`. Mitigação: migração tipada em uma única entrega, composição explícita e testes de regressão da saída/exit code.
- **Concorrência futura:** a V2.12 poderá concluir chamadas fora de ordem. O contrato determina que `seq` representa ordem solicitada, não conclusão; o scorer continuará correto se essa garantia for preservada.
- **Expectativas vazias:** um bloco vazio poderia gerar score enganoso. A especificação define score 1 por identidade e métricas observacionais; a documentação deve recomendar omitir o bloco quando não houver critérios úteis.

### Conformidade com skills

- **`criar-techspec`:** aplicada integralmente para análise do PRD, exploração do repositório, esclarecimentos prévios, aderência ao template e cobertura ampla de testes.
- **`desenvolver-mcp-tools`:** não se aplica diretamente, pois nenhuma tool ou MCP server será criado/modificado; os contratos read-only existentes são apenas consumidos.
- **Context7:** solicitado pela skill, mas indisponível nesta sessão. A pesquisa técnica foi suprida com três consultas web e fontes primárias da Anthropic, OpenAI e literatura acadêmica.
- Não existe `.claude/skills` nem `.claude/rules` neste repositório. As skills aplicáveis foram avaliadas a partir de `.agents/skills` e das instruções de `AGENTS.md`.

### Arquivos relevantes e dependentes

- `prompt.md` — especificação canônica e RF7/RF23–RF27.
- `AGENTS.md` — segurança, auditabilidade, estrutura e obrigação de registrar decisões.
- `docs/roadmap.md` — definição funcional da V2.6.
- `docs/decisions.md` — nova decisão sobre trajectory eval informativo.
- `README.md` — documentação de execução e extensão de casos.
- `packages/types/src/audit.ts` — `ToolCallRecord`, fonte canônica da trajetória.
- `packages/types/src/eval.ts` — schemas de caso e resultado a ampliar.
- `packages/types/src/report.ts` — `InvestigationOutcome` e localização do audit por variante.
- `packages/types/src/trace.ts` — compatibilidade opcional com persistência JSONL.
- `packages/types/src/schemas.test.ts` — testes de contratos.
- `packages/core/src/audit-log.ts` — produção dos registros e regra atual de `seq`.
- `packages/core/src/engine.ts` — trajetória determinística de referência.
- `packages/core/src/deterministic-assistant.ts` — adapter que entrega o report com audit.
- `packages/llm-engine/src/llm-investigation-assistant.ts` — trajetória LLM e auditoria comum.
- `evals/scoring/scorer.ts` — outcome scorer determinístico, que não deve ser alterado.
- `evals/scoring/text-scorer.ts` — outcome scorer LLM, que não deve ser alterado.
- `evals/scoring/trajectory-scorer.ts` — novo scorer.
- `evals/scoring/trajectory-scorer.test.ts` — nova suíte unitária.
- `evals/src/runner.ts` — composição e apresentação dos resultados.
- `evals/src/runner.integration.test.ts` — integração e regressões.
- `evals/e2e/eval.e2e.test.ts` — exit code e saída CLI.
- `evals/cases/case-001-database-timeout.json` — trajetória completa com baseline/deploy/knowledge.
- `evals/cases/case-002-payment-api-timeout.json` — trajetória sem correlação indevida com deploy.
- `evals/cases/case-003-missing-data.json` — trajetória curta por ausência de dados.
- `apps/cli-agent/src/trace-log.ts` — eventual persistência opcional do resultado.
- `vitest.config.ts` — cobertura global acima de 80%.
