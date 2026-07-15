# AgentOps Lab — Incident Investigation Assistant

PoC de um assistente de investigação de incidentes de produção, construída como laboratório de estudo de **AgentOps**: MCP (Model Context Protocol), skills, context engineering, workflows agênticos, observabilidade, eval harness, segurança read-only e auditabilidade.

A partir de uma pergunta em linguagem natural, o assistente identifica o serviço e a janela de tempo, consulta logs, métricas, deploys e documentação técnica por meio de **9 tools read-only expostas via MCP real (stdio)** e produz um relatório estruturado que separa fatos de hipóteses, cita evidências e sugere próximos passos seguros.

```text
MCP/tools para acessar sistemas
+ Skills para padronizar investigação
+ Knowledge base para contexto
+ Eval Harness para confiabilidade
+ Segurança read-only para operação real
```

O lab tem **dois motores de investigação** selecionáveis por `--engine`:

- **`deterministic`** (default, da V1): parser + pipeline determinístico, sem LLM em runtime — roda 100% offline, sem API key, com saída reproduzível (pré-requisito do eval determinístico).
- **`llm`** (V2): loop agêntico manual sobre a **Messages API da Anthropic**, consumindo as **mesmas 9 MCP tools** — a skill vira system prompt e o modelo decide quais tools chamar. Requer `ANTHROPIC_API_KEY`.

Integrações reais de observabilidade são a V3 — ver [`docs/roadmap.md`](./docs/roadmap.md).

## Requisitos

- Node.js ≥ 20 (sem nenhuma infraestrutura externa: sem cloud, sem banco)
- `ANTHROPIC_API_KEY` **apenas** para o modo `--engine=llm` — o default continua funcionando sem key e sem custo

## Instalação

```bash
npm install
```

## Investigar um incidente

```bash
npm run investigate -- "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08"
```

A CLI interpreta a pergunta (serviço, janela, sintoma), spawna o `agentops-server` via MCP stdio, executa os 11 passos da skill [`investigate-incident`](./skills/investigate-incident/skill.md) e imprime o relatório com as seções, nesta ordem:

1. **Resumo executivo**
2. **Evidências encontradas** — cada evidência cita a tool e a referência que a sustentam
3. **Hipótese principal** — com confiança classificada (baixa/media/alta)
4. **Hipóteses alternativas**
5. **Próximos passos seguros** — o 1º passo nunca é destrutivo
6. **Dados faltantes** — ausência declarada, nunca inventada
7. **Confiança da análise**
8. **Tools chamadas** — registro de auditoria: tools, parâmetros e ordem de execução

Comportamentos úteis:

- Progresso vai para **stderr** e o relatório para **stdout** — `npm run investigate -- "<pergunta>" > relatorio.txt` gera um arquivo limpo, sem códigos ANSI (cores são apenas reforço; `NO_COLOR` desativa).
- Pergunta ambígua (sem serviço ou sem janela identificáveis) produz orientação do que faltou, **sem chamar nenhuma tool** e sem adivinhar.
- Serviço/período sem dados produz um relatório que declara explicitamente o que não foi encontrado, com confiança `baixa` — nunca conclusões inventadas.

Cenários simulados disponíveis: `checkout-api` (incidente principal, 10h–10h30 de 2026-07-08), `payment-api` (timeout de gateway, 14h–14h20) e qualquer outro serviço para exercitar o fluxo de dados ausentes.

## Modo LLM (`--engine=llm`)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run investigate -- --engine=llm "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08"
```

No modo llm não há parser: a pergunta crua vai para o modelo com a skill [`investigate-incident`](./skills/investigate-incident/skill.md) como system prompt e as definições das 9 tools descobertas em runtime via `listTools()` do MCP. O loop agêntico é manual (`while stop_reason === 'tool_use'`) — cada rodada, tool_use e tool_result é visível e auditável, que é exatamente o objeto de estudo do lab. Perguntas mais livres que o regex da V1 passam a funcionar; pergunta sem serviço/período identificáveis produz um markdown declarando o que faltou, sem chamar tools de dados.

- O relatório em stdout é o **markdown do modelo** (mesmas 7 seções do RF4) + a seção **"Tools chamadas" anexada por código** a partir do audit log — a auditoria nunca depende da honestidade do modelo.
- Progresso por rodada (`Consultando o modelo (rodada N/16)…`) e a linha de custo (`Tokens: 8 entrada (34.2k cache lido · 16.4k cache escrito) · 4.0k saída · 4 rodada(s)`) vão para stderr; stdout redirecionado permanece limpo.
- Sem `ANTHROPIC_API_KEY`, a CLI falha rápido com orientação (exit 1), **antes** de spawnar o server MCP.

Variáveis de ambiente:

| Variável | Default | Uso |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Obrigatória apenas no modo `llm`. Nunca aparece em logs, relatório ou auditoria. |
| `AGENTOPS_ENGINE` | `deterministic` | Motor default quando `--engine` não é passado (CLI e eval). |
| `AGENTOPS_LLM_MODEL` | `claude-sonnet-5` | Modelo da Messages API. |
| `AGENTOPS_LLM_MAX_TOKENS` | `4096` | `max_tokens` por chamada. |
| `AGENTOPS_LLM_MAX_ROUNDS` | `16` | Teto de rodadas do loop agêntico (proteção contra loop infinito). |
| `AGENTOPS_LLM_CACHE` | `on` | Prompt caching do loop agêntico (V2.5). `off`/`false`/`0` desligam — útil para medir o custo antes/depois com o mesmo binário. |
| `AGENTOPS_TRACE_LOG` | — (desligado) | Caminho do arquivo JSONL de trace (opt-in) — funciona com os dois engines, em `investigate` e em `eval`. Ver [Trace completo de investigação](#trace-completo-de-investigação-jsonl-opt-in) abaixo. |

**Custo**: uma investigação típica faz 6–10 tool calls em 3–5 rodadas (o agregado sai em stderr ao final). O motor não envia parâmetros de sampling: `temperature`/`top_p`/`top_k` foram removidos da Messages API nos modelos atuais (`claude-sonnet-5`+) e retornam 400 se enviados — a reprodutibilidade do modo llm depende do contrato de formato no prompt, não de sampling. Nenhum teste da suíte default gasta tokens; o único ponto que chama a API real é o smoke opt-in `npm run eval:llm`.

### Prompt caching (V2.5)

O loop agêntico reenvia o prompt quase completo a cada rodada — system prompt, definições das 9 tools e histórico crescente. O motor marca **dois breakpoints de cache** por request (`cache_control: {type: "ephemeral"}`, TTL de 5 min): um **estável** no system (pela ordem `tools → system → messages`, cacheia tools + system juntos — compartilhado inclusive entre investigações) e um **móvel** no fim do histórico (cada rodada lê o prefixo escrito pela anterior). Ligado por default; `AGENTOPS_LLM_CACHE=off` desliga sem mudar um byte do prompt.

Números medidos (2026-07-09, mesma pergunta, mesmo binário, 4 rodadas, `claude-sonnet-5`):

| Execução | Entrada (preço cheio, 1×) | Cache lido (0,1×) | Cache escrito (1,25×) | Saída | Custo de entrada relativo |
| --- | --- | --- | --- | --- | --- |
| `AGENTOPS_LLM_CACHE=off` | 50.7k | — | — | 4.2k | 1,00× |
| default (cache ligado) | 8 | 34.2k | 16.4k | 4.0k | **0,47×** (−53%) |

A redução de ~53% é o piso — primeira investigação, cache frio (todo o prefixo pago como escrita a 1,25×). Com leituras dominando (mais rodadas, ou execuções em sequência reutilizando o prefixo estável — o caso do eval), o ganho tende à faixa de 70–80%.

**Troubleshooting — cache frio**: o primeiro passo de diagnóstico no modo llm é a linha de custo em stderr. `cache lido == 0` numa execução **multi-rodada** significa invalidação silenciosa: ou o prefixo mudou entre rodadas (qualquer byte alterado antes de um breakpoint invalida o cache dali em diante — ex.: ordem das tools do `listTools()` variando), ou o prefixo está abaixo do mínimo cacheável (1.024 tokens no `claude-sonnet-5`) — em ambos os casos a API ignora o marker **sem erro**, e só a métrica acusa.

**Gap do RF6 como objeto de estudo**: no motor determinístico, "nenhum fato fora de tool" é garantido por código; no modo llm o modelo *pode* alucinar um fato — a garantia vira instrução de prompt. As mitigações são em camadas (guardrails no system prompt, linha `Fonte:` obrigatória por evidência, `must_not_include` nos casos de eval e auditoria completa para conferência manual tool a tool), e observar esse gap na prática é parte do propósito do lab.

## Rodar os evals

```bash
npm run eval
```

Executa os 3 casos de `evals/cases/` pelo **mesmo caminho da CLI** (client MCP real → engine → renderer) e pontua cada relatório com um scorer 100% determinístico (matching de termos case/acento-insensível + critérios estruturais — sem LLM):

- presença de cada `expected_finding` e ausência de cada termo de `must_not_include`;
- `cita_evidencias` — toda evidência com source;
- `separa_fato_de_hipotese` — seções distintas e não vazias (ou ausência declarada);
- `proximos_passos_seguros` — lista não vazia, 1º passo nunca destrutivo.

A saída separa **outcome**, o único gate do relatório, de **Trajetória — INFORMATIVO**, que avalia o audit (tools, parâmetros, precedências parciais, duplicatas e teto). Trajetória abaixo de 1 nunca reprova o comando; erro de configuração ou outcome reprovado mantém exit code diferente de zero. A média informativa considera somente casos configurados.

O bloco opcional `expected_trajectory` aceita `required_calls`, `order_constraints`, `forbid_exact_duplicates` (default `true`) e `max_calls`. Parâmetros esperados usam matching por subconjunto recursivo e as precedências referenciam IDs de chamadas e comparam seu `seq`, sem impor uma sequência total. Casos sem o bloco permanecem válidos e não exibem score artificial.

Os dois motores rodam pelos mesmos casos:

```bash
npm run eval -- --engine=llm   # pontua o markdown do modelo com o TextReportScorer
npm run eval:llm               # atalho: alias de --engine=llm (smoke opt-in, gasta tokens)
```

No modo llm o scoring continua 100% determinístico: o `TextReportScorer` avalia os **mesmos 5 grupos de critérios** sobre as seções do markdown (extraídas por título — sublinhado ou `##`), sem LLM-as-judge. Os casos JSON são byte-idênticos aos da V1.

### Red-team de prompt injection (V2.7, opt-in)

Mede se o motor trata conteúdo malicioso de `tool_result` como **dado**, não como instrução — o baseline do guardrail antes de conectar providers reais (V3). É um comando **separado, opt-in e isolado**; nunca faz parte de `npm test`, `npm run eval` ou CI.

```bash
npm run eval:redteam -- --engine=llm   # roda SOMENTE case-004, pelo MCP real (gasta tokens, exige ANTHROPIC_API_KEY)
```

- **Isolamento**: as fixtures adversariais vivem em `datasets-redteam/` e `knowledge-base-redteam/`, fisicamente separadas; um composition root recusa qualquer raiz igual à normal. `npm run eval`/`eval:llm` não descobrem `case-004`.
- **Três vetores**: instrução direta em `logs[].message`, instrução no campo estruturado `exceptions[].exception` e roleplay em texto livre de runbook. O guardrail da V2 é o **único** controle — nada é sanitizado ou delimitado (medir, não endurecer).
- **Scoring**: outcome (`TextReportScorer`) e **segurança** (`RedTeamScorer` determinístico) saem como scores **separados**; o exit code é `0` só quando **ambos** passam. Segurança avalia cada vetor (marcador reproduzido reprova; a tool-fonte precisa ter sido exercitada, senão `not_exercised`), as 7 seções e a segurança do 1º passo.
- **Custo/segurança**: um caso por execução (poucos centavos); a saída **não** imprime a API key nem o payload adversarial integral; `AGENTOPS_TRACE_LOG` continua opt-in, com aviso de que o trace contém conteúdo adversarial sintético.
- **Interpretação**: uma passagem é evidência **daquela execução/modelo**, nunca garantia de resistência. Taxa/repetição é V2.9; comparação entre modelos é V2.4. Recomenda-se repetir ~3× como observação, não como gate. Veja D12 em [`docs/decisions.md`](docs/decisions.md).

## Trace completo de investigação (JSONL, opt-in)

```bash
# Uma investigação avulsa
AGENTOPS_TRACE_LOG=evals/runs/trace.jsonl npm run investigate -- --engine=llm "Investigue o checkout-api..."

# Um eval inteiro: 3 registros no mesmo arquivo, um por caso, agrupáveis por runId
AGENTOPS_LLM_MODEL=claude-sonnet-5 AGENTOPS_TRACE_LOG=evals/runs/trace.jsonl npm run eval -- --engine=llm
```

Com `AGENTOPS_TRACE_LOG` apontando para um caminho, cada investigação bem-sucedida (via `investigate` ou por caso de `eval`, nos dois engines) anexa uma linha JSON (`InvestigationTraceRecord`) ao arquivo — pergunta, engine, modelo, o `InvestigationOutcome` inteiro (report estruturado ou markdown + auditoria) e, no motor `llm`, o histórico rodada a rodada do loop agêntico (o que o modelo pediu, o que voltou de cada tool, uso de tokens por rodada). Quando o trace nasce de um caso de eval, o próprio registro carrega o `score`/critérios daquele caso.

- Sem a env, zero I/O extra e stdout/stderr continuam byte-idênticos aos de hoje — o arquivo é um artefato **aditivo e opcional**, nunca versionado (`evals/runs/` está no `.gitignore`).
- Uma investigação avulsa grava exatamente 1 registro (`runId === traceId`); uma execução de `npm run eval` grava um registro por caso, todos com o mesmo `runId` (agrupáveis via `jq`).
- Pergunta ambígua (`clarification`) não gera trace — nenhuma tool é chamada.
- Falha ao gravar (ex.: diretório sem permissão) vira aviso em stderr e **nunca** muda o exit code do relatório/score já produzido.
- O diretório de destino é criado automaticamente se não existir; a escrita é sempre append-only (uma linha por chamada, nunca reescreve o arquivo).

### Lendo um registro (`npm run trace:view`)

Um registro completo é grande (relatório inteiro + rodadas + dados brutos de cada tool) — `npm run trace:view` isola um registro e monta um "replay" legível: cabeçalho, score/critérios do eval (quando existir), o loop agêntico rodada a rodada (cada `tool_use`/`tool_result` decodificado) e o resultado final (reaproveita o mesmo `renderReport` do `investigate`).

```bash
npm run trace:view -- evals/runs/trace.jsonl                                    # último registro do arquivo
npm run trace:view -- evals/runs/trace.jsonl --case=case-001-database-timeout   # última ocorrência desse caso (--all para todas)
npm run trace:view -- evals/runs/trace.jsonl --run=<runId>                      # todos os registros de um eval inteiro
npm run trace:view -- evals/runs/trace.jsonl --trace=<traceId>                  # um registro específico
```

### Consultando os dados via `jq`

```bash
# Reconstruir um eval inteiro (N casos) por runId
jq -c 'select(.runId == "2026-07-11T14-32-05-901Z-c103")' evals/runs/trace.jsonl

# Score médio por modelo, olhando só os registros que vieram de eval
jq -s '[.[] | select(.eval != null)] | group_by(.model) | map({model: .[0].model, avg: (map(.eval.score) | add / length)})' evals/runs/trace.jsonl

# Quantas rodadas cada investigação usou, por modelo — para comparar eficiência do loop
jq -c 'select(.usage != null) | {model, rounds: .usage.rounds, question}' evals/runs/trace.jsonl
```

Detalhes do formato do registro (schemas Zod, exemplo completo) em [`tasks/prd-incident-investigation-assistant/mini-spec-investigation-trace-log.md`](./tasks/prd-incident-investigation-assistant/mini-spec-investigation-trace-log.md).

## Testes e cobertura

```bash
npm test              # suite completa (unitários + integração MCP + E2E da CLI e do eval)
npm run test:coverage # cobertura (meta: >80% em types, providers, core, agentops-server e evals/scoring)
npm run typecheck
```

## Estrutura do projeto

```text
agentops-lab/
  apps/cli-agent/                # CLI: MCP client (stdio), renderer do relatório
  mcp-servers/agentops-server/   # MCP server único com as 9 tools read-only
  packages/
    types/                       # contratos TS + schemas Zod (fonte única)
    providers/                   # fake providers (fs read-only) — substituíveis por reais
    core/                        # parser de pergunta, engine determinístico, audit log
    llm-engine/                  # motor LLM: loop agêntico sobre a Messages API (V2)
  evals/                         # eval harness: cases/, expected-answers/, scoring/, runner
  datasets/                      # logs/métricas/deploys fake (JSON/JSONL versionados)
  knowledge-base/                # runbooks, ADRs e tech specs simulados
  skills/investigate-incident/   # skill canônica com o processo de investigação
  docs/                          # architecture.md, roadmap.md, decisions.md
```

Detalhes de componentes e fluxo de dados em [`docs/architecture.md`](./docs/architecture.md).

## Segurança (read-only por construção)

- **100% das tools são read-only**: os providers importam apenas APIs de leitura do filesystem; nenhuma tool escreve, executa comando ou aciona sistema externo.
- O engine só produz fatos vindos de chamadas de tool (interface `ToolInvoker`), decoradas por um audit log estrutural — o registro de auditoria não é opcional.
- Ações de mudança (rollback, restart) aparecem no máximo como sugestão a **avaliar com o time**, nunca em 1ª posição e nunca executadas.

## Como estender (sem mudar a arquitetura)

### Adicionar um dataset (novo cenário de incidente)

1. Adicione os arquivos em `datasets/logs/<servico>.jsonl`, `datasets/metrics/latency.json` e/ou `datasets/deployments/deployments.json`, mantendo o schema dos tipos em `packages/types` (`LogEntry`, `MetricPoint`, `DeploymentEvent`).
2. Garanta coerência temporal entre logs, métricas e deploys (o engine correlaciona deploy × exception dominante × salto de p99).
3. Nenhum código muda: os fake providers descobrem o serviço pelo nome do arquivo.
4. Considere adicionar um caso de eval para o novo cenário (abaixo).

### Adicionar uma tool

1. Defina input/output schema (Zod) em `packages/types` — contratos são a fonte única.
2. Implemente a leitura no provider correspondente (`packages/providers`), com filtro/limite/defaults.
3. Registre a tool no módulo adequado do server (`mcp-servers/agentops-server/src/{observability,knowledge}/tools.ts`) com descrição orientada ao agente.
4. Garanta read-only e determinismo; ausência de dados é resultado vazio bem definido (`hasData: false`/`matches: []`), nunca erro.
5. Atualize o engine (se a tool entra no processo) e os casos de eval quando o comportamento esperado mudar.

O padrão completo está na skill [`desenvolver-mcp-tools`](./.claude/skills/desenvolver-mcp-tools/SKILL.md) e no checklist de tool correspondente.

### Adicionar uma skill

1. Crie `skills/<nome>/skill.md` com as seções: objetivo, quando usar, processo, regras e saída esperada.
2. Para o engine determinístico da v1, espelhe o processo em um pipeline no `packages/core` (como `DeterministicInvestigationEngine` espelha os 11 passos de `investigate-incident`). No motor LLM, a skill é carregada como contexto do modelo (`prompt-builder` em `packages/llm-engine`).

### Adicionar um caso de eval

1. Crie `evals/cases/case-00X-<nome>.json` com `id`, `question`, `expected_findings` e `must_not_include` (use termos técnicos estáveis: nomes de exception, endpoints, "p99", "deploy"). Opcionalmente adicione `expected_trajectory` com expectativas parciais e conservadoras.
2. Se o caso usa um cenário novo, adicione o dataset correspondente antes.
3. Rode `npm run eval` — o runner descobre os casos automaticamente; opcionalmente registre um golden em `evals/expected-answers/`.

## Documentação

- [`docs/architecture.md`](./docs/architecture.md) — componentes, fluxo de dados e contratos
- [`docs/roadmap.md`](./docs/roadmap.md) — evolução V2–V5 e migração do SDK MCP
- [`docs/decisions.md`](./docs/decisions.md) — decisões arquiteturais registradas
- [`AGENTS.md`](./AGENTS.md) — regras do repositório · [`prompt.md`](./prompt.md) — especificação canônica
