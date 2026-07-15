# Tarefa 2.0: Integrar trajectory eval ao Eval Harness e documentar a entrega

## Visão geral

Integrar o scorer da tarefa 1.0 ao fluxo real do Eval Harness. A entrega adiciona expectativas conservadoras aos três casos, compõe outcome e trajetória no runner, usa o audit canônico de ambos os motores, apresenta breakdown e métricas explicitamente informativos, preserva gate e exit code existentes, comprova compatibilidade com casos/traces legados e documenta configuração, operação e decisões.

Referência: `../techspec-v2.6.md`, seções “Arquitetura do sistema”, “EvalRunCaseResult”, “Endpoints da API”, “Pontos de integração”, “Monitoramento e observabilidade” e testes 59–84.

<skills>
### Conformidade com skills

- `executar-task`: usar para conduzir a implementação, validação e atualização documental desta tarefa.
- `desenvolver-mcp-tools`: não se aplica; os MCP servers e contratos das nove tools permanecem inalterados e são apenas exercitados pelos E2E existentes.
</skills>

<requirements>
- Atender RF7 e RF23–RF27, mantendo outcome como único gate de aprovação e exit code.
- Executar trajectory scoring somente quando `expected_trajectory` estiver presente; casos legados devem retornar `trajectory: null` e não imprimir aviso ou score artificial.
- Usar exclusivamente o `ToolCallRecord[]` contido no `InvestigationOutcome` de cada motor, sem captura paralela e sem consultar `lastTrace`.
- Os três casos reais devem declarar expectativas parciais e conservadoras adequadas ao cenário, sem impor sequência total.
- O case-001 deve cobrir evidências operacionais, baseline, deploy e knowledge base; o case-002 deve consultar deploy sem forçar correlação; o case-003 deve permitir encerramento antecipado por falta de dados.
- Stdout deve separar claramente outcome e `Trajetória — INFORMATIVO`, incluindo breakdown, métricas e média apenas dos casos configurados.
- Trajectory abaixo de 1 nunca deve alterar score/passed do outcome, contagem agregada, engine ou exit code; falha interna/configuração continua sendo erro de execução.
- Persistência do resultado de trajetória é opcional; se adotada, deve ser retrocompatível e não recalcular traces antigos.
- Nenhuma API LLM real deve ser chamada pela suíte default e nenhuma dependência deve ser adicionada.
</requirements>

## Subtarefas

- [x] 2.1 Declarar `expected_trajectory` conservadora nos três casos reais e validar seu carregamento antes de qualquer conexão MCP.
- [x] 2.2 Integrar o scorer ao runner por meio de `EvalRunCaseResult`, extraindo audit do outcome de forma independente do motor.
- [x] 2.3 Renderizar breakdown, métricas e média de trajetória como informação separada, preservando gate, resumo de outcome e exit code.
- [x] 2.4 Cobrir integração determinística, LLM fake, casos legados, traces e regressões dos contratos existentes.
- [x] 2.5 Atualizar README, roadmap e decisões com configuração, interpretação e natureza informativa da V2.6.
- [x] 2.6 Executar testes 59–84, typecheck e cobertura; confirmar outcomes reais em 100% e cobertura global acima de 80%.

## Detalhes de implementação

Consultar `../techspec-v2.6.md`:

- “Fluxo de dados” e “Principais interfaces” para composição do resultado e extração do audit.
- “EvalRunCaseResult” para o contrato canônico do runner.
- “CLI npm run eval” para saída, gate e exit codes.
- “Pontos de integração” para audit, trace JSONL e erros do scorer.
- “Sequenciamento do desenvolvimento”, passos 3–7, e “Monitoramento e observabilidade”.

## Critérios de sucesso

- `npm run eval` executa os três casos com outcomes em 100%, exit `0` e trajectory score informativo visível.
- Ambos os motores usam o mesmo contrato de auditoria e o LLM fake demonstra trajetórias eficientes e regressões sem API key.
- Trajetória reprovada com outcome aprovado mantém exit `0`; outcome reprovado mantém exit `1` mesmo com trajetória aprovada.
- Casos sem expectativa e traces existentes continuam legíveis sem migração obrigatória.
- Erros semânticos nos casos são detectados antes do spawn MCP.
- README explica como interpretar e configurar a trajetória; roadmap e decisões registram a entrega e seu caráter não bloqueante.
- `npm test`, `npm run typecheck` e `npm run test:coverage` passam; cobertura global permanece acima de 80%.

## Testes da tarefa

Test cases da seção “Abordagem de testes” da TechSpec v2.6.

### Testes unitários

- [ ] Validar isoladamente a extração de audit para outcomes `report`, `markdown` e sem relatório, apoiando os casos 68 e 76.
- [ ] Validar isoladamente a composição do resumo: média apenas de trajetórias configuradas e invariância dos agregados de outcome, apoiando os casos 72–75.
- [ ] Validar isoladamente a formatação do bloco informativo e sua ausência em caso legado, apoiando os casos 69 e 71.

### Testes de integração

- [ ] (59) `loadCases()` carrega os três casos com expectativa em ordem alfabética.
- [ ] (60) Motor determinístico produz audit e trajectory score esperado em todos os casos.
- [ ] (61) Case-001 valida erros, exceptions, logs, latência, baseline, deploy e knowledge base sem sequência total.
- [ ] (62) Case-002 coleta deploy para concluir ausência, sem exigir regressão.
- [ ] (63) Case-003 exige somente observabilidade necessária e permite encerramento antes da knowledge base.
- [ ] (64) Fake LLM eficiente obtém trajectory score 1 sem API key.
- [ ] (65) Fake LLM redundante preserva outcome 1 e reprova parcialmente a trajetória.
- [ ] (66) Fake LLM sem baseline preserva outcome e falha somente no critério relacionado.
- [ ] (67) Knowledge base consultada cedo falha apenas na precedência configurada.
- [ ] (68) Assistant sem audit gera breakdown informativo reprovado sem quebrar outcome.
- [ ] (69) Caso legado não imprime trajetória e retorna `trajectory: null`.
- [ ] (70) Expectativa semanticamente inválida falha antes de `McpToolInvoker.connect()`.
- [ ] (71) Stdout diferencia explicitamente outcome e trajetória informativa.
- [ ] (72) Resumo calcula média somente entre casos com expectativa.
- [ ] (73) Ausência de casos configurados remove a parcela de média da trajetória.
- [ ] (74) Trajectory abaixo de 1 não altera agregados de outcome nem engine.
- [ ] (75) Falha de outcome continua reprovando mesmo com trajetória aprovada.
- [ ] (76) Ambos os motores usam exatamente o audit do respectivo outcome.
- [ ] (77) Trace opt-in e schema antigo permanecem válidos sem resultado de trajetória.
- [ ] (78) Se persistido opcionalmente, round-trip preserva o resultado e traces antigos.

### Testes E2E (se aplicável)

- [ ] (79) `npm run eval` executa os três casos, mantém exit `0`, outcomes em 100% e exibe trajetória.
- [ ] (80) Saída contém critério obrigatório, duplicata e métricas agregadas.
- [ ] (81) Fixture com trajetória reprovada e outcome aprovado termina com exit `0`.
- [ ] (82) Fixture com outcome reprovado e trajetória aprovada termina com exit `1`.
- [ ] (83) `npm run eval:llm` permanece opt-in, fora da CI/default, e aceita o mesmo contrato.
- [ ] (84) `npm test`, `npm run typecheck` e `npm run test:coverage` passam, com cobertura global acima de 80%.

## Arquivos relevantes

- `evals/cases/case-001-database-timeout.json` — expectativa completa e conservadora (modificar).
- `evals/cases/case-002-payment-api-timeout.json` — expectativa sem correlação indevida de deploy (modificar).
- `evals/cases/case-003-missing-data.json` — expectativa curta para dados ausentes (modificar).
- `evals/src/runner.ts` — composição, scoring e apresentação (modificar).
- `evals/src/runner.integration.test.ts` — integração e regressões (modificar).
- `evals/e2e/eval.e2e.test.ts` — gate, exit code e stdout (modificar).
- `packages/types/src/trace.ts` e `apps/cli-agent/src/trace-log.ts` — compatibilidade de trace (validar; modificar somente se a persistência opcional for adotada).
- `README.md` — uso, leitura dos scores e configuração de casos (modificar).
- `docs/roadmap.md` — status da V2.6 (modificar).
- `docs/decisions.md` — decisão arquitetural sobre score informativo e restrições parciais (modificar).
- `evals/scoring/scorer.ts` e `evals/scoring/text-scorer.ts` — outcome scorers preservados (referência; não modificar).
