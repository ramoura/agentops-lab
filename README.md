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

A v1 usa **dados simulados** e um **engine determinístico** (sem LLM em runtime): roda 100% offline, sem API key, com saída reproduzível — pré-requisito do eval determinístico. A arquitetura está preparada para evoluir para um motor LLM (V2) e integrações reais de observabilidade (V3) — ver [`docs/roadmap.md`](./docs/roadmap.md).

## Requisitos

- Node.js ≥ 20 (sem nenhuma infraestrutura externa: sem cloud, sem banco, sem API key)

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

## Rodar os evals

```bash
npm run eval
```

Executa os 3 casos de `evals/cases/` pelo **mesmo caminho da CLI** (client MCP real → engine → renderer) e pontua cada relatório com um scorer 100% determinístico (matching de termos case/acento-insensível + critérios estruturais — sem LLM):

- presença de cada `expected_finding` e ausência de cada termo de `must_not_include`;
- `cita_evidencias` — toda evidência com source;
- `separa_fato_de_hipotese` — seções distintas e não vazias (ou ausência declarada);
- `proximos_passos_seguros` — lista não vazia, 1º passo nunca destrutivo.

A saída traz o breakdown de critérios por caso (o que passou e o que falhou) e o resumo agregado. O eval é o monitor de regressão do projeto: mudanças em engine/datasets/skill devem manter o `case-001` em 100%. Exit code ≠ 0 quando algum caso reprova.

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
2. Para o engine determinístico da v1, espelhe o processo em um pipeline no `packages/core` (como `DeterministicInvestigationEngine` espelha os 11 passos de `investigate-incident`). Na V2 (motor LLM), a skill passa a ser carregada como contexto.

### Adicionar um caso de eval

1. Crie `evals/cases/case-00X-<nome>.json` com `id`, `question`, `expected_findings` e `must_not_include` (use termos técnicos estáveis: nomes de exception, endpoints, "p99", "deploy").
2. Se o caso usa um cenário novo, adicione o dataset correspondente antes.
3. Rode `npm run eval` — o runner descobre os casos automaticamente; opcionalmente registre um golden em `evals/expected-answers/`.

## Documentação

- [`docs/architecture.md`](./docs/architecture.md) — componentes, fluxo de dados e contratos
- [`docs/roadmap.md`](./docs/roadmap.md) — evolução V2–V5 e migração do SDK MCP
- [`docs/decisions.md`](./docs/decisions.md) — decisões arquiteturais registradas
- [`AGENTS.md`](./AGENTS.md) — regras do repositório · [`prompt.md`](./prompt.md) — especificação canônica
