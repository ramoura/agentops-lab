# Especificação técnica — V2.5: Prompt caching no loop agêntico

> Complementa a `techspec-v2.md`. Cobre exclusivamente a evolução V2.5 do roadmap (`docs/roadmap.md`, seção "V2.5 — Prompt caching no loop agêntico"): habilitar o prompt caching da Messages API nos requests do motor LLM, com medição de custo por investigação — sem nenhuma mudança em server, tools, providers, datasets, scorer ou casos de eval.

## Resumo executivo

O loop agêntico da V2 reenvia o prompt quase completo a cada rodada: numa investigação típica (5 rodadas, ~57k tokens de entrada), system prompt, definições de tools e histórico crescente são reprocessados a preço cheio em toda chamada. A V2.5 adiciona **dois breakpoints de cache por request** (`cache_control: {type: "ephemeral"}`, TTL default de 5 minutos): um **estável** no último bloco do system (que, pela ordem de renderização `tools → system → messages`, cacheia tools + system juntos) e um **móvel** no último bloco da última mensagem do histórico (o padrão multi-turn — cada rodada lê o prefixo escrito pela anterior e estende o cache). Expectativa: redução de ~70–80% no custo de entrada por investigação (leitura de cache a 0,1× do preço base; escrita a 1,25×).

As mudanças são localizadas no `packages/llm-engine` (porta `ChatRequest`/`ChatUsage`, adapter e assistant) mais a exposição das métricas nos dois consumidores: a linha de tokens da CLI ganha o detalhe de cache e o eval passa a reportar cache lido/escrito por caso em stderr. O caching fica **ligado por default** com opt-out por env (`AGENTOPS_LLM_CACHE=off`) — útil para medir o antes/depois com o mesmo binário. Toda a lógica é validada com o `FakeAnthropicChat` (posição dos breakpoints, agregação de usage) sem gastar tokens; a verificação com API real fica no smoke opt-in existente (`eval:llm`).

## Arquitetura do sistema

### Visão dos componentes

Não há componentes novos — apenas modificações no motor LLM e nos consumidores das métricas:

- **`packages/llm-engine/src/anthropic-chat.ts`** (modificado): a porta ganha vocabulário de cache — `system` passa de `string` para blocos de texto com `cache_control` opcional; blocos de conteúdo de mensagem aceitam `cache_control`; `ChatUsage` ganha `cache_creation_input_tokens`/`cache_read_input_tokens`. O adapter mapeia tudo passthrough para o SDK e normaliza campos de cache ausentes na resposta para `0`.
- **`packages/llm-engine/src/llm-investigation-assistant.ts`** (modificado): posiciona os dois breakpoints a cada request (estável no system, móvel no fim do histórico), garantindo que markers de rodadas anteriores não se acumulem (teto de 4 da API). Agrega os campos de cache no `LlmUsage`.
- **`packages/llm-engine/src/engine-config.ts`** (modificado): `LlmEngineConfig` ganha `cacheEnabled`, resolvido de `AGENTOPS_LLM_CACHE` (default `true`; `off|false|0` desligam; valor inválido → erro orientativo `invalid_config`).
- **`apps/cli-agent/src/main.ts`** (modificado): linha de custo em stderr passa a detalhar o cache — `Tokens: 57.3k entrada (48.2k cache) · 5.1k saída · 5 rodada(s)`.
- **`evals/src/runner.ts`** (modificado): no modo llm, após cada caso, reporta em stderr o agregado de cache do caso (via `lastUsage` do assistant concreto, quando disponível).
- **`packages/llm-engine/src/__fixtures__/testing.ts`** (modificado): helpers do `FakeAnthropicChat` para respostas com campos de cache.

**Intocados** (garantia de escopo): `mcp-servers/agentops-server/**`, `packages/{core,providers,types}`, `prompt-builder.ts` (o marker vai no *bloco*, não no texto do system — o prompt em si não muda um byte), `tool-mapping.ts`, scorers, casos de eval, datasets.

Fluxo de dados (uma investigação, cache habilitado):

```
rodada 1: tools + system[Ⓒ estável] + user(pergunta)[Ⓒ móvel]
  → API escreve cache até os 2 breakpoints (write 1,25×)
rodada 2: mesmo prefixo + assistant(tool_use) + user(tool_results)[Ⓒ móvel]
  → API lê o prefixo da rodada 1 do cache (read 0,1×) e escreve a extensão
rodada N: idem — cada rodada lê tudo até o breakpoint móvel anterior
  → usage por rodada: cache_read cresce, input_tokens fica pequeno
investigação seguinte (eval): tools+system idênticos → lê o breakpoint estável
```

## Design de implementação

### Principais interfaces

Extensões na porta (o loop e os testes enxergam só isto; nomes de campos espelham o wire format da API):

```typescript
/** Bloco de system com breakpoint opcional (system: string → SystemBlock[]). */
export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** Blocos de conteúdo (user e assistant) aceitam o marker no último bloco. */
export type UserContentBlock = { /* variantes existentes */ } & {
  cache_control?: { type: 'ephemeral' };
};

/** Uso de tokens por rodada, agora com os campos de cache (ausente → 0). */
export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}
```

Agregado por investigação e config:

```typescript
export interface LlmUsage {
  inputTokens: number;        // tokens não cacheados (após o último breakpoint)
  outputTokens: number;
  cacheReadTokens: number;    // somatório das rodadas
  cacheCreationTokens: number;
  rounds: number;
}

export interface LlmEngineConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
  maxRounds: number;
  cacheEnabled: boolean;      // AGENTOPS_LLM_CACHE (default true)
}
```

### Modelos de dados

Contratos estendidos da V2.5. Campos de cache ausentes na resposta da API são **normalizados para `0`** no adapter — nunca `undefined` silencioso; a entrada total de uma rodada é sempre `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.

#### `ChatUsage` — uso de tokens de uma rodada (campo `usage` da resposta)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `input_tokens` | `number` | sim | Tokens processados a preço cheio — apenas o que vem **depois** do último breakpoint. |
| `output_tokens` | `number` | sim | Tokens de saída da rodada. |
| `cache_creation_input_tokens` | `number` | sim | Tokens escritos no cache nesta rodada (cobrados a 1,25×). Ausente no upstream → `0`. |
| `cache_read_input_tokens` | `number` | sim | Tokens lidos do cache nesta rodada (cobrados a 0,1×). Ausente no upstream → `0`. |

```json
{
  "input_tokens": 812,
  "output_tokens": 245,
  "cache_creation_input_tokens": 3480,
  "cache_read_input_tokens": 11260
}
```

> **Variante — cache desligado (`AGENTOPS_LLM_CACHE=off`) ou primeira rodada sem prefixo reutilizável:** os campos de cache vêm `0`; `input_tokens` volta a carregar o prompt inteiro. O consumidor não precisa de caminho especial — a soma dos três campos é invariante.

```json
{
  "input_tokens": 15552,
  "output_tokens": 245,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0
}
```

#### `LlmUsage` — agregado por investigação (linha de custo)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `inputTokens` | `number` | sim | Somatório de `input_tokens` das rodadas (parcela não cacheada). |
| `outputTokens` | `number` | sim | Somatório de saída. |
| `cacheReadTokens` | `number` | sim | Somatório de leituras de cache. |
| `cacheCreationTokens` | `number` | sim | Somatório de escritas de cache. |
| `rounds` | `number` | sim | Rodadas executadas. |

```json
{
  "inputTokens": 3900,
  "outputTokens": 5100,
  "cacheReadTokens": 44200,
  "cacheCreationTokens": 9200,
  "rounds": 5
}
```

#### `LlmEngineConfig.cacheEnabled` — resolução por env

| Valor de `AGENTOPS_LLM_CACHE` | `cacheEnabled` | Comportamento |
| --- | --- | --- |
| ausente / vazio | `true` | Caching ligado (default). |
| `on` / `true` / `1` | `true` | Explícito. |
| `off` / `false` / `0` | `false` | Nenhum `cache_control` em nenhum request. |
| qualquer outro valor | — | `LlmEngineError('invalid_config')` orientativo citando os valores aceitos. |

#### Mapeamento porta → SDK (`messages.create()`)

| Origem (porta) | Destino (SDK Anthropic) |
| --- | --- |
| `system: SystemBlock[]` | `system` (array de blocos de texto; passthrough, incl. `cache_control`) |
| `messages[].content[].cache_control` | idem (passthrough) |
| `response.usage.cache_creation_input_tokens` | `ChatUsage.cache_creation_input_tokens` (`?? 0`) |
| `response.usage.cache_read_input_tokens` | `ChatUsage.cache_read_input_tokens` (`?? 0`) |

#### Parâmetros fixados no upstream (Messages API — regras de cache)

| API | Parâmetros/regras principais |
| --- | --- |
| **Anthropic Messages API** | `cache_control: {type: "ephemeral"}` (TTL 5 min, renovado a cada leitura); máx. **4 breakpoints**/request (a V2.5 usa **2**); mínimo cacheável no `claude-sonnet-5`: **1.024 tokens** (abaixo disso o marker é ignorado sem erro); lookback de **20 blocos** por breakpoint; ordem de renderização `tools → system → messages`; write 1,25× / read 0,1× do preço de entrada |

#### Variáveis de ambiente (novas e existentes)

| Variável | Default | Uso |
| --- | --- | --- |
| `AGENTOPS_LLM_CACHE` | `on` | Opt-out do prompt caching (`off` desliga). Só tem efeito no modo `llm`. |
| demais (`ANTHROPIC_API_KEY`, `AGENTOPS_LLM_*`) | — | Inalteradas (techspec-v2). |

### Endpoints da API

Não há endpoints HTTP — a interface é a CLI (mesmo padrão das techspecs anteriores). A V2.5 **não altera argumentos nem exit codes** de nenhum comando; muda apenas o conteúdo do progresso em stderr do modo llm.

#### Visão geral

| Comando | Mudança na V2.5 |
| --- | --- |
| `npm run investigate -- --engine=llm "<pergunta>"` | Linha de tokens em stderr ganha o detalhe de cache. |
| `npm run eval -- --engine=llm` / `npm run eval:llm` | stderr ganha uma linha de cache por caso. |

---

#### `npm run investigate -- --engine=llm "<pergunta>"`

**Exemplo — stderr ao final (cache ligado, investigação de 5 rodadas)**

```http
npm run investigate -- --engine=llm "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08"
```

```text
Consultando o modelo (rodada 5/16)…
Montando o relatório…
Tokens: 3.9k entrada (44.2k cache lido · 9.2k cache escrito) · 5.1k saída · 5 rodada(s)
```

**Exemplo — cache desligado (`AGENTOPS_LLM_CACHE=off`)**

```text
Tokens: 57.3k entrada · 5.1k saída · 5 rodada(s)
```

> Quando `cacheReadTokens + cacheCreationTokens === 0` (opt-out ou prefixo abaixo do mínimo cacheável), a linha mantém o formato da V2 — sem parêntese de cache. stdout permanece byte-idêntico ao da V2 em todos os cenários.

---

#### `npm run eval -- --engine=llm`

**Exemplo — stderr por caso (progresso; stdout de scores inalterado)**

```text
→ case-001-database-timeout
  Cache: 44.2k lido · 9.2k escrito · 3.9k sem cache
→ case-002-payment-api-timeout
  Cache: 51.0k lido · 4.1k escrito · 3.2k sem cache
```

> O breakdown de critérios e o resumo agregado em stdout não mudam (RF23/RF27 intactos); a linha de cache é progresso, não resultado. No modo `deterministic` nenhuma linha de cache é emitida.

---

## Pontos de integração

- **API Anthropic (Messages API)** — mesma integração da V2; a V2.5 só adiciona `cache_control` nos requests e lê dois campos novos do `usage`. Regras que o design respeita:
  - **Prefixo exato**: qualquer byte alterado antes de um breakpoint invalida o cache dali em diante. O system prompt do lab é determinístico (skill lida do disco, sem timestamps) e as definições de tools vêm do `listTools()` do server, cuja ordem de registro é fixa — pré-condições já satisfeitas; o risco de drift está registrado em Riscos.
  - **Mínimo cacheável (1.024 tokens no `claude-sonnet-5`)**: o breakpoint estável cobre skill + contrato + guardrails + 9 definições de tools (muito acima do mínimo). Abaixo do mínimo o marker é ignorado *silenciosamente* — por isso a métrica em stderr é parte do design, não acessório.
  - **Lookback de 20 blocos**: o breakpoint móvel de cada rodada precisa encontrar o cache da rodada anterior em até 20 blocos. No loop atual, uma rodada adiciona 2 mensagens (assistant com 1–4 blocos; user com 1–4 tool_results) — folga confortável. Rodadas com >20 blocos (cenário da V2.12, paralelismo agressivo) exigiriam breakpoint intermediário.
  - **Falhas**: erro da API segue o fluxo existente (`api_error`); não há modo de falha novo — cache é transparente ao contrato da resposta.
- **Sem integrações novas**: nenhuma dependência adicionada; nenhum contrato de tool alterado.

## Abordagem de testes

Meta: manter a cobertura global > 80% (padrão do projeto: Vitest, testes co-localizados, `FakeAnthropicChat`/`StubToolInvoker` — nenhum teste da suíte default gasta tokens).

### Testes unitários

**`packages/llm-engine` — engine-config (`AGENTOPS_LLM_CACHE`):**

1. Env ausente ou vazia → `cacheEnabled: true` (default ligado).
2. `on`/`true`/`1` → `true`; `off`/`false`/`0` → `false` (case-insensitive).
3. Valor inválido (ex.: `talvez`) → `LlmEngineError('invalid_config')` orientativo citando os valores aceitos e o default.
4. `resolveLlmEngineConfig` continua validando `ANTHROPIC_API_KEY` antes de qualquer coisa (regressão: ordem dos erros preservada).

**`packages/llm-engine` — adapter (`AnthropicChatAdapter`):**

5. `system` como array de blocos é repassado ao SDK sem alteração, incluindo `cache_control` (passthrough).
6. `cache_control` em bloco de mensagem (`tool_result`/`text`) é repassado sem alteração.
7. Resposta com `cache_creation_input_tokens`/`cache_read_input_tokens` → mapeados para `ChatUsage`; resposta **sem** os campos (fake antigo/modelos sem cache) → normalizados para `0`, nunca `undefined`.
8. Regressão: requisição sem nenhum `cache_control` (modo off) é idêntica à da V2 — nenhum campo extra enviado.

**`packages/llm-engine` — loop (`LlmInvestigationAssistant` + `FakeAnthropicChat`):**

9. Cache ligado, rodada 1: exatamente **2** breakpoints — um no último bloco do system, um no último bloco da mensagem `user` inicial (a pergunta).
10. Cache ligado, rodada N (multi-rodada com tool_use): o breakpoint móvel está no **último bloco da última mensagem** (o tool_result mais recente); o breakpoint da rodada anterior foi **removido** — nunca mais de 2 markers por request (teto de 4 da API respeitado com folga).
11. Múltiplos `tool_use` na mesma rodada → o marker móvel vai apenas no último `tool_result` da mensagem `user` seguinte (um marker por request no lado móvel).
12. Cache desligado (`cacheEnabled: false`) → **nenhum** `cache_control` em nenhum request de nenhuma rodada.
13. Agregação: `LlmUsage.cacheReadTokens`/`cacheCreationTokens` somam os campos de todas as rodadas; `inputTokens` soma apenas a parcela não cacheada; `rounds` inalterado (regressão do agregado da V2).
14. O texto do system e o conteúdo das mensagens são byte-idênticos com cache ligado ou desligado — só os markers diferem (garante que ligar/desligar não muda o prompt).
15. Regressão: audit log (`seq`, params, `resultSummary`) é idêntico com cache ligado/desligado — cache não toca a auditoria.
16. Erro da API com cache ligado → `LlmEngineError('api_error')` com o mesmo envelope da V2 (nenhum modo de falha novo).

**`apps/cli-agent` — linha de custo:**

17. `LlmUsage` com cache > 0 → linha `Tokens: 3.9k entrada (44.2k cache lido · 9.2k cache escrito) · 5.1k saída · 5 rodada(s)`.
18. `LlmUsage` com cache == 0 → formato da V2 preservado (`Tokens: 57.3k entrada · 5.1k saída · 5 rodada(s)`), sem parêntese vazio.
19. `formatTokenCount` reutilizado para os campos de cache (mesma formatação `12.4k`).

**`evals/src` — runner:**

20. Modo llm com assistant expondo `lastUsage` com cache → linha `Cache: … lido · … escrito · … sem cache` em stderr (err), por caso; stdout (scores/resumo) byte-idêntico ao da V2.
21. Modo `deterministic` → nenhuma linha de cache (o assistant não expõe usage).
22. Assistant llm injetado (fake, sem `lastUsage`) → runner não quebra; linha de cache simplesmente omitida.

### Testes de integração

- **Loop com MCP real e modelo fake** (extensão do `llm-investigation.integration.test.ts`): `FakeAnthropicChat` roteirizado com 2 rodadas + `McpToolInvoker` real → requests carregam os 2 breakpoints nas posições corretas com as definições reais das 9 tools; audit e outcome idênticos aos da V2 (regressão).
- **Eval runner com engine fake**: `runEvals({ engine: 'llm', assistant: fake })` → nenhuma linha de cache (fake não expõe usage) e resultados inalterados — prova que a instrumentação é opcional e não intrusiva.

### Testes E2E

- **Regressão do default**: suíte E2E existente (investigate e eval sem flag, sem envs novas) permanece verde — o modo deterministic não passa perto do código de cache.
- **CLI, modo llm sem key**: inalterado (validação de key vem antes de qualquer request; regressão).
- **Smoke opt-in com LLM real** (`npm run eval:llm`, case-001 — único ponto que gasta tokens): asserção **leniente** de cache — em investigação com 2+ rodadas, `cacheReadTokens > 0` no agregado (a partir da rodada 2 o prefixo da rodada 1 deve ser lido). Asserção de valores exatos é proibida (variam por execução). Skipped sem `ANTHROPIC_API_KEY`, como hoje.

> Não há frontend — Playwright não se aplica (mesma justificativa das techspecs anteriores).

## Sequenciamento do desenvolvimento

### Ordem de construção

1. **`engine-config.ts`**: `cacheEnabled` + validação de `AGENTOPS_LLM_CACHE` (testes 1–4). Primeiro porque é isolado e destrava o resto.
2. **Porta + adapter (`anthropic-chat.ts`)**: `SystemBlock[]`, `cache_control` nos blocos, `ChatUsage` estendida, normalização `?? 0` (testes 5–8). O `FakeAnthropicChat` ganha os helpers de usage com cache aqui.
3. **Loop (`llm-investigation-assistant.ts`)**: posicionamento dos 2 breakpoints por request + agregação no `LlmUsage` (testes 9–16). É o núcleo; validado inteiramente com fakes.
4. **Exposição (CLI + eval)**: linha de tokens com cache e linha por caso no runner (testes 17–22) + integração.
5. **Validação real**: smoke `eval:llm` com a asserção leniente + uma rodada manual de `investigate --engine=llm` comparando custo com `AGENTOPS_LLM_CACHE=off` (o experimento que motiva a V2.5 — registrar os números no README/roadmap).

### Dependências técnicas

- Nenhuma dependência nova: `@anthropic-ai/sdk` já suporta `cache_control` e os campos de usage (recurso GA da Messages API, sem beta header).
- `ANTHROPIC_API_KEY` apenas para o passo 5 (validação real), como hoje.

## Monitoramento e observabilidade

Mesma filosofia da V2 (lab local, saída textual):

- **Linha de custo (stderr, CLI)**: `Tokens: <input> entrada (<read> cache lido · <write> cache escrito) · <output> saída · <N> rodada(s)` — o instrumento primário do experimento. Sem cache efetivo, degrada para o formato da V2.
- **Eval (stderr)**: `Cache: <read> lido · <write> escrito · <input> sem cache` por caso no modo llm — permite observar o hit do breakpoint estável entre casos (case-002 lendo o prefixo escrito pelo case-001).
- **Diagnóstico de cache frio**: `cache lido == 0` em execução multi-rodada é o sinal de invalidação silenciosa (prefixo mudou ou abaixo do mínimo) — documentado no README como primeiro passo de troubleshooting.
- **Segredos**: inalterado — `ANTHROPIC_API_KEY` jamais aparece em progresso, audit, relatório ou erros.

## Considerações técnicas

### Principais decisões

- **TTL de 5 minutos** (default da API): uma investigação dura minutos e o eval roda os casos em sequência — o cache nunca expira no meio do uso. Write a 1,25× com break-even já na 2ª rodada. Alternativa descartada: TTL de 1h (write 2×) — só compensaria com gaps longos entre execuções, que não é o padrão de uso do lab.
- **Opt-out por env (`AGENTOPS_LLM_CACHE=off`), ligado por default** (escolha do usuário): cache não muda o comportamento do modelo, só o custo — mas o opt-out barato permite medir o antes/depois com o mesmo binário, que é o experimento da V2.5. O knob vive no `engine-config` com a mesma validação orientativa das demais envs.
- **Dois breakpoints (estável + móvel), de 4 possíveis**: o estável captura o prefixo fixo (tools + system — compartilhado inclusive entre investigações); o móvel captura o histórico crescente (onde está o grosso do custo nas rodadas tardias). Alternativa descartada: só o estável — simples, mas deixa na mesa o ganho dominante; usar 3–4 breakpoints — desnecessário com o lookback de 20 blocos folgado no perfil atual do loop.
- **Marker no bloco, prompt intocado**: `cache_control` é metadado do bloco; o texto do system e das mensagens permanece byte-idêntico com cache ligado ou desligado (teste 14). Isso mantém o `prompt-builder` fora do escopo e garante que o experimento compara custo, não comportamento.
- **Métricas como parte do design, não acessório**: mínimo cacheável e invalidação são *silenciosos* na API — sem `cache_read_input_tokens` visível, "cache ligado" é indistinguível de "cache quebrado". Por isso a instrumentação (CLI + eval) entra junto com o mecanismo, e o smoke real ganha a asserção leniente `cacheReadTokens > 0`.

### Riscos conhecidos

- **Invalidação silenciosa por drift do prefixo**: se a ordem das definições retornadas pelo `listTools()` variar entre execuções (mudança no server/SDK MCP), o cache morre sem erro. Mitigação: a ordem de registro no server é fixa hoje; o teste de integração fixa as posições; a métrica em stderr acusa (`cache lido: 0`). Ordenação defensiva por nome foi considerada e descartada — mudaria o prompt da V2 (invalida a comparação) e mascara o drift em vez de acusá-lo.
- **Lookback de 20 blocos vs. rodadas grandes**: o perfil atual (2–8 blocos/rodada) tem folga, mas a V2.12 (tool calls paralelos) pode inflar as mensagens de tool_results. Mitigação: registrado como interação conhecida entre as duas specs; se necessário, breakpoint intermediário a cada ~15 blocos.
- **Prefixo abaixo do mínimo cacheável**: se a skill encolher drasticamente (V2.11 testa variantes "de-prescritas"), o breakpoint estável pode cair abaixo de 1.024 tokens e ser ignorado. Mitigação: a métrica acusa; o mínimo do `claude-sonnet-5` está documentado nesta spec.
- **Asserção de cache no smoke pode flakear**: comportamento de cache é do lado do servidor (TTL, eviction). Mitigação: asserção leniente (`> 0` apenas quando há 2+ rodadas), nunca valores exatos; smoke continua opt-in e fora da CI.
- **Investigação de rodada única paga o write sem read**: pergunta que o modelo responde sem tools (ou clarification em markdown) escreve cache que ninguém lê (+25% sobre o prefixo, centavos). Aceito: o caso dominante é multi-rodada; o opt-out cobre quem quiser evitar.

### Conformidade com skills

Skills em `.claude/skills/` aplicáveis a esta especificação:

- **`desenvolver-mcp-tools`**: respeitada por construção — nenhuma tool, schema ou contrato MCP muda; o cache é transparente à camada de tools ("a investigação passa pelas tools, não pelo prompt" segue valendo: cache não adiciona dados ao prompt, só reusa o que já ia).
- **`criar-techspec`**: esta especificação segue o template e o fluxo da skill.
- **`criar-tasks` / `executar-task`**: próximos passos naturais para decompor e implementar esta spec.

> `.claude/rules/` não existe no repositório (verificado; mesma constatação das techspecs anteriores). As convenções vigentes vêm de `AGENTS.md` e das skills acima.

### Arquivos relevantes e dependentes

**Modificados:**

- `packages/llm-engine/src/engine-config.ts` (+ `.test.ts`) — `cacheEnabled` / `AGENTOPS_LLM_CACHE`.
- `packages/llm-engine/src/anthropic-chat.ts` (+ `.test.ts`) — `SystemBlock[]`, `cache_control` nos blocos, `ChatUsage` com campos de cache, normalização `?? 0`.
- `packages/llm-engine/src/llm-investigation-assistant.ts` (+ `.test.ts`) — posicionamento dos breakpoints, agregação no `LlmUsage`.
- `packages/llm-engine/src/__fixtures__/testing.ts` — helpers de resposta com usage de cache.
- `apps/cli-agent/src/main.ts` (+ `main.test.ts`) — linha de custo com cache.
- `evals/src/runner.ts` (+ `runner.integration.test.ts`) — linha de cache por caso em stderr.
- `apps/cli-agent/src/llm-investigation.integration.test.ts`, `evals/e2e/eval.e2e.test.ts` — asserções novas (breakpoints; smoke leniente).
- `README.md`, `docs/{roadmap,decisions}.md` — envs, números medidos do experimento e decisão registrada.

**Dependentes (não modificados — garantia de escopo):** `mcp-servers/agentops-server/**`, `packages/core/**`, `packages/providers/**`, `packages/types/**`, `packages/llm-engine/src/{prompt-builder,tool-mapping}.ts`, `apps/cli-agent/src/{renderer,mcp-tool-invoker}.ts`, `evals/scoring/**`, `evals/cases/*.json`, `datasets/**`, `knowledge-base/**`, `skills/**`.
