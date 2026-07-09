# Tarefa 5.0: CLI `npm run investigate`: MCP client, renderer e fluxos de erro (`@agentops/cli-agent`)

## Visão geral

Integrar tudo na interface única do produto: a CLI recebe a pergunta via `npm run investigate -- "<pergunta>"`, spawna o `agentops-server` via `StdioClientTransport` (com `tsx`, sem build), adapta `Client.callTool()` para `ToolInvoker` (`McpToolInvoker`), executa o engine e renderiza relatório + registro de auditoria em texto puro PT-BR (cores ANSI só como reforço). Inclui os testes de integração engine+server reais e os E2E da CLI como processo real.

<skills>
### Conformidade com skills

- `desenvolver-mcp-tools` — o client é o único ponto de contato com o SDK MCP no lado consumidor (`McpToolInvoker` isolado para facilitar migração v2 do SDK).
</skills>

<requirements>
- Pergunta em linguagem natural como argumento (RF1); sem argumento → mensagem de uso e exit code 1.
- Pergunta ambígua → mensagem orientativa com os campos faltantes, sem chamar tool e sem stack trace (RF3, US10).
- Relatório nas 7 seções do RF4, seguido do registro de auditoria (tools, parâmetros, ordem) (RF7).
- Progresso por etapa em stderr; relatório final em stdout (permite `> relatorio.txt` limpo).
- Acessibilidade: informação independente de cor; `NO_COLOR`/não-TTY desativa ANSI; saída legível redirecionada para arquivo.
- Erro de spawn/protocolo MCP → mensagem orientativa, nunca stack trace cru.
</requirements>

## Subtarefas

- [x] 5.1 `mcp-tool-invoker.ts`: `StdioClientTransport` spawnando o server via `tsx`; adaptação `callTool` → `ToolInvoker`; tratamento de erro de spawn/protocolo.
- [x] 5.2 `renderer.ts`: 7 seções com títulos em português na ordem do RF4 + seção "Tools chamadas"; detecção de TTY/`NO_COLOR`.
- [x] 5.3 `main.ts`: parse de argv, fluxo pergunta → parser → engine → renderer; mensagens de uso e de orientação; progresso em stderr.
- [x] 5.4 Script raiz `investigate` apontando para a CLI.
- [x] 5.5 Testes unitários do renderer, integração engine+server reais e E2E da CLI (processo real via `execa`).

## Detalhes de implementação

Ver techspec: seção do `@agentops/cli-agent` em "Visão dos componentes", **"Fluxo de dados (investigação)"**, **"Pontos de integração"** (CLI ↔ server) e **"Monitoramento e observabilidade"** (stderr vs stdout).

## Critérios de sucesso

- `npm run investigate -- "<pergunta case-001>"` produz relatório completo, legível em uma tela de terminal, com auditoria ao final e exit code 0.
- Perguntas ambíguas e cenários sem dados produzem orientação/declaração explícita, nunca invenção nem stack trace (US9/US10).
- Saída redirecionada para arquivo permanece completa e sem códigos ANSI.

## Testes da tarefa

Casos da techspec: **48–51**, **67–69**, **71–74** e **76**.

### Testes unitários — ReportRenderer

- [x] 48. Renderiza as 7 seções com títulos em português na ordem do RF4 + seção de auditoria ao final.
- [x] 49. Com `NO_COLOR=1` (ou stdout não-TTY) a saída não contém sequências ANSI; conteúdo idêntico ao colorido.
- [x] 50. Relatório de pergunta ambígua: mensagem orientativa citando exatamente os campos faltantes, sem stack trace.
- [x] 51. Saída redirecionada para arquivo permanece completa e legível (sem controle de cursor).

### Testes de integração — engine + server reais

- [x] 67. Case-001: investigação completa → hipótese de regressão de deploy, confiança `alta`, ≥4 evidências citadas, auditoria com ≥8 chamadas na ordem da skill.
- [x] 68. Case-002 (payment-api) → hipótese de dependência externa, sem menção a deploy inexistente.
- [x] 69. Case-003 (serviço sem dados) → relatório declara dados ausentes, confiança `baixa`, zero findings inventados.

### Testes E2E (CLI como processo real)

- [x] 71. `npm run investigate -- "<pergunta case-001>"` → exit code 0; stdout com as 7 seções do RF4 na ordem + seção "Tools chamadas" (RF1/RF7).
- [x] 72. `npm run investigate -- "por que deu erro?"` → exit code 0; orientação listando serviço e janela faltantes; nenhuma tool chamada (US10).
- [x] 73. `npm run investigate` sem argumento → mensagem de uso e exit code 1.
- [x] 74. `npm run investigate -- "<pergunta case-003>"` → "Dados faltantes" preenchido e confiança `baixa` (US9).
- [x] 76. Saída redirecionada (`> relatorio.txt`) → arquivo completo, sem códigos ANSI.

## Arquivos relevantes

- `apps/cli-agent/src/main.ts`, `mcp-tool-invoker.ts`, `renderer.ts`
- `apps/cli-agent/src/renderer.test.ts`, testes de integração e suite `e2e`
- `package.json` raiz (script `investigate`)
