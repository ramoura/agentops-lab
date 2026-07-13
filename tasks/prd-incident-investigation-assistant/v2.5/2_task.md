# Tarefa 2.0: Loop agêntico — posicionamento dos 2 breakpoints e agregação de cache no `LlmUsage`

## Visão geral

O núcleo da V2.5: o `LlmInvestigationAssistant` passa a posicionar, a cada request (quando `cacheEnabled`), exatamente **2 breakpoints** de cache — o **estável** no último bloco do system (cacheia tools + system pela ordem de renderização `tools → system → messages`) e o **móvel** no último bloco da última mensagem do histórico (padrão multi-turn: cada rodada lê o prefixo da anterior e estende o cache). Markers de rodadas anteriores são removidos — nunca mais de 2 por request (teto de 4 da API com folga). O agregado `LlmUsage` ganha `cacheReadTokens`/`cacheCreationTokens` somando as rodadas. Tudo validado com `FakeAnthropicChat` — nenhum teste gasta tokens.

Referência: `../techspec-v2.5.md` — seções "Arquitetura › fluxo de dados", "Modelos de dados › `LlmUsage`", "Pontos de integração" (prefixo exato, mínimo cacheável, lookback de 20 blocos) e "Sequenciamento › passo 3".

<skills>
### Conformidade com skills

- `desenvolver-mcp-tools`: respeitada por construção — o cache é transparente à camada de tools ("a investigação passa pelas tools, não pelo prompt": cache não adiciona dados ao prompt, só reusa o que já ia); nenhum contrato de tool muda.
- `executar-task`: usar para conduzir a implementação desta tarefa.
</skills>

<requirements>
- Cache ligado: 2 breakpoints por request — estável no último bloco do system, móvel no último bloco da última mensagem do histórico; markers de rodadas anteriores removidos.
- Múltiplos `tool_use` na mesma rodada → um único marker móvel, no último `tool_result` da mensagem `user` seguinte.
- Cache desligado (`cacheEnabled: false`) → nenhum `cache_control` em nenhum request de nenhuma rodada.
- Marker no *bloco*, prompt intocado: texto do system e conteúdo das mensagens byte-idênticos com cache ligado ou desligado (`prompt-builder.ts` fora do escopo).
- `LlmUsage` agrega: `cacheReadTokens`/`cacheCreationTokens` somam todas as rodadas; `inputTokens` soma apenas a parcela não cacheada; `rounds` inalterado.
- Audit log (`seq`, params, `resultSummary`) idêntico com cache ligado/desligado; erro da API mantém o envelope `api_error` da V2 (nenhum modo de falha novo).
- Componentes intocados: `prompt-builder.ts`, `tool-mapping.ts`, `mcp-servers/agentops-server/**`, `packages/{core,providers,types}`.
</requirements>

## Subtarefas

- [x] 2.1 Implementar o posicionamento dos breakpoints em `packages/llm-engine/src/llm-investigation-assistant.ts`: estável no system (uma vez por request) e móvel no fim do histórico, com remoção do marker móvel da rodada anterior.
- [x] 2.2 Respeitar `cacheEnabled: false` — caminho sem nenhum `cache_control` (requests idênticos aos da V2).
- [x] 2.3 Estender o `LlmUsage` com `cacheReadTokens`/`cacheCreationTokens` e agregar os campos de `ChatUsage` de todas as rodadas.
- [x] 2.4 Escrever os testes unitários da tarefa (cases 9–16) com `FakeAnthropicChat`.
- [x] 2.5 Estender `apps/cli-agent/src/llm-investigation.integration.test.ts` (MCP real + modelo fake) com as asserções de breakpoints e regressão de audit/outcome; suíte verde com cobertura > 80%.

## Detalhes de implementação

Ver `../techspec-v2.5.md`:

- "Arquitetura do sistema › fluxo de dados" (diagrama rodada a rodada com os 2 breakpoints).
- "Modelos de dados › `LlmUsage`" (campos e semântica do agregado).
- "Pontos de integração" (regras da API que o posicionamento respeita: prefixo exato, mínimo de 1.024 tokens, lookback de 20 blocos, máx. 4 breakpoints).
- "Considerações técnicas › Dois breakpoints (estável + móvel)" e "› Marker no bloco, prompt intocado" (decisões e alternativas descartadas).

## Critérios de sucesso

- Em investigação multi-rodada com cache ligado, todo request carrega exatamente 2 markers nas posições especificadas; com cache desligado, nenhum.
- Ligar/desligar cache não muda um byte do prompt, do audit log nem do outcome — só os markers e o usage diferem.
- `LlmUsage` reflete a soma invariante: entrada total da investigação = `inputTokens + cacheCreationTokens + cacheReadTokens`.
- Cobertura global mantida > 80%; nenhum teste da suíte default gasta tokens.

## Testes da tarefa

Test cases da techspec (numeração da seção "Abordagem de testes"):

### Testes unitários

**loop (`LlmInvestigationAssistant` + `FakeAnthropicChat`):**

- [x] (9) Cache ligado, rodada 1: exatamente **2** breakpoints — um no último bloco do system, um no último bloco da mensagem `user` inicial (a pergunta).
- [x] (10) Cache ligado, rodada N (multi-rodada com tool_use): o breakpoint móvel está no **último bloco da última mensagem** (o tool_result mais recente); o breakpoint da rodada anterior foi **removido** — nunca mais de 2 markers por request.
- [x] (11) Múltiplos `tool_use` na mesma rodada → o marker móvel vai apenas no último `tool_result` da mensagem `user` seguinte (um marker por request no lado móvel).
- [x] (12) Cache desligado (`cacheEnabled: false`) → **nenhum** `cache_control` em nenhum request de nenhuma rodada.
- [x] (13) Agregação: `LlmUsage.cacheReadTokens`/`cacheCreationTokens` somam os campos de todas as rodadas; `inputTokens` soma apenas a parcela não cacheada; `rounds` inalterado (regressão do agregado da V2).
- [x] (14) O texto do system e o conteúdo das mensagens são byte-idênticos com cache ligado ou desligado — só os markers diferem.
- [x] (15) Regressão: audit log (`seq`, params, `resultSummary`) é idêntico com cache ligado/desligado — cache não toca a auditoria.
- [x] (16) Erro da API com cache ligado → `LlmEngineError('api_error')` com o mesmo envelope da V2 (nenhum modo de falha novo).

### Testes de integração

- [x] Loop com MCP real e modelo fake (extensão do `llm-investigation.integration.test.ts`): `FakeAnthropicChat` roteirizado com 2 rodadas + `McpToolInvoker` real → requests carregam os 2 breakpoints nas posições corretas com as definições reais das 9 tools; audit e outcome idênticos aos da V2 (regressão).

### Testes E2E (se aplicável)

- [x] Regressão: suíte E2E existente permanece verde sem modificação.

## Arquivos relevantes

- `packages/llm-engine/src/llm-investigation-assistant.ts` (+ `.test.ts`) — breakpoints e agregação (modificar).
- `packages/llm-engine/src/__fixtures__/testing.ts` — helpers de usage com cache da tarefa 1.0 (consumir).
- `apps/cli-agent/src/llm-investigation.integration.test.ts` — asserções de breakpoints com MCP real (modificar).
