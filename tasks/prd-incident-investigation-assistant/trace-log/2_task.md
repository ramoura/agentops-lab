# Tarefa 2.0: Integração — `AGENTOPS_TRACE_LOG` no `investigate` e no `eval`, `runId` compartilhado e regressão

## Visão geral

Liga o trace (construído na tarefa 1.0) aos dois entrypoints: `apps/cli-agent/src/main.ts` (uma investigação avulsa = um registro, `runId === traceId`) e `evals/src/runner.ts` (um `runId` por execução de `npm run eval`, um registro por caso, com o `EvalCaseResult` daquele caso embutido). Ativado só por `AGENTOPS_TRACE_LOG` (opt-in); sem a env, comportamento e saída (stdout/stderr) permanecem byte-idênticos aos de hoje — essa regressão é o critério central da tarefa, no mesmo espírito de "sem mudança de comportamento" que guiou a tarefa 1.0 da V2.

Referência: `../mini-spec-investigation-trace-log.md` — seções "Design › Trigger", "Design › Mudanças nos dois entrypoints" e "`.gitignore`".

<skills>
### Conformidade com skills

- `executar-task`: usar para conduzir a implementação desta tarefa.
</skills>

<requirements>
- `AGENTOPS_TRACE_LOG` não definida → nenhum I/O de trace em `investigate` nem em `eval` (default inalterado).
- Falha ao gravar o trace (`appendTraceRecord` rejeita) vira aviso em stderr e **nunca** muda o exit code determinado pelo relatório/scores já produzidos.
- `runId`: gerado uma única vez por execução de `npm run eval` (compartilhado pelos N casos); numa investigação avulsa, `runId === traceId`.
- Pergunta ambígua (`outcome.kind === 'clarification'`) não gera trace (RF3 não chama tool nenhuma; fora de escopo desta passada, conforme não-objetivo da mini-spec).
- `rounds`/`usage` no registro vêm de `lastTrace`/`lastUsage` do assistant concreto quando o motor é `llm`; `null` no motor `deterministic` ou quando o assistant injetado não os expõe (fakes de teste).
</requirements>

## Subtarefas

- [x] 2.1 Adicionar `evals/runs/` ao `.gitignore`.
- [x] 2.2 Ligar `AGENTOPS_TRACE_LOG` em `apps/cli-agent/src/main.ts`: após obter `outcome` (só quando `outcome.kind !== 'clarification'`), montar e gravar o `InvestigationTraceRecord` (`source: 'investigate'`, `caseId: null`, `runId === traceId`); falha de escrita → aviso em stderr, exit code inalterado.
- [x] 2.3 Ligar `AGENTOPS_TRACE_LOG` em `evals/src/runner.ts`: gerar um `runId` no início de `runEvals()`; `RunEvalsOptions` ganha `traceLogPath?: string` (lido de `AGENTOPS_TRACE_LOG` só no bloco `invokedDirectly`, mantendo `runEvals()` puro/testável); dentro do loop, após calcular `result` de cada caso, montar e gravar o trace (`source: 'eval'`, `caseId: evalCase.id`, `eval: result`).
- [x] 2.4 Escrever os testes da tarefa e garantir suíte completa verde (`npm test`, `npm run typecheck`, `npm run eval`).

## Detalhes de implementação

Ver `../mini-spec-investigation-trace-log.md`:

- "Design › Trigger" (semântica da env, exemplos de uso com múltiplos modelos).
- "Design › Mudanças nos dois entrypoints" (onde exatamente plugar em cada arquivo, tratamento de falha).
- "Riscos e cuidados" (limitações conhecidas: investigações que falham não geram trace; dependência de `lastTrace`/`lastUsage` no assistant concreto).

## Critérios de sucesso

- Com `AGENTOPS_TRACE_LOG` definida, `npm run investigate` grava exatamente 1 registro por chamada; `npm run eval` grava exatamente 1 registro por caso (3 no total), todos com o mesmo `runId`.
- Sem `AGENTOPS_TRACE_LOG`, `npm test`, `npm run investigate` e `npm run eval` produzem saída (stdout/stderr, exit code) idêntica à de antes desta tarefa — regressão zero.
- Falha simulada de escrita do trace não altera o exit code nem omite o relatório/score já impresso.
- Cobertura global mantida > 80%.

## Testes da tarefa

### Testes unitários

- [x] Fluxo de `main.ts`: com `AGENTOPS_TRACE_LOG` **ausente**, nenhum arquivo é tocado (spy em `appendTraceRecord` não é chamado).
- [x] `evals/src/runner.ts`: `runEvals({ engine: 'llm', assistant: fake, traceLogPath })` grava 3 registros (um por caso), todos com o mesmo `runId`, cada um com o `caseId` correspondente e `eval` igual ao `EvalCaseResult` daquele caso.
- [x] `evals/src/runner.ts`: sem `traceLogPath` → nenhum arquivo criado (comportamento default inalterado).
- [x] `evals/src/runner.ts` (motor `deterministic`): registro gravado com `rounds: null`, `usage: null`, `model: null`.
- [x] Falha de `appendTraceRecord` (rejeitada) → aviso em stderr; `runEvals()`/`main()` retornam o mesmo resultado/exit code que teriam sem a falha.

### Testes de integração

- [x] `apps/cli-agent` (MCP real via stdio, cobertura equivalente via novo cenário em `cli.e2e.test.ts`): fluxo de `investigate` com `AGENTOPS_TRACE_LOG` apontando para um arquivo temporário → arquivo contém 1 linha, JSON válido via `investigationTraceRecordSchema.safeParse`, `source: 'investigate'`, `caseId: null`.
- [x] `evals/src/runner.integration.test.ts` (motor `deterministic`, server real): `runEvals({ traceLogPath })` sobre os 3 casos reais → arquivo com 3 linhas válidas, mesmo `runId`, `caseId`s batendo com `case-001-database-timeout`/`case-002-payment-api-timeout`/`case-003-missing-data`.

### Testes E2E (se aplicável)

- [x] Regressão: suíte E2E existente (`cli.e2e.test.ts`, `eval.e2e.test.ts`) permanece verde sem modificação, executada sem `AGENTOPS_TRACE_LOG` no ambiente.
- [x] Novo cenário E2E (execa, padrão do `cli.e2e.test.ts`): `AGENTOPS_TRACE_LOG=<tmp>/trace.jsonl npm run --silent investigate -- "<pergunta case-001>"` → exit 0, stdout inalterado, arquivo gerado com 1 registro válido.

## Arquivos relevantes

- `apps/cli-agent/src/main.ts` — wiring do trace no `investigate` via `writeInvestigateTrace` exportado (modificado).
- `apps/cli-agent/src/main.test.ts` — testes unitários de `writeInvestigateTrace` com `./trace-log.js` mockado (modificado).
- `evals/src/runner.ts` — wiring do trace no `eval`, `RunEvalsOptions.traceLogPath`, `runId` único por execução (modificado).
- `evals/src/runner.integration.test.ts` — testes de integração do trace em `eval` (motor `deterministic` real e `llm` com assistant fake), incluindo cenário de falha de escrita (modificado).
- `apps/cli-agent/e2e/cli.e2e.test.ts` — novo cenário E2E com `AGENTOPS_TRACE_LOG` (modificado).
- `.gitignore` — `evals/runs/` (modificado).
- Nota: `apps/cli-agent/src/investigation.integration.test.ts` não foi tocado — esse arquivo testa `DeterministicInvestigationEngine` diretamente, sem passar por `main.ts`; a cobertura de integração real do trace em `investigate` ficou no novo cenário de `cli.e2e.test.ts` (processo real via `execa`, que exercita `main.ts` ponta a ponta).
