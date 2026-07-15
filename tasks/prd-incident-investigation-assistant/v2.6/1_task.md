# Tarefa 1.0: Implementar contratos e scorer determinístico de trajetória

## Visão geral

Entregar a linguagem declarativa de expectativas de trajetória e um scorer puro sobre `ToolCallRecord[]`. A entrega inclui schemas e validações semânticas, matching recursivo por subconjunto, ocorrências, precedência parcial por `seq`, canonicalização de chamadas, detecção de duplicatas, teto de chamadas, métricas e agregação do score informativo. Não altera o runner, os casos reais, o gate de outcome, os motores ou as tools MCP.

Referência: `../techspec-v2.6.md`, seções “Design de implementação”, “Modelos de dados”, “Mapeamento auditoria → contrato de trajetória” e testes 1–58.

<skills>
### Conformidade com skills

- `executar-task`: usar para conduzir a implementação desta tarefa e suas validações.
- `desenvolver-mcp-tools`: não se aplica; nenhuma tool, provider ou servidor MCP será criado ou modificado.
</skills>

<requirements>
- Atender RF7 e RF23–RF27 sem modificar o scoring de outcome existente.
- `EvalCase.expected_trajectory` deve ser opcional e casos legados devem continuar válidos sem normalização artificial.
- Os contratos devem representar expectativas, critérios, métricas e resultado de trajetória conforme a TechSpec, com validações estruturais e semânticas orientativas.
- O scorer deve ser local, puro, determinístico e operar exclusivamente sobre `ExpectedTrajectory` e `ToolCallRecord[]`.
- Matching de expectativas deve usar subconjunto recursivo sem coerção; duplicatas devem usar igualdade canônica integral de tool e params.
- Restrições de ordem devem usar `seq` e expressar apenas precedências parciais, sem impor uma sequência completa.
- `durationMs` e falhas devem alimentar apenas métricas; duração nunca deve afetar score ou `passed`.
- Breakdown deve manter ordem estável: chamadas obrigatórias, precedências, duplicatas e teto de chamadas.
- Não adicionar dependências nem usar `any` ou casts para contornar contratos.
</requirements>

## Subtarefas

- [ ] 1.1 Adicionar os schemas e tipos de expectativa e resultado de trajetória em `packages/types`, incluindo defaults, limites e validações semânticas.
- [ ] 1.2 Implementar matching recursivo por subconjunto e canonicalização determinística de parâmetros no novo scorer.
- [ ] 1.3 Implementar critérios de ocorrência, precedência parcial, duplicatas e teto de chamadas.
- [ ] 1.4 Implementar métricas, breakdown, arredondamento e resultado agregado do scorer.
- [ ] 1.5 Cobrir integralmente os casos unitários 1–58 e a integração entre schemas exportados e scorer.

## Detalhes de implementação

Consultar `../techspec-v2.6.md`:

- “Principais interfaces” para `TrajectoryScorer`.
- “Modelos de dados” para `ExpectedTrajectory`, `RequiredToolCallExpectation`, `ToolOrderConstraint`, `TrajectoryCriterionResult`, `TrajectoryMetrics` e `TrajectoryEvalResult`.
- “InvalidTrajectoryExpectation” para validações via schema.
- “Principais decisões”, itens 4–8, para as regras de matching, duração e precedência.

## Critérios de sucesso

- Todos os contratos compilam e preservam a leitura de casos sem `expected_trajectory`.
- Entradas semanticamente incoerentes falham no carregamento com diagnóstico acionável.
- O scorer produz resultados idênticos para as mesmas expectativas e auditoria, independentemente de ordem de chaves ou variação de duração.
- Score permanece entre 0 e 1, arredondado em duas casas, com crédito parcial por critério.
- `trajectory-scorer.ts` alcança cobertura superior a 90% de linhas e branches; cobertura global permanece acima de 80%.
- Nenhum comportamento do outcome scorer, motor, MCP ou CLI é alterado nesta tarefa.

## Testes da tarefa

Test cases da seção “Abordagem de testes” da TechSpec v2.6.

### Testes unitários

**Schemas e validações:**

- [ ] (1) Caso sem `expected_trajectory` permanece válido e sem bloco artificial.
- [ ] (2) Bloco vazio aplica os defaults especificados.
- [ ] (3) As nove `ToolName` são aceitas e nome desconhecido é rejeitado.
- [ ] (4) IDs vazios e duplicados são rejeitados.
- [ ] (5) `params` ausente normaliza para `{}`.
- [ ] (6) `min_occurrences` usa default 1, aceita 0 e rejeita negativo/fracionário.
- [ ] (7) `max_occurrences` aceita 0 e rejeita valor inválido ou menor que o mínimo.
- [ ] (8) `max_calls` aceita inteiros não negativos e rejeita demais formatos.
- [ ] (9) Restrições com referências válidas são aceitas.
- [ ] (10) Referência inexistente e autorreferência são rejeitadas.
- [ ] (11) Campos desconhecidos seguem uma política consistente, documentada e testada.
- [ ] (12) `TrajectoryEvalResult` aceita scores 0 e 1 e rejeita valores fora do intervalo.
- [ ] (13) `TrajectoryMetrics` rejeita contagens e duração negativas.

**Matching de parâmetros:**

- [ ] (14) Padrão vazio casa qualquer chamada da tool correta.
- [ ] (15) Subconjunto simples permite parâmetros adicionais no registro.
- [ ] (16) Chave esperada ausente não casa.
- [ ] (17) Primitivos e `null` divergentes não casam.
- [ ] (18) Objetos aninhados usam subconjunto recursivo.
- [ ] (19) Arrays exigem mesma ordem, tamanho e valores.
- [ ] (20) Ordem das propriedades do objeto não interfere.
- [ ] (21) Não ocorre coerção de tipos nem de datas textualmente diferentes.
- [ ] (22) Chave programática com `undefined` não equivale a chave ausente.

**Chamadas obrigatórias e ocorrências:**

- [ ] (23) Uma chamada compatível satisfaz o mínimo default.
- [ ] (24) Tool correta com params incompatíveis falha com contagem zero.
- [ ] (25) Params compatíveis em outra tool não casam.
- [ ] (26) Mínimo 2 passa com duas ocorrências e falha com uma.
- [ ] (27) Máximo 1 falha com duas ocorrências compatíveis.
- [ ] (28) Intervalo de uma a duas ocorrências aceita ambos os limites.
- [ ] (29) Intervalo zero a zero representa chamada proibida.
- [ ] (30) Expectativas distintas podem casar chamadas diferentes da mesma tool.
- [ ] (31) Breakdown preserva a ordem declarada das expectativas.
- [ ] (32) Detalhes listam `seq` compatíveis em ordem crescente.

**Precedência parcial:**

- [ ] (33) Passa quando existe `before.seq < after.seq`.
- [ ] (34) Falha quando todas as ocorrências de `before` são posteriores.
- [ ] (35) Múltiplas ocorrências passam quando ao menos um par satisfaz a relação.
- [ ] (36) Lado ausente falha na chamada obrigatória e na ordem com explicação.
- [ ] (37) Tools intermediárias são permitidas.
- [ ] (38) A avaliação usa `seq`, não a posição no array.
- [ ] (39) Registros fisicamente desordenados são avaliados por `seq`.

**Duplicatas e canonicalização:**

- [ ] (40) Tool e params iguais constituem duplicata.
- [ ] (41) Ordem diferente de chaves não evita duplicata.
- [ ] (42) A regra vale também para objetos aninhados.
- [ ] (43) Arrays em ordem diferente não são duplicatas.
- [ ] (44) Tools diferentes com mesmos params não são duplicatas.
- [ ] (45) Três chamadas iguais produzem duas ocorrências excedentes.
- [ ] (46) Proibição ativa gera um único critério agregado com diagnóstico.
- [ ] (47) Proibição desativada omite o critério, preservando a métrica.
- [ ] (48) `durationMs`, `seq` e `resultSummary` não alteram a assinatura.

**Teto, métricas e agregação:**

- [ ] (49) `max_calls` passa no limite e falha acima dele.
- [ ] (50) Teto zero passa com audit vazio e falha com uma chamada.
- [ ] (51) Ausência de teto não cria critério.
- [ ] (52) `total_calls` inclui todos os registros, inclusive falhas.
- [ ] (53) `failed_calls` reconhece apenas o prefixo estrutural `ERRO:`.
- [ ] (54) Durações decimais são somadas sem afetar aprovação.
- [ ] (55) Audit vazio produz score zero ou fração coerente com os critérios.
- [ ] (56) Ausência de critérios pontuáveis retorna score 1 sem divisão por zero.
- [ ] (57) Score concede crédito parcial e arredonda em duas casas.
- [ ] (58) Variar somente duração não altera critérios nem score.

### Testes de integração

- [ ] Validar que uma expectativa carregada pelos schemas públicos pode ser consumida diretamente pelo scorer e produz um `TrajectoryEvalResult` aceito pelo schema, sem casts ou adaptações paralelas.
- [ ] Executar as suítes de contratos e scorer em conjunto para detectar divergência entre defaults/validações e o comportamento de pontuação.

### Testes E2E (se aplicável)

- Não se aplica nesta tarefa isolada; a execução CLI e os processos MCP pertencem à tarefa 2.0.

## Arquivos relevantes

- `packages/types/src/eval.ts` — schemas e tipos de expectativa/resultado (modificar).
- `packages/types/src/schemas.test.ts` — testes dos contratos (modificar).
- `evals/scoring/trajectory-scorer.ts` — scorer puro (criar).
- `evals/scoring/trajectory-scorer.test.ts` — testes do scorer (criar).
- `packages/types/src/audit.ts` — contrato `ToolCallRecord` consumido (referência; evitar mudança salvo necessidade demonstrada).
- `vitest.config.ts` — metas de cobertura (validar; modificar somente se estritamente necessário).
