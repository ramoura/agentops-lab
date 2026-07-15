# Tarefa 3.0: Entregar o runner red-team opt-in e validar a V2.7 end-to-end

## Visão geral

Integrar contratos, fixtures e scorer em um runner exclusivamente LLM, opt-in e isolado, acionado por `npm run eval:redteam -- --engine=llm`. A entrega cobre preflight, composition root com raízes explícitas, execução pelo MCP stdio real, relatório seguro, regressões das suítes normais, smoke real controlado e documentação do baseline sem alegar garantia de segurança.

<skills>
### Conformidade com skills

- `criar-tasks` — usada para consolidar integração, CLI, E2E, smoke e documentação em uma única entrega final verificável.
- `desenvolver-mcp-tools` — avaliada e não aplicada: o runner reutiliza as nove tools read-only e o MCP server existentes sem modificar seus contratos ou comportamento.
</skills>

<requirements>

- Disponibilizar somente o engine LLM e falhar antes do spawn em engine inválido, credencial ausente, fixture ausente ou raiz normal.
- Executar apenas `case-004` usando as raízes red-team e MCP stdio real; nunca ler as fixtures diretamente no runner.
- Preservar o prompt, as definições de tools, `tool_choice`, loop LLM e serialização da V2/V2.5.
- Exibir outcome e segurança separadamente, critérios por vetor, estrutura, primeiro passo, tools/trajectory, modelo, timestamp, rodadas, tokens e cache.
- Não imprimir API key ou payload adversarial integral; trace permanece opt-in com aviso explícito.
- Manter `npm run eval`, `npm run eval:llm` e `npm test` isolados, sem rede, credencial ou descoberta do caso red-team.
- Realizar smoke real manual e registrar somente metadados e resultado agregado em `docs/decisions.md`.
</requirements>

## Subtarefas

- [x] 3.1 Criar o composition root red-team com resolução e validação explícitas das raízes adversariais.
- [x] 3.2 Implementar preflight tipado para engine, credencial, caso e fixtures antes de spawnar o MCP server.
- [x] 3.3 Implementar o runner que usa MCP real, LLM engine existente e o mesmo markdown nos scorers de outcome e segurança.
- [x] 3.4 Implementar saída, stderr, exit codes e aviso de trace conforme o contrato observável da TechSpec.
- [x] 3.5 Adicionar `npm run eval:redteam` e os testes de integração/E2E sem rede.
- [x] 3.6 Executar validação regressiva: typecheck, testes, cobertura, eval padrão 3/3 e verificação de isolamento.
- [ ] 3.7 Executar smoke manual com API real e registrar modelo, data, resultado agregado, rodadas e tokens, sem persistir a resposta completa. _(PENDENTE: requer `ANTHROPIC_API_KEY` — o harness/CLI/E2E estão prontos; `docs/decisions.md` D12 tem o slot "Baseline observado" para preencher ao rodar.)_
- [x] 3.8 Atualizar README, roadmap e decisão D12 com comando, custo, interpretação, limites e baseline observado.

## Detalhes de implementação

Seguir `techspec-v2.7.md`, especialmente “Fluxo de dados”, “Pontos de integração”, “Sequenciamento do desenvolvimento”, “Monitoramento e observabilidade” e decisões 8–10. A entrega mede o guardrail atual; não deve introduzir hardening, provider real, nova API HTTP ou biblioteca adicional.

## Critérios de sucesso

- O comando opt-in executa somente `case-004` pelo MCP real e retorna código 0 apenas quando outcome e segurança passam.
- As três fontes adversariais chegam inalteradas ao contexto e cada vetor só pode passar se sua tool-fonte tiver sido exercitada.
- Saída contém todos os metadados obrigatórios sem credencial nem payload integral.
- Suítes normais permanecem isoladas: eval padrão 3/3, eval LLM normal sem red-team e testes default sem rede/API key.
- Cobertura global permanece acima de 80% em linhas e branches.
- Documentação descreve o resultado como evidência de uma execução específica, nunca como resistência garantida.

## Testes da tarefa

### Testes unitários

- [x] Reexecutar U01–U43 em conjunto e validar os thresholds de cobertura definidos na TechSpec.

### Testes de integração

- [x] I01. Composition root resolve somente `datasets-redteam/` e `knowledge-base-redteam/`.
- [x] I02. Raiz resolvida igual à normal falha antes do spawn do MCP server.
- [x] I03. Caso normal no runner red-team falha com `REDTEAM_CASE_INVALID`.
- [x] I04. Engine `deterministic` falha com `REDTEAM_ENGINE_UNSUPPORTED`.
- [x] I05. Roteiro LLM fake chama logs, top exceptions e runbook e é aprovado.
- [x] I06. Fake que obedece ao log malicioso falha no vetor direto.
- [x] I07. Fake que repete a exception adversarial falha no vetor estruturado.
- [x] I08. Fake que omite evidências falha no vetor de runbook e no contrato estrutural.
- [x] I09. Falha de tool é auditada e não é confundida com resistência.
- [x] I10. As três fontes aparecem em `tool_result`, provando que o ataque foi exercitado.
- [x] I11. `TextReportScorer` e `RedTeamScorer` recebem exatamente o mesmo markdown.
- [x] I12. Resultado imprime modelo, scores, critérios, rodadas e tokens.
- [x] I13. Saída não imprime API key nem payload adversarial integral.
- [x] I14. Exit code é 0 somente com outcome e segurança aprovados; 1 nas falhas.
- [x] I15. `npm run eval` continua carregando exatamente os casos 001–003.
- [x] I16. `npm run eval:llm` continua ignorando `cases-redteam`.
- [x] I17. Trace opt-in preserva auditoria e exibe aviso sobre conteúdo adversarial.
- [x] I18. Cache ligado ou desligado não altera critérios nem markdown pontuado.
- [x] I19. Execuções consecutivas não reutilizam caches de provider entre raízes.
- [x] I20. O caso roda pelo MCP real, sem acesso direto aos arquivos pelo runner.

### Testes E2E (se aplicável)

- [x] E01. `eval:redteam` com engine determinístico encerra com orientação e sem rede.
- [x] E02. Execução sem `ANTHROPIC_API_KEY` falha antes do spawn do server.
- [x] E03. `npm run eval` permanece 3/3 e não menciona `case-004`.
- [x] E04. `npm test` não faz request externo nem exige API key.
- [x] E05. Fixture ausente produz erro tipado, sem stack trace cru na CLI.
- [ ] E06. Smoke real executa apenas `case-004` e registra resultado agregado, modelo, data, rodadas e tokens. _(teste escrito e skip-guarded; execução real PENDENTE de `ANTHROPIC_API_KEY`)_
- [x] E07. Documentar repetição manual mínima de três execuções como observação, não como taxa ou gate.

## Arquivos relevantes

- `evals/src/redteam-runner.ts`
- `evals/src/redteam-runner.integration.test.ts`
- `evals/e2e/redteam.e2e.test.ts`
- `apps/cli-agent/src/mcp-tool-invoker.ts`
- `mcp-servers/agentops-server/src/server-factory.ts`
- `package.json`
- `vitest.config.ts`
- `README.md`
- `docs/roadmap.md`
- `docs/decisions.md`
