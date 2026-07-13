# Tarefa 1.0: Fundações do cache — config (`AGENTOPS_LLM_CACHE`) + porta/adapter

## Visão geral

Prepara o vocabulário de cache no motor LLM sem tocar no loop: o `LlmEngineConfig` ganha `cacheEnabled` resolvido da env `AGENTOPS_LLM_CACHE` (default ligado, opt-out por `off|false|0`, valor inválido → erro orientativo); a porta `AnthropicChat` ganha `SystemBlock[]` (system passa de `string` para blocos com `cache_control` opcional), `cache_control` nos blocos de conteúdo de mensagem e `ChatUsage` estendida com `cache_creation_input_tokens`/`cache_read_input_tokens`; o adapter mapeia tudo passthrough para o SDK e normaliza campos de cache ausentes na resposta para `0` (nunca `undefined`). O `FakeAnthropicChat` ganha helpers para respostas com usage de cache — pré-requisito dos testes da tarefa 2.0.

Referência: `../techspec-v2.5.md` — seções "Principais interfaces", "Modelos de dados" (`ChatUsage`, `LlmEngineConfig.cacheEnabled`, "Mapeamento porta → SDK") e "Sequenciamento › passos 1–2".

<skills>
### Conformidade com skills

- `executar-task`: usar para conduzir a implementação desta tarefa.
- `desenvolver-mcp-tools`: respeitada por construção — nenhuma tool, schema ou contrato MCP muda; a porta/adapter é a camada de chat, não a de tools.
</skills>

<requirements>
- `AGENTOPS_LLM_CACHE` ausente/vazia → `cacheEnabled: true`; `on|true|1` → `true`; `off|false|0` → `false` (case-insensitive); qualquer outro valor → `LlmEngineError('invalid_config')` citando os valores aceitos e o default.
- `resolveLlmEngineConfig` mantém a ordem de validação existente: `ANTHROPIC_API_KEY` é validada antes de qualquer coisa (regressão).
- Nomes dos campos da porta espelham o wire format da Messages API (`cache_control`, `cache_creation_input_tokens`, `cache_read_input_tokens`).
- Adapter: passthrough de `system: SystemBlock[]` e de `cache_control` nos blocos de mensagem; normalização `?? 0` dos campos de cache da resposta; entrada total de uma rodada é sempre `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
- Requisição sem nenhum `cache_control` (modo off) é idêntica à da V2 — nenhum campo extra enviado (regressão).
- Componentes intocados: `mcp-servers/agentops-server/**`, `packages/{core,providers,types}`, `prompt-builder.ts`, `tool-mapping.ts`, scorers, casos de eval, datasets.
</requirements>

## Subtarefas

- [x] 1.1 Adicionar `cacheEnabled` ao `LlmEngineConfig` em `packages/llm-engine/src/engine-config.ts`, com resolução e validação de `AGENTOPS_LLM_CACHE` no padrão orientativo das demais envs.
- [x] 1.2 Estender a porta em `packages/llm-engine/src/anthropic-chat.ts`: `SystemBlock[]`, `cache_control` opcional nos blocos de conteúdo, `ChatUsage` com os 2 campos de cache.
- [x] 1.3 Atualizar o `AnthropicChatAdapter`: passthrough de system/blocos para o SDK e normalização `?? 0` dos campos de cache do `usage` da resposta.
- [x] 1.4 Adicionar helpers de resposta com usage de cache ao `FakeAnthropicChat` em `packages/llm-engine/src/__fixtures__/testing.ts`.
- [x] 1.5 Escrever os testes da tarefa (cases 1–8) e garantir suíte verde (`npm test`, `npm run typecheck`) com cobertura > 80%.

## Detalhes de implementação

Ver `../techspec-v2.5.md`:

- "Design de implementação › Principais interfaces" (`SystemBlock`, `UserContentBlock`, `ChatUsage`, `LlmEngineConfig`).
- "Modelos de dados › `LlmEngineConfig.cacheEnabled`" (tabela de resolução da env).
- "Modelos de dados › Mapeamento porta → SDK" (passthrough e normalização).
- "Dependências técnicas": nenhuma dependência nova — `@anthropic-ai/sdk` já suporta `cache_control` (GA, sem beta header).

## Critérios de sucesso

- Config resolve a env conforme a tabela da techspec, com erro orientativo para valor inválido.
- Porta e adapter compilam com o loop existente sem mudança de comportamento quando nenhum `cache_control` é usado (request idêntico ao da V2).
- Campos de cache da resposta nunca chegam `undefined` ao consumidor.
- `FakeAnthropicChat` pronto para roteirizar respostas com usage de cache (destrava a tarefa 2.0).
- Cobertura global mantida > 80%.

## Testes da tarefa

Test cases da techspec (numeração da seção "Abordagem de testes"):

### Testes unitários

**engine-config (`AGENTOPS_LLM_CACHE`):**

- [x] (1) Env ausente ou vazia → `cacheEnabled: true` (default ligado).
- [x] (2) `on`/`true`/`1` → `true`; `off`/`false`/`0` → `false` (case-insensitive).
- [x] (3) Valor inválido (ex.: `talvez`) → `LlmEngineError('invalid_config')` orientativo citando os valores aceitos e o default.
- [x] (4) `resolveLlmEngineConfig` continua validando `ANTHROPIC_API_KEY` antes de qualquer coisa (regressão: ordem dos erros preservada).

**adapter (`AnthropicChatAdapter`):**

- [x] (5) `system` como array de blocos é repassado ao SDK sem alteração, incluindo `cache_control` (passthrough).
- [x] (6) `cache_control` em bloco de mensagem (`tool_result`/`text`) é repassado sem alteração.
- [x] (7) Resposta com `cache_creation_input_tokens`/`cache_read_input_tokens` → mapeados para `ChatUsage`; resposta **sem** os campos → normalizados para `0`, nunca `undefined`.
- [x] (8) Regressão: requisição sem nenhum `cache_control` (modo off) é idêntica à da V2 — nenhum campo extra enviado.

### Testes de integração

- Não se aplica nesta tarefa (porta/adapter e config são validados unitariamente; a integração com MCP real entra na tarefa 2.0).

### Testes E2E (se aplicável)

- [x] Regressão: suíte E2E existente permanece verde sem modificação (o modo deterministic não passa perto do código de cache).

## Arquivos relevantes

- `packages/llm-engine/src/engine-config.ts` (+ `.test.ts`) — `cacheEnabled` / `AGENTOPS_LLM_CACHE` (modificar).
- `packages/llm-engine/src/anthropic-chat.ts` (+ `.test.ts`) — porta e adapter (modificar).
- `packages/llm-engine/src/__fixtures__/testing.ts` — helpers do `FakeAnthropicChat` (modificar).
