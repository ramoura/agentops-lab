# Especificação técnica

> **Feature**: AgentOps Lab — Incident Investigation Assistant (v1)
> **PRD**: [`tasks/prd-incident-investigation-assistant/prd.md`](./prd.md)
> **Fontes canônicas do projeto**: [`prompt.md`](../../prompt.md) (escopo) e [`AGENTS.md`](../../AGENTS.md) (regras do repositório)

## Resumo executivo

A v1 é um monorepo **npm workspaces** (Node.js 20+, TypeScript ESM estrito) com cinco pacotes: `@agentops/types` (contratos + schemas Zod), `@agentops/providers` (leitura dos datasets fake e da knowledge base), `@agentops/agentops-server` (um **único MCP server real via stdio**, usando o SDK oficial `@modelcontextprotocol/sdk` v1.x, expondo as 9 tools read-only), `@agentops/core` (parser de pergunta, investigation engine determinístico, montagem do relatório e audit log) e `@agentops/cli-agent` (CLI que atua como **MCP client** via `StdioClientTransport`). O eval harness vive em `evals/` como sexto workspace (`@agentops/evals`) e reutiliza o mesmo engine e o mesmo client MCP, com scoring 100% determinístico por matching de termos.

As decisões estruturantes: (1) **um server MCP único** na v1 (fallback explícito do RF8, decidido com o usuário), com as tools organizadas internamente em módulos `observability/` e `knowledge/` para que a separação futura em dois servers seja apenas a criação de um segundo entrypoint; (2) o engine **não contém dados** — todo fato do relatório nasce de uma chamada de tool feita através de uma interface `ToolInvoker`, decorada por um `AuditLog` que materializa o registro de auditoria (RF6/RF7); (3) os providers implementam interfaces estáveis (`ObservabilityProvider`, `KnowledgeProvider`) para que a troca por CloudWatch/Splunk/Prometheus na V3 não altere o contrato das tools (RF11); (4) raciocínio determinístico por regras explícitas de correlação (deploy × exception dominante × salto de p99), sem LLM em runtime.

## Arquitetura do sistema

### Visão dos componentes

Todos os componentes abaixo são **novos** (projeto greenfield). Estrutura conforme `AGENTS.md`, com um desvio registrado: `mcp-servers/agentops-server/` substitui os dois servers na v1 (decisão a registrar em `docs/decisions.md`).

```text
agentops-lab/
  package.json                     # raiz: workspaces + scripts `investigate` e `eval`
  tsconfig.base.json
  apps/
    cli-agent/                     # @agentops/cli-agent — CLI + MCP client + renderer
  mcp-servers/
    agentops-server/               # @agentops/agentops-server — MCP server stdio único
  packages/
    types/                         # @agentops/types — contratos TS + schemas Zod
    providers/                     # @agentops/providers — fake providers (fs read-only)
    core/                          # @agentops/core — parser, engine, report, audit
  evals/                           # @agentops/evals — runner + scoring + cases/
    cases/  expected-answers/  scoring/
  datasets/
    logs/  metrics/  deployments/  # dados fake JSON/JSONL versionados
  knowledge-base/
    runbooks/  adrs/  tech-specs/
  skills/
    investigate-incident/skill.md  # skill canônica (artefato de produto)
  docs/
    architecture.md  roadmap.md  decisions.md
```

- **`@agentops/types`** — única fonte dos contratos: tipos de entrada/saída das 9 tools, entidades de dataset (`LogEntry`, `MetricPoint`, `DeploymentEvent`), relatório (`InvestigationReport`), auditoria (`ToolCallRecord`) e eval (`EvalCase`, `EvalCaseResult`). Schemas Zod co-localizados; tipos TS inferidos deles (`z.infer`). Nenhuma dependência interna.
- **`@agentops/providers`** — `FakeObservabilityProvider` (lê `datasets/`) e `FakeKnowledgeProvider` (lê `knowledge-base/`). Implementam as interfaces `ObservabilityProvider`/`KnowledgeProvider` definidas em `types`. Toda agregação (contagens, percentis por bucket, ranking de busca) acontece aqui — a tool não lê arquivo direto (regra da skill `desenvolver-mcp-tools`).
- **`@agentops/agentops-server`** — MCP server stdio único (`McpServer` + `StdioServerTransport` do SDK v1.x). `src/observability/tools.ts` registra as 5 tools de telemetria; `src/knowledge/tools.ts` registra as 4 de documentação; `src/main.ts` compõe os dois módulos em um server. Valida entrada via Zod, delega ao provider, devolve `structuredContent` tipado. **Logs do server vão para stderr** (stdout é o canal do protocolo).
- **`@agentops/core`** — `QuestionParser` (extração determinística de serviço/janela/sintoma em PT-BR), `InvestigationEngine` (pipeline de 11 passos espelhando a skill), regras de hipótese/confiança, `InvestigationReport` e `AuditLog` (decorator de `ToolInvoker` que grava ordem, parâmetros e resumo de cada chamada). Depende só de `types` — não conhece MCP nem filesystem.
- **`@agentops/cli-agent`** — entrypoint `npm run investigate`. Spawna o server via `StdioClientTransport`, adapta `Client.callTool()` para a interface `ToolInvoker` (`McpToolInvoker`), executa o engine e renderiza o relatório + auditoria em texto puro (cores ANSI apenas como reforço; desativadas com `NO_COLOR`/saída não-TTY).
- **`@agentops/evals`** — `npm run eval`: carrega `cases/*.json`, executa cada investigação pelo mesmo caminho da CLI (client MCP real) e pontua com o scorer determinístico, imprimindo critérios por caso.

**Fluxo de dados (investigação):**

```text
pergunta (argv)
  → QuestionParser → InvestigationContext (serviço, janela, sintoma) | faltas → mensagem orientativa
  → InvestigationEngine ── ToolInvoker (AuditLog → McpToolInvoker → MCP stdio → agentops-server)
        ├─ get_error_summary / get_top_exceptions / get_recent_logs
        ├─ get_latency_summary (janela + baseline pré-janela)
        ├─ get_deployment_events
        └─ search_runbooks → get_runbook → search_adrs / search_tech_specs
  → regras de hipótese/confiança → InvestigationReport
  → ReportRenderer (relatório + registro de auditoria) → stdout
```

## Design de implementação

### Principais interfaces

Contratos completos em `packages/types`. Assinaturas centrais:

```typescript
/** Toda interação do engine com o mundo externo passa por aqui (RF6). */
interface ToolInvoker {
  invoke<TIn, TOut>(tool: ToolName, params: TIn): Promise<TOut>;
}

/** Decorator: registra seq, tool, params e resumo do resultado (RF7). */
interface AuditLog {
  readonly records: ToolCallRecord[];
  wrap(inner: ToolInvoker): ToolInvoker;
}

interface QuestionParser {
  parse(question: string): ParseResult; // { ok: true, context } | { ok: false, missing: MissingField[] }
}

interface InvestigationEngine {
  investigate(context: InvestigationContext, tools: ToolInvoker): Promise<InvestigationReport>;
}
```

```typescript
/** Implementadas por fakes na v1; por CloudWatch/Splunk/Prometheus na V3 (RF11). */
interface ObservabilityProvider {
  getErrorSummary(q: TimeWindowQuery): Promise<ErrorSummary>;
  getTopExceptions(q: TimeWindowQuery & { limit?: number }): Promise<TopExceptionsResult>;
  getRecentLogs(q: TimeWindowQuery & { level?: LogLevel; limit?: number }): Promise<RecentLogsResult>;
  getLatencySummary(q: TimeWindowQuery): Promise<LatencySummary>;
  getDeploymentEvents(q: TimeWindowQuery): Promise<DeploymentEventsResult>;
}

interface KnowledgeProvider {
  search(kind: 'runbooks' | 'adrs' | 'tech-specs', query: string, limit?: number): Promise<DocumentSearchResult>;
  getRunbook(name: string): Promise<RunbookResult>;
}
```

```typescript
interface EvalScorer {
  score(evalCase: EvalCase, report: InvestigationReport, renderedText: string): EvalCaseResult;
}
```

### Modelos de dados

Contratos JSON das tools e entidades internas — estruturados, tipados e previsíveis (RF9). Campos sem dado na fonte são normalizados para `null` (nunca omitidos nem inventados). Timestamps sempre ISO 8601 com offset explícito (`-03:00`). Janelas de tempo são `[from, to)` — `from` inclusivo, `to` exclusivo.

#### `InvestigationContext` — resultado da interpretação da pergunta (RF2)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `question` | `string` | sim | Pergunta original do usuário |
| `service` | `string` | sim | Serviço identificado (ex.: token kebab-case ou entre crases) |
| `window.from` | `string` (ISO 8601) | sim | Início da janela, com offset `-03:00` |
| `window.to` | `string` (ISO 8601) | sim | Fim da janela (exclusivo) |
| `symptom` | `string \| null` | não | Sintoma detectado (`erro 5xx`, `timeout`, `latência alta`...); `null` se não citado |

```json
{
  "question": "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08",
  "service": "checkout-api",
  "window": { "from": "2026-07-08T10:00:00-03:00", "to": "2026-07-08T10:30:00-03:00" },
  "symptom": "erro 5xx"
}
```

> **Variante — pergunta ambígua (RF3/US10):** o parser não adivinha. Sem serviço ou sem janela identificáveis, retorna `{ ok: false, missing: [...] }` e a CLI imprime orientação ("não identifiquei o serviço; mencione o nome do serviço na pergunta") **sem chamar nenhuma tool**.

```json
{
  "ok": false,
  "missing": [
    { "field": "window", "hint": "informe a data e o horário, ex.: \"entre 10h e 10h30 em 2026-07-08\"" }
  ]
}
```

#### `LogEntry` — linha do dataset de logs (`datasets/logs/*.jsonl`)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `timestamp` | `string` (ISO 8601) | sim | Instante do evento |
| `service` | `string` | sim | Nome do serviço emissor |
| `level` | `"DEBUG" \| "INFO" \| "WARN" \| "ERROR"` | sim | Nível do log |
| `traceId` | `string` | sim | Correlação de requisição |
| `endpoint` | `string \| null` | não | Rota HTTP no formato `MÉTODO /caminho` |
| `statusCode` | `number \| null` | não | Status HTTP da resposta |
| `exception` | `string \| null` | não | Nome da exception, quando houver |
| `message` | `string` | sim | Mensagem legível |
| `latencyMs` | `number \| null` | não | Latência da requisição em ms |

```json
{
  "timestamp": "2026-07-08T10:07:12-03:00",
  "service": "checkout-api",
  "level": "ERROR",
  "traceId": "abc-123",
  "endpoint": "POST /checkout",
  "statusCode": 500,
  "exception": "DatabaseTimeoutException",
  "message": "Timeout while calling payment database",
  "latencyMs": 3050
}
```

#### `ErrorSummary` — saída de `get_error_summary`

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `service` | `string` | sim | Serviço consultado (eco do parâmetro) |
| `window` | `{ from, to }` | sim | Janela consultada |
| `hasData` | `boolean` | sim | `false` quando não há nenhum registro do serviço na janela |
| `totalRequests` | `number` | sim | Total de requisições na janela (0 se sem dados) |
| `count5xx` | `number` | sim | Respostas 5xx |
| `count4xx` | `number` | sim | Respostas 4xx |
| `errorRate5xx` | `number` | sim | `count5xx / totalRequests` (0 quando `totalRequests` = 0), 4 casas |
| `byEndpoint` | `Array<{ endpoint, count5xx }>` | sim | 5xx por endpoint, ordem decrescente |
| `timeline` | `Array<{ bucketStart, count5xx }>` | sim | Buckets de 5 min, permite localizar o início do pico |

```json
{
  "service": "checkout-api",
  "window": { "from": "2026-07-08T10:00:00-03:00", "to": "2026-07-08T10:30:00-03:00" },
  "hasData": true,
  "totalRequests": 412,
  "count5xx": 87,
  "count4xx": 9,
  "errorRate5xx": 0.2112,
  "byEndpoint": [{ "endpoint": "POST /checkout", "count5xx": 81 }, { "endpoint": "GET /checkout/status", "count5xx": 6 }],
  "timeline": [
    { "bucketStart": "2026-07-08T10:00:00-03:00", "count5xx": 1 },
    { "bucketStart": "2026-07-08T10:05:00-03:00", "count5xx": 24 },
    { "bucketStart": "2026-07-08T10:10:00-03:00", "count5xx": 31 }
  ]
}
```

> **Variante — serviço/período sem dados (RF14):** mesma forma, com `hasData: false`, contadores em `0` e arrays vazios. Nunca `isError`, nunca dado inventado.

```json
{
  "service": "inventory-api",
  "window": { "from": "2026-07-08T10:00:00-03:00", "to": "2026-07-08T10:30:00-03:00" },
  "hasData": false,
  "totalRequests": 0,
  "count5xx": 0,
  "count4xx": 0,
  "errorRate5xx": 0,
  "byEndpoint": [],
  "timeline": []
}
```

#### `TopExceptionsResult` — saída de `get_top_exceptions`

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `service` / `window` / `hasData` | — | sim | Mesmo padrão de `ErrorSummary` |
| `exceptions` | `Array<ExceptionAggregate>` | sim | Ordenadas por `count` decrescente, máx. `limit` (default 5) |
| `exceptions[].exception` | `string` | sim | Nome da exception |
| `exceptions[].count` | `number` | sim | Ocorrências na janela |
| `exceptions[].sampleMessage` | `string` | sim | Mensagem de exemplo (primeira ocorrência) |
| `exceptions[].endpoints` | `string[]` | sim | Endpoints onde ocorreu |

```json
{
  "service": "checkout-api",
  "window": { "from": "2026-07-08T10:00:00-03:00", "to": "2026-07-08T10:30:00-03:00" },
  "hasData": true,
  "exceptions": [
    {
      "exception": "DatabaseTimeoutException",
      "count": 78,
      "sampleMessage": "Timeout while calling payment database",
      "endpoints": ["POST /checkout"]
    },
    { "exception": "ConnectionPoolExhaustedException", "count": 9, "sampleMessage": "No available connection in pool 'payments' after 5000ms", "endpoints": ["POST /checkout"] }
  ]
}
```

#### `RecentLogsResult` — saída de `get_recent_logs`

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `service` / `window` / `hasData` | — | sim | Padrão comum |
| `logs` | `LogEntry[]` | sim | Ordenados por `timestamp` decrescente, máx. `limit` (default 50) |
| `totalMatched` | `number` | sim | Total que casou com o filtro antes do truncamento |
| `truncated` | `boolean` | sim | `true` quando `totalMatched > logs.length` |

```json
{
  "service": "checkout-api",
  "window": { "from": "2026-07-08T10:00:00-03:00", "to": "2026-07-08T10:30:00-03:00" },
  "hasData": true,
  "totalMatched": 96,
  "truncated": true,
  "logs": [ { "timestamp": "2026-07-08T10:29:41-03:00", "service": "checkout-api", "level": "ERROR", "traceId": "f9c-882", "endpoint": "POST /checkout", "statusCode": 500, "exception": "DatabaseTimeoutException", "message": "Timeout while calling payment database", "latencyMs": 3104 } ]
}
```

#### `LatencySummary` — saída de `get_latency_summary`

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `service` / `window` / `hasData` | — | sim | Padrão comum |
| `unit` | `"ms"` | sim | Unidade fixa |
| `overall` | `{ p50, p95, p99 } \| null` | sim | Percentis agregados da janela; `null` se sem dados |
| `requestCount` | `number` | sim | Volume total na janela |
| `series` | `Array<{ bucketStart, p99, requestCount }>` | sim | Buckets de 5 min para detecção de salto |

```json
{
  "service": "checkout-api",
  "window": { "from": "2026-07-08T10:00:00-03:00", "to": "2026-07-08T10:30:00-03:00" },
  "hasData": true,
  "unit": "ms",
  "overall": { "p50": 220, "p95": 2410, "p99": 3200 },
  "requestCount": 412,
  "series": [
    { "bucketStart": "2026-07-08T10:00:00-03:00", "p99": 460, "requestCount": 71 },
    { "bucketStart": "2026-07-08T10:05:00-03:00", "p99": 1980, "requestCount": 69 },
    { "bucketStart": "2026-07-08T10:10:00-03:00", "p99": 3200, "requestCount": 66 }
  ]
}
```

> **Baseline:** o engine chama `get_latency_summary` duas vezes — janela do incidente e janela imediatamente anterior de mesma duração — e compara os `p99` (fica auditável no registro de tools, em vez de escondido dentro da tool).

#### `DeploymentEventsResult` — saída de `get_deployment_events`

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `service` / `window` / `hasData` | — | sim | Padrão comum |
| `events` | `DeploymentEvent[]` | sim | Ordenados por `timestamp` crescente |
| `events[].timestamp` | `string` (ISO 8601) | sim | Momento do deploy |
| `events[].service` | `string` | sim | Serviço deployado |
| `events[].version` | `string` | sim | Versão nova |
| `events[].previousVersion` | `string \| null` | não | Versão anterior |
| `events[].changeSummary` | `string \| null` | não | Resumo da mudança |

```json
{
  "service": "checkout-api",
  "window": { "from": "2026-07-08T10:00:00-03:00", "to": "2026-07-08T10:30:00-03:00" },
  "hasData": true,
  "events": [
    {
      "timestamp": "2026-07-08T10:03:00-03:00",
      "service": "checkout-api",
      "version": "2026.07.08-1",
      "previousVersion": "2026.07.07-3",
      "changeSummary": "Refatoração do acesso ao banco de pagamentos (novas queries no fluxo de checkout)"
    }
  ]
}
```

#### `DocumentSearchResult` — saída de `search_runbooks` / `search_adrs` / `search_tech_specs`

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `query` | `string` | sim | Termo buscado (eco) |
| `matches` | `Array<DocumentMatch>` | sim | Ranking decrescente por `score`, máx. `limit` (default 5); vazio = nada encontrado |
| `matches[].name` | `string` | sim | Identificador do documento (basename sem `.md`) |
| `matches[].title` | `string` | sim | Título (primeiro `# H1`) |
| `matches[].path` | `string` | sim | Caminho relativo ao repositório |
| `matches[].score` | `number` | sim | Frequência ponderada dos termos (título ×3, headings ×2, corpo ×1) |
| `matches[].excerpt` | `string` | sim | Trecho de até 240 chars ao redor do primeiro match |

```json
{
  "query": "checkout 5xx",
  "matches": [
    {
      "name": "checkout-api-high-5xx",
      "title": "Runbook: checkout-api — alta taxa de 5xx",
      "path": "knowledge-base/runbooks/checkout-api-high-5xx.md",
      "score": 11,
      "excerpt": "…verificar o connection pool do banco de pagamentos e mudanças recentes em queries do fluxo de checkout…"
    }
  ]
}
```

#### `RunbookResult` — saída de `get_runbook`

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `found` | `boolean` | sim | `false` quando o nome não existe |
| `name` | `string \| null` | sim | Identificador; `null` se não encontrado |
| `title` | `string \| null` | sim | Título do documento |
| `content` | `string \| null` | sim | Markdown completo |

```json
{ "found": true, "name": "checkout-api-high-5xx", "title": "Runbook: checkout-api — alta taxa de 5xx", "content": "# Runbook: checkout-api — alta taxa de 5xx\n\n## Passos de verificação\n1. Verificar connection pool…" }
```

> **Não encontrado:** `{ "found": false, "name": null, "title": null, "content": null }` — resultado válido, não erro (RF14).

#### `InvestigationReport` — saída estruturada do engine (RF4/RF5)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `context` | `InvestigationContext` | sim | O que foi interpretado da pergunta |
| `summary` | `string` | sim | Resumo executivo |
| `evidences` | `Array<{ statement, source }>` | sim | Cada evidência cita a origem (RF5) |
| `evidences[].source` | `{ tool: string, reference: string }` | sim | Tool que sustenta o fato + referência (ex.: `"timeline 10:05"`, `"runbooks/checkout-api-high-5xx.md"`) |
| `primaryHypothesis` | `Hypothesis \| null` | sim | `null` quando não há evidência suficiente (US9) |
| `alternativeHypotheses` | `Hypothesis[]` | sim | Pode ser vazio |
| `safeNextSteps` | `string[]` | sim | Nunca inicia com ação destrutiva (RF17) |
| `missingData` | `string[]` | sim | Sempre presente, mesmo que vazio |
| `confidence` | `"baixa" \| "media" \| "alta"` | sim | Confiança global da análise |
| `audit` | `ToolCallRecord[]` | sim | Registro completo de auditoria (RF7) |

`Hypothesis`: `{ statement: string, rationale: string, confidence: "baixa" | "media" | "alta" }`.

```json
{
  "summary": "O checkout-api apresentou aumento de erros 5xx a partir de ~10h05, concentrado em POST /checkout, correlacionado a um deploy às 10h03.",
  "evidences": [
    { "statement": "87 respostas 5xx em 412 requisições (21,1%), concentradas em POST /checkout.", "source": { "tool": "get_error_summary", "reference": "byEndpoint[0]" } },
    { "statement": "Exception dominante: DatabaseTimeoutException (78 ocorrências).", "source": { "tool": "get_top_exceptions", "reference": "exceptions[0]" } },
    { "statement": "p99 subiu de ~460ms (baseline 09:30–10:00) para ~3200ms.", "source": { "tool": "get_latency_summary", "reference": "overall.p99 vs baseline" } },
    { "statement": "Deploy da versão 2026.07.08-1 às 10:03, minutos antes do pico.", "source": { "tool": "get_deployment_events", "reference": "events[0]" } },
    { "statement": "O runbook orienta verificar connection pool e mudanças recentes de acesso ao banco.", "source": { "tool": "get_runbook", "reference": "knowledge-base/runbooks/checkout-api-high-5xx.md" } }
  ],
  "primaryHypothesis": { "statement": "Regressão introduzida no deploy das 10h03 afetando acesso ao banco/connection pool.", "rationale": "Correlação temporal deploy → pico de 5xx + exception de timeout de banco + salto de p99.", "confidence": "alta" },
  "alternativeHypotheses": [ { "statement": "Degradação do próprio banco de pagamentos, independente do deploy.", "rationale": "Timeouts de banco também ocorrem sem mudança de código.", "confidence": "baixa" } ],
  "safeNextSteps": ["Comparar a versão 2026.07.08-1 com a 2026.07.07-3 (diff do deploy).", "Verificar alterações em queries, transações e connection pool.", "Validar métricas do banco na janela do incidente.", "Avaliar rollback com o time responsável — não executar automaticamente."],
  "missingData": ["Métricas internas do banco de pagamentos.", "Traces distribuídos da janela."],
  "confidence": "alta",
  "audit": [ { "seq": 1, "tool": "get_error_summary", "params": { "service": "checkout-api", "from": "2026-07-08T10:00:00-03:00", "to": "2026-07-08T10:30:00-03:00" }, "resultSummary": "412 req, 87x 5xx" } ]
}
```

#### `ToolCallRecord` — entrada do registro de auditoria (RF7)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `seq` | `number` | sim | Ordem de execução (1-based) |
| `tool` | `string` | sim | Nome da tool chamada |
| `params` | `object` | sim | Parâmetros exatos enviados |
| `resultSummary` | `string` | sim | Resumo curto do retorno (contagens, `hasData`) — nunca o payload inteiro |
| `durationMs` | `number` | sim | Duração (informativa; fora do escopo do eval) |

#### `EvalCase` — caso de teste (`evals/cases/*.json`, RF25)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `id` | `string` | sim | Ex.: `case-001-database-timeout` |
| `question` | `string` | sim | Pergunta submetida à investigação |
| `expected_findings` | `string[]` | sim | Termos/padrões que devem aparecer no relatório (matching case/acento-insensível) |
| `must_not_include` | `string[]` | sim | Termos proibidos |

```json
{
  "id": "case-001-database-timeout",
  "question": "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08",
  "expected_findings": ["DatabaseTimeoutException", "p99", "deploy", "POST /checkout", "connection pool"],
  "must_not_include": ["certeza absoluta", "reiniciar automaticamente", "rollback executado", "drop table"]
}
```

#### `EvalCaseResult` — resultado por caso (RF26/RF27)

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `caseId` | `string` | sim | Id do caso |
| `criteria` | `Array<{ name, passed, details }>` | sim | Um item por critério: cada finding esperado, cada termo proibido, `cita_evidencias`, `separa_fato_de_hipotese`, `proximos_passos_seguros` |
| `score` | `number` | sim | `critériosAprovados / totalCritérios`, 2 casas |
| `passed` | `boolean` | sim | `true` quando `score === 1` |

```json
{
  "caseId": "case-001-database-timeout",
  "score": 1.0,
  "passed": true,
  "criteria": [
    { "name": "finding:DatabaseTimeoutException", "passed": true, "details": "encontrado na seção Evidências" },
    { "name": "proibido:certeza absoluta", "passed": true, "details": "ausente" },
    { "name": "cita_evidencias", "passed": true, "details": "5/5 evidências com source" },
    { "name": "separa_fato_de_hipotese", "passed": true, "details": "seções Evidências e Hipóteses presentes e distintas" },
    { "name": "proximos_passos_seguros", "passed": true, "details": "4 passos; nenhum destrutivo em 1ª posição" }
  ]
}
```

#### `ToolError` — envelope de erro de tool (validação)

Erros de **validação de entrada** usam o mecanismo padrão do MCP (`isError: true` no resultado da tool), com mensagem prefixada por código. Ausência de dados **não é erro** (ver variantes `hasData`/`found` acima).

| Código | Mecanismo | Significado |
| --- | --- | --- |
| `INVALID_ARGUMENT` | `isError: true` | Parâmetro fora do schema Zod (tipo, formato ISO, enum `level`) |
| `INVALID_TIME_RANGE` | `isError: true` | `from >= to` ou janela > 24h |
| `EMPTY_QUERY` | `isError: true` | `query` vazia/só espaços nas tools de busca |

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "INVALID_TIME_RANGE: 'from' (2026-07-08T11:00:00-03:00) deve ser anterior a 'to' (2026-07-08T10:00:00-03:00)." }]
}
```

#### Mapeamento datasets → contratos

| Origem (arquivo fake) | Destino (contrato) |
| --- | --- |
| `datasets/logs/checkout-api.jsonl` (JSONL, 1 `LogEntry`/linha) | `RecentLogsResult.logs`; agregado em `ErrorSummary` (por `statusCode`/`endpoint`) e `TopExceptionsResult` (por `exception`) |
| `datasets/logs/payment-api.jsonl` | Idem, cenário secundário (case-002) |
| `datasets/metrics/latency.json` (array de `MetricPoint` {timestamp, service, requestCount, p50Ms, p95Ms, p99Ms}, granularidade 1 min) | `LatencySummary.overall` (máx/mediana dos pontos) e `series` (buckets 5 min) |
| `datasets/deployments/deployments.json` (array de `DeploymentEvent`) | `DeploymentEventsResult.events` (filtro por `service` + janela) |
| `knowledge-base/{runbooks,adrs,tech-specs}/*.md` | `DocumentSearchResult` / `RunbookResult` |

> Linha malformada em JSONL é ignorada com warning em stderr — nunca derruba a tool nem contamina o resultado.

#### Parâmetros e defaults fixados

| Tool/Camada | Parâmetros principais |
| --- | --- |
| `get_recent_logs` | `limit=50` (máx. 200), `level` opcional (sem `level` = todos) |
| `get_top_exceptions` | `limit=5` (máx. 20) |
| `search_*` | `limit=5` (máx. 10), busca case/acento-insensível |
| Timeline/séries | Buckets fixos de 5 minutos |
| Engine (baseline) | Janela anterior de mesma duração da janela consultada |
| Janela máxima | 24h por chamada (proteção de contexto/tokens) |

### Endpoints da API

A superfície de API da v1 são as **9 MCP tools** do `agentops-server` (stdio, JSON-RPC — não há HTTP). Cada tool é documentada abaixo no lugar dos endpoints. Todos os schemas de entrada são Zod em `packages/types`; saídas via `structuredContent` (+ espelho serializado em `content[0].text`).

#### Visão geral

| Tool | Domínio | Descrição |
| --- | --- | --- |
| `get_error_summary` | observability | Contagens de erro (5xx/4xx), taxa, quebra por endpoint e timeline na janela |
| `get_top_exceptions` | observability | Ranking de exceptions com contagem, mensagem-exemplo e endpoints |
| `get_recent_logs` | observability | Logs filtrados por nível e janela, limitados e ordenados |
| `get_latency_summary` | observability | Percentis (p50/p95/p99) agregados + série por bucket |
| `get_deployment_events` | observability | Deploys do serviço dentro da janela |
| `search_runbooks` | knowledge | Busca textual em `knowledge-base/runbooks/` |
| `get_runbook` | knowledge | Conteúdo completo de um runbook pelo nome |
| `search_adrs` | knowledge | Busca textual em `knowledge-base/adrs/` |
| `search_tech_specs` | knowledge | Busca textual em `knowledge-base/tech-specs/` |

---

#### `get_error_summary`

Primeira leitura de qualquer investigação: dimensiona o problema (volume, taxa, onde, quando).

**Parâmetros**

| Param | Tipo | Default | Regras |
| --- | --- | --- | --- |
| `service` | `string` | — | 1–100 chars, não vazio |
| `from` | `string` | — | ISO 8601 com offset; `from < to`; janela ≤ 24h |
| `to` | `string` | — | ISO 8601 com offset |

**Respostas**

| Resultado | Corpo | Quando |
| --- | --- | --- |
| sucesso | `ErrorSummary` (`hasData: true`) | Há registros do serviço na janela |
| vazio | `ErrorSummary` (`hasData: false`, zeros) | Serviço/janela sem dados — **não é erro** |
| `isError` | `ToolError` `INVALID_TIME_RANGE`/`INVALID_ARGUMENT` | Parâmetros inválidos |

**Exemplo — sucesso**

```json
{ "name": "get_error_summary", "arguments": { "service": "checkout-api", "from": "2026-07-08T10:00:00-03:00", "to": "2026-07-08T10:30:00-03:00" } }
```

Resposta: ver exemplo completo de [`ErrorSummary`](#errorsummary--saída-de-get_error_summary).

**Exemplo — serviço sem dados**: ver variante `hasData: false` em `ErrorSummary`.

---

#### `get_top_exceptions`

Identifica a exception dominante — insumo central das regras de hipótese.

**Parâmetros**: `service`, `from`, `to` (idem acima) + `limit` (`number`, default `5`, máx. `20`).

**Respostas**: `TopExceptionsResult` (sucesso/vazio) | `ToolError` (validação). Exemplos na seção Modelos de dados.

---

#### `get_recent_logs`

Amostra de logs crus para citar evidência concreta (mensagem, traceId).

**Parâmetros**

| Param | Tipo | Default | Regras |
| --- | --- | --- | --- |
| `service`, `from`, `to` | — | — | Idem `get_error_summary` |
| `level` | `enum` | — (todos) | `DEBUG \| INFO \| WARN \| ERROR` |
| `limit` | `number` | `50` | 1–200 |

**Respostas**: `RecentLogsResult` — sempre informa `totalMatched`/`truncated` para o engine saber que viu uma amostra, não o todo.

> **Eficiência de contexto:** a tool nunca devolve o dataset inteiro; o default de 50 + ordenação decrescente entrega os logs mais próximos do fim da janela.

---

#### `get_latency_summary`

Percentis para detectar degradação (ex.: p99 450ms → 3200ms).

**Parâmetros**: `service`, `from`, `to` (idem `get_error_summary`).

**Respostas**: `LatencySummary` (sucesso: `overall` preenchido; vazio: `hasData: false`, `overall: null`, `series: []`) | `ToolError`.

---

#### `get_deployment_events`

Correlaciona mudanças de versão com o início do sintoma.

**Parâmetros**: `service`, `from`, `to`. O engine chama com a janela do incidente **estendida 15 min para trás**, para capturar deploys imediatamente anteriores ao pico (o parâmetro fica visível na auditoria).

**Respostas**: `DeploymentEventsResult` (sucesso/vazio) | `ToolError`.

---

#### `search_runbooks` / `search_adrs` / `search_tech_specs`

Busca textual simples (sem embeddings) na pasta correspondente da knowledge base. As três compartilham contrato; muda apenas o diretório-alvo.

**Parâmetros**

| Param | Tipo | Default | Regras |
| --- | --- | --- | --- |
| `query` | `string` | — | Não vazia (senão `EMPTY_QUERY`); tokenizada por espaço; acentos/caixa ignorados |
| `limit` | `number` | `5` | 1–10 |

**Respostas**

| Resultado | Corpo | Quando |
| --- | --- | --- |
| sucesso | `DocumentSearchResult` com `matches` ranqueados | Ao menos um termo casa |
| vazio | `DocumentSearchResult` com `matches: []` | Nenhum documento casa — não é erro |
| `isError` | `ToolError` `EMPTY_QUERY` | Query vazia |

**Exemplo — sucesso**

```json
{ "name": "search_runbooks", "arguments": { "query": "checkout 5xx database timeout" } }
```

Resposta: ver exemplo de [`DocumentSearchResult`](#documentsearchresult--saída-de-search_runbooks--search_adrs--search_tech_specs).

**Exemplo — nenhuma correspondência**

```json
{ "query": "kafka rebalance", "matches": [] }
```

> O engine trata `matches: []` como "documentação não encontrada" e registra isso em `missingData` — nunca inventa conteúdo de runbook.

---

#### `get_runbook`

Recupera o conteúdo integral de um runbook identificado via `search_runbooks`.

**Parâmetros**: `name` (`string`, basename sem extensão, ex.: `checkout-api-high-5xx`).

**Respostas**: `RunbookResult` com `found: true` + conteúdo, ou `found: false` + campos `null` (não é erro).

---

### Pipeline do Investigation Engine (raciocínio determinístico)

Sequência fixa, espelhando os 11 passos da skill `investigate-incident` (RF16). Passos 2–8 são chamadas de tool auditadas; 1 e 9–11 são locais.

| # | Passo da skill | Ação do engine |
| --- | --- | --- |
| 1 | Identificar serviço/período/sintoma | `QuestionParser.parse()` — curto-circuito com orientação se incompleto (RF3) |
| 2 | Resumo de erros | `get_error_summary(service, from, to)` |
| 3 | Top exceptions | `get_top_exceptions(service, from, to)` |
| 4 | Logs recentes | `get_recent_logs(service, level=ERROR, from, to, limit=50)` |
| 5 | Latência e volume | `get_latency_summary` ×2 (janela + baseline anterior) |
| 6 | Eventos de deploy | `get_deployment_events(service, from−15min, to)` |
| 7 | Runbook relacionado | `search_runbooks(service + sintoma)` → `get_runbook(top1)` se houver match |
| 8 | ADRs/tech specs | `search_adrs` / `search_tech_specs` com termos derivados da exception dominante (ex.: `database`, `payment`) — só quando existe exception dominante |
| 9 | Formular hipóteses | Regras R1–R3 (abaixo) |
| 10 | Separar fatos de suposições | Fatos = somente saídas de tools com citação; hipóteses = seção própria com `confidence` |
| 11 | Próximos passos seguros | Derivados do runbook encontrado + defaults seguros; validador garante que o 1º passo nunca é destrutivo |

**Regras de hipótese (determinísticas):**

- **R1 — Regressão de deploy**: deploy no intervalo `[from−15min, to)` **e** exception dominante (≥50% dos erros) **e** p99 da janela ≥ 2× baseline → hipótese principal "regressão introduzida no deploy X"; alternativas: degradação da dependência citada na exception.
- **R2 — Dependência degradada**: sem deploy na janela **e** exception dominante de timeout → hipótese principal "dependência externa/banco degradado"; alternativa: mudança de tráfego (se `requestCount` da janela ≥ 1,5× baseline).
- **R3 — Dados insuficientes**: `hasData: false` nas tools de telemetria → sem hipótese (`primaryHypothesis: null`), relatório declara explicitamente o que não foi encontrado (US9).

**Classificação de confiança (RF17):** `alta` = 3+ classes independentes de evidência convergentes (erros + latência + deploy) **e** runbook corrobora; `media` = 2 classes convergentes; `baixa` = 0–1 classe ou dados ausentes. Aplicada por função pura `classifyConfidence(signals)` — testável isoladamente.

## Pontos de integração

- **CLI/Evals ↔ agentops-server (interno)**: MCP sobre stdio (JSON-RPC), SDK oficial v1.x. O client (`StdioClientTransport`) spawna o server como processo filho usando `tsx` (sem etapa de build). Timeout de chamada default do SDK (60s) é suficiente; erro de spawn/protocolo produz mensagem orientativa na CLI (nunca stack trace cru).
- **Filesystem (read-only)**: providers leem `datasets/` e `knowledge-base/` com `fs.readFile` apenas — nenhuma API de escrita é importada nos pacotes `providers`/`agentops-server` (verificável por teste estático simples/CI grep).
- **Nenhum serviço externo na v1**: sem rede, sem API keys, sem cloud (restrição do PRD). Integrações reais (CloudWatch/Splunk/Prometheus) entram na V3 implementando `ObservabilityProvider` sem tocar nas tools (RF11).
- **Autenticação**: não se aplica (laboratório local, single-user).

## Abordagem de testes

Framework: **Vitest** (workspace root com projects) + `@vitest/coverage-v8`. Meta: **>80% de linhas/branches** em `types`, `providers`, `core`, `agentops-server` e `evals/scoring`. Os datasets reais do repositório servem de fixtures (são determinísticos por design); fixtures sintéticas adicionais em `__fixtures__/` para casos de borda.

### Testes unitários

**`@agentops/core` — QuestionParser** (`question-parser.test.ts`):

1. Extrai serviço entre crases: `` `checkout-api` `` → `checkout-api`.
2. Extrai serviço kebab-case sem crases: "o checkout-api teve…".
3. Janela "entre 10h e 10h30 em 2026-07-08" → `10:00`/`10:30` com offset `-03:00`.
4. Janela "entre 10:00 e 10:30 em 2026-07-08" (formato com dois-pontos).
5. Janela "das 14h às 14h20 em 2026-07-08" (variação "das/às").
6. Timestamps ISO completos na pergunta são aceitos diretamente.
7. Hora sem data → `ok: false`, `missing` contém `window` com hint pedindo a data (não adivinha "hoje").
8. Pergunta sem serviço identificável → `missing` contém `service`.
9. Pergunta sem nenhuma referência temporal → `missing` contém `window`.
10. Pergunta sem serviço **e** sem janela → `missing` lista ambos.
11. Sintoma "erro 5xx" detectado; "timeout" detectado; "latência alta" detectado.
12. Pergunta sem sintoma → `symptom: null` (investigação genérica prossegue).
13. Range invertido na pergunta ("entre 10h30 e 10h") → `missing`/erro orientativo, nunca janela negativa.
14. Acentos e caixa não afetam a extração ("LATÊNCIA", "latencia").

**`@agentops/providers` — FakeObservabilityProvider** (`observability-provider.test.ts`):

15. `getErrorSummary` do cenário principal: contagens 5xx/4xx corretas, `byEndpoint[0] = POST /checkout`, timeline com pico a partir do bucket 10:05.
16. `getErrorSummary` fora da janela do incidente (09:00–09:30) → `hasData: true` com `count5xx` baixo/zero (comportamento normal pré-incidente).
17. Serviço inexistente → `hasData: false`, zeros, arrays vazios (RF14).
18. Janela `[from, to)`: log exatamente em `to` fica de fora; em `from`, dentro.
19. `getTopExceptions`: ordenação decrescente por count; `DatabaseTimeoutException` no topo do cenário principal.
20. `getTopExceptions` respeita `limit` (limit=1 → 1 item).
21. `getRecentLogs` filtra por `level=ERROR`; sem `level` retorna todos os níveis.
22. `getRecentLogs` respeita `limit` default 50; `truncated: true` quando `totalMatched > 50`; ordenação decrescente por timestamp.
23. `getLatencySummary` janela do incidente: `overall.p99 ≈ 3200`; baseline (09:30–10:00): `p99 ≈ 450`.
24. `getLatencySummary` de serviço sem métricas → `overall: null`, `series: []`.
25. `getDeploymentEvents` retorna o deploy de 10:03 na janela 09:48–10:30; não retorna na janela 10:10–10:30.
26. Linha JSONL malformada na fixture sintética → ignorada com warning em stderr, demais linhas processadas.
27. Determinismo: duas chamadas idênticas retornam resultados profundamente iguais (RF9).

**`@agentops/providers` — FakeKnowledgeProvider** (`knowledge-provider.test.ts`):

28. `search('runbooks', 'checkout 5xx')` → `checkout-api-high-5xx` em 1º (score de título/headings maior).
29. Busca é case/acento-insensível ("TIMEOUT", "conexao").
30. Busca sem correspondência → `matches: []`.
31. `search` não vaza entre tipos: query de runbook não retorna ADR e vice-versa.
32. `limit` respeitado no ranking.
33. `getRunbook('checkout-api-high-5xx')` → `found: true`, `content` com o markdown completo.
34. `getRunbook('nao-existe')` → `found: false`, campos `null` (nunca exceção).
35. `excerpt` limitado a 240 chars e contém o termo buscado.

**`@agentops/core` — InvestigationEngine** (com `ToolInvoker` stub — sem MCP) (`engine.test.ts`):

36. Cenário principal (stubs devolvendo dados do case-001): ordem das chamadas de tool corresponde exatamente aos passos 2–8 da skill (RF16).
37. Relatório contém as 7 seções na ordem do RF4.
38. Toda evidência tem `source.tool` e `source.reference` não vazios (RF5).
39. R1 dispara: deploy + exception dominante + p99 ≥2× baseline → hipótese "regressão do deploy", confiança `alta` (runbook corrobora).
40. R1 sem corroboração de runbook (search vazio) → confiança `media` e `missingData` menciona runbook não encontrado.
41. R2 dispara: sem deploy + timeout dominante → hipótese "dependência degradada".
42. R3 dispara: todas as tools com `hasData: false` → `primaryHypothesis: null`, `confidence: baixa`, `missingData` lista o que não foi encontrado; nenhuma evidência fabricada (US9).
43. Passo 8 (ADRs/tech specs) é pulado quando não há exception dominante — e a auditoria comprova a ausência da chamada.
44. `safeNextSteps[0]` nunca contém termos destrutivos (rollback/restart só aparecem como "avaliar", nunca em 1ª posição) (RF17).
45. Nenhum texto do relatório contém fato que não veio de tool: com stubs vazios, o relatório não menciona `DatabaseTimeoutException` (anti-alucinação, RF6).
46. AuditLog: `seq` incremental, params ecoados byte a byte, um registro por chamada (RF7).
47. Tool retornando `isError` → engine registra a falha na auditoria e degrada para `missingData` (não aborta a investigação inteira).

**`@agentops/cli-agent` — ReportRenderer** (`renderer.test.ts`):

48. Renderiza as 7 seções com títulos em português na ordem do RF4 + seção de auditoria ao final.
49. Com `NO_COLOR=1` (ou stdout não-TTY) a saída não contém sequências ANSI; conteúdo idêntico ao colorido (acessibilidade).
50. Relatório de pergunta ambígua: mensagem orientativa citando exatamente os campos faltantes, sem stack trace.
51. Saída redirecionada para arquivo permanece completa e legível (sem controle de cursor).

**`@agentops/evals` — Scorer** (`scoring.test.ts`):

52. Finding presente no texto → critério `finding:X` passa; matching case/acento-insensível.
53. Finding ausente → critério falha e `details` aponta a ausência.
54. Termo proibido presente → critério `proibido:X` falha.
55. `cita_evidencias`: passa quando toda evidência tem source; falha com evidência sem citação (fixture manipulada).
56. `separa_fato_de_hipotese`: exige seções "Evidências" e "Hipótese" distintas e não vazias (no caso missing-data, hipótese vazia + missingData preenchido também passa).
57. `proximos_passos_seguros`: falha se lista vazia ou 1º item destrutivo.
58. `score` = aprovados/total com 2 casas; `passed` só com 100%.
59. Scorer é puro: mesmo input → mesmo resultado (RF26).

**`@agentops/types` — schemas Zod** (`schemas.test.ts`):

60. Cada schema de entrada de tool aceita o exemplo válido documentado e rejeita: timestamp sem offset, `level` fora do enum, `limit` acima do máximo, `service` vazio.
61. `from >= to` rejeitado pelo refinement `INVALID_TIME_RANGE`.

### Testes de integração

Componentes reais juntos, incluindo o protocolo MCP de verdade (server spawnado via stdio):

62. **Server MCP — descoberta**: client SDK conecta ao `agentops-server` e `listTools()` retorna exatamente as 9 tools, cada uma com descrição não vazia e inputSchema.
63. **Cada tool via protocolo**: `callTool` das 9 tools com parâmetros válidos → `structuredContent` valida contra o schema de saída Zod correspondente (9 casos).
64. **Validação via protocolo**: `callTool('get_error_summary', {from > to})` → `isError: true` com prefixo `INVALID_TIME_RANGE`; `search_runbooks` com query vazia → `EMPTY_QUERY`.
65. **Vazio via protocolo**: serviço inexistente → resposta bem formada `hasData: false` (não `isError`) (RF14).
66. **Determinismo fim-a-fim**: mesma chamada duas vezes → `structuredContent` idêntico (RF9).
67. **Engine + server reais (case-001)**: investigação completa da pergunta principal → relatório com hipótese de regressão de deploy, confiança `alta`, ≥4 evidências citadas e auditoria com ≥8 chamadas na ordem da skill.
68. **Engine + server reais (case-002)**: pergunta do payment-api → hipótese de dependência externa, sem menção a deploy inexistente.
69. **Engine + server reais (case-003)**: serviço sem dados → relatório declara dados ausentes, confiança `baixa`, zero findings inventados.
70. **Eval runner completo**: `runEvals()` sobre os 3 casos → case-001 com `score = 1.0` e 0 termos proibidos (meta do PRD); saída inclui breakdown de critérios por caso (RF27).

### Testes E2E

Não há frontend — **Playwright não se aplica** (registrado como desvio justificado do template). O E2E da v1 é a CLI executada como processo real (via `execa`/`child_process` no Vitest, suite `e2e`):

71. `npm run investigate -- "<pergunta case-001>"` → exit code 0; stdout contém as 7 seções do RF4 na ordem + seção "Tools chamadas" (RF1/RF7).
72. `npm run investigate -- "por que deu erro?"` (ambígua) → exit code 0; mensagem orientativa listando serviço e janela como faltantes; nenhuma tool chamada (US10).
73. `npm run investigate` sem argumento → mensagem de uso (`usage`) e exit code 1.
74. `npm run investigate -- "<pergunta case-003>"` → relatório com "Dados faltantes" preenchido e confiança `baixa` (US9).
75. `npm run eval` → exit code 0; imprime score por caso + resumo agregado; case-001 = 100% (RF23).
76. Saída redirecionada (`> relatorio.txt`) → arquivo completo, sem códigos ANSI.

## Sequenciamento do desenvolvimento

### Ordem de construção

Segue a ordem recomendada no `AGENTS.md` §11, com testes escritos junto de cada etapa:

1. **Bootstrap do monorepo** — `package.json` raiz (workspaces, scripts `investigate`/`eval`/`test`), `tsconfig.base.json`, Vitest, `tsx`. Sem isso nada compila.
2. **`packages/types`** — todos os contratos e schemas Zod (testes 60–61). É a fundação de todos os demais pacotes.
3. **`datasets/` + `knowledge-base/` + `skills/investigate-incident/skill.md`** — dados e documentos do cenário principal, secundário e de ausência (RF18–RF22). Precisam existir antes dos providers para servirem de fixtures.
4. **`packages/providers`** — fake providers com agregações (testes 15–35). Dependem de types e datasets.
5. **`mcp-servers/agentops-server`** — server MCP com as 9 tools (testes 62–66). Depende de providers.
6. **`packages/core`** — parser, engine, regras, audit (testes 1–14, 36–47). Desenvolvível em paralelo ao server (usa `ToolInvoker` stub).
7. **`apps/cli-agent`** — MCP client, renderer, entrypoint (testes 48–51, 71–74, 76). Integra tudo.
8. **`evals/`** — casos, scorer, runner (testes 52–59, 70, 75). Último porque exercita o sistema completo.
9. **Documentação** — `README.md` (instalar, investigar, eval, como adicionar dataset/tool/skill, evolução V2/V3), `docs/architecture.md`, `docs/roadmap.md`, `docs/decisions.md` (registrar: server único, SDK v1.x, workspaces, Vitest).
10. **Validação final** — `npm install` limpo, `npm run investigate`, `npm run eval`, cobertura >80%.

### Dependências técnicas

- **Runtime**: Node.js ≥ 20 (ESM, `node:` prefixo). Nenhuma infraestrutura externa.
- **Dependências de produção**: `@modelcontextprotocol/sdk` (v1.x estável), `zod` (v3, compatível com o SDK). Nada mais.
- **Dependências de dev**: `typescript`, `tsx`, `vitest`, `@vitest/coverage-v8`, `execa` (E2E).
- **Bloqueadores externos**: nenhum — o projeto roda 100% offline após `npm install`.

## Monitoramento e observabilidade

Laboratório local — **não há Prometheus/Grafana na v1** (desvio consciente do template; a exportação de métricas reais é direção V4). A observabilidade da v1 é a do próprio agente:

- **Audit log (primário)**: todo `ToolCallRecord` (seq, tool, params, resumo, duração) é exibido ao final de cada investigação (RF7) — é simultaneamente feature e instrumento de observabilidade do agente.
- **Logs do MCP server**: exclusivamente em **stderr** (stdout é o canal JSON-RPC do protocolo — regra inegociável em servers stdio). Formato: `[agentops-server] LEVEL mensagem`. Nível controlado por `AGENTOPS_LOG_LEVEL` (default `warn` para não poluir a CLI).
- **Logs da CLI**: mensagens de progresso por etapa ("Coletando resumo de erros…") em stderr, relatório final em stdout — permite `> relatorio.txt` limpo.
- **Eval como monitor de regressão**: `npm run eval` é o "health check" do agente; qualquer mudança em engine/datasets/skill deve manter case-001 em 100%.
- **Preparação V4**: `ToolCallRecord` já carrega `durationMs`, tornando trivial exportar spans/tracing no futuro sem mudar contratos.

## Considerações técnicas

### Principais decisões

1. **Um MCP server na v1 (`agentops-server`)** — decisão do usuário, usando o fallback previsto no RF8. Justificativa: menos processos para orquestrar na PoC. Mitigação do desvio em relação ao `AGENTS.md` (que prevê dois servers): tools separadas em módulos `observability/` e `knowledge/` com uma factory comum de server; separar em dois vira "criar segundo entrypoint + ajustar spawn na CLI". Registrar em `docs/decisions.md`.
2. **SDK MCP v1.x estável** (`@modelcontextprotocol/sdk`) em vez do v2 beta (pacotes `@modelcontextprotocol/server`/`client`, previsto para 28/07/2026). O v1.x é o release suportado; migrar para v2 é exercício de estudo documentado no roadmap.
3. **Engine fala com tools via `ToolInvoker`, mesmo sendo o mesmo repositório** — o engine *poderia* chamar os providers direto, mas isso mataria o objetivo de estudo do MCP e violaria RF6. O custo (spawn de um processo filho) é desprezível localmente, e o `AuditLog` como decorator do invoker torna a auditoria estrutural, não opcional.
4. **Baseline de latência por segunda chamada de tool** (janela anterior) em vez de a tool calcular baseline internamente — mantém a tool simples/genérica e deixa a comparação visível no audit log.
5. **Ausência de dados como resultado válido (`hasData`/`found`/`matches: []`), nunca `isError`** — permite ao engine distinguir "não há dados" (informação investigativa, US9) de "chamada inválida" (bug), conforme RF14 e a skill `desenvolver-mcp-tools`.
6. **Parser de pergunta por regex/dicionário PT-BR, sem NLP** — determinismo é pré-requisito do eval. Regra dura: **nunca adivinhar** serviço ou data ausentes (RF3). Trade-off aceito: variações de fraseado não previstas caem no fluxo de orientação, o que é o comportamento seguro desejado.
7. **`tsx` em runtime, sem etapa de build** — a CLI spawna o server TypeScript diretamente; elimina desincronia código/dist num laboratório em constante edição. Trade-off: `tsx` vira dependência de runtime do lab (aceitável; não é um pacote publicado).
8. **Alternativas descartadas**: busca vetorial/embeddings (fora do escopo, PRD); LLM-as-judge no eval (RF26 exige matching determinístico); frameworks de agente (LangChain etc.) — overengineering para um engine determinístico didático; monólito de pacote único (desalinhado da estrutura-alvo do `AGENTS.md`).

### Riscos conhecidos

- **Fragilidade do parser PT-BR**: fraseados fora do dicionário caem em "não entendi" com frequência. Mitigação: suíte ampla de casos (testes 1–14) cobrindo as variações mais prováveis + hints acionáveis na mensagem de orientação; o comportamento seguro (pedir esclarecimento) já é o requisito (RF3).
- **Eval acoplado ao texto do relatório**: mudanças de redação podem quebrar findings por matching literal. Mitigação: `expected_findings` usam termos técnicos estáveis (nomes de exception, endpoint, "deploy", "p99") e o matching é case/acento-insensível; scorer avalia também o `InvestigationReport` estruturado, não só o texto.
- **Overhead/fragilidade do spawn stdio nos testes**: suites de integração dependem de spawn de processo. Mitigação: reutilizar uma conexão por suite (`beforeAll`/`afterAll`), timeouts explícitos e fallback de diagnóstico via stderr do server.
- **Evolução do SDK (v2 em 28/07/2026)**: breaking change conhecido no horizonte. Mitigação: superfície de contato com o SDK isolada em dois arquivos (factory do server; `McpToolInvoker` no client) — migração localizada.
- **Percentis com poucos pontos**: p99 sobre buckets de 5 min com ~70 requisições é aproximado. Aceitável: os datasets são desenhados para que o sinal (450→3200ms) seja ordens de magnitude maior que o erro do estimador; documentar a interpolação escolhida no provider.

### Conformidade com skills

Skills em `.claude/skills/` aplicáveis a esta especificação:

- **`desenvolver-mcp-tools`** — norma diretamente aplicável ao desenho das tools/servers. Esta spec cumpre: um domínio por módulo (observability/knowledge), tools `snake_case` verbo+recurso, contratos in/out em `packages/types`, leitura só via provider, filtros/limites com defaults (`limit=50/5`, janela ≤24h, buckets 5 min), vazio explícito ≠ erro, read-only estrito, entrada validada por Zod, descrições orientadas ao agente. O checklist `references/TOOL_CHECKLIST.md` deve ser percorrido por tool na implementação. Único ponto de atenção: a skill assume dois servers; o server único é o fallback autorizado pelo RF8 (decisão registrada).
- **`criar-tasks`** — próxima etapa do fluxo: derivar o plano de tarefas a partir desta techspec.
- **`criar-prd`** / **`criar-techspec`** — já exercidas (PRD e este documento).

Não existe pasta `.claude/rules` no repositório (verificado) — nenhuma rule adicional a conformar.

### Arquivos relevantes e dependentes

**Existentes (insumos):**

- `tasks/prd-incident-investigation-assistant/prd.md` — requisitos (RF1–RF27)
- `prompt.md` — especificação canônica (formato da skill, exemplo de saída, cenário fake)
- `AGENTS.md` — regras do repositório, estrutura-alvo, cenário de referência, ordem de implementação
- `.claude/skills/desenvolver-mcp-tools/SKILL.md` + `references/TOOL_CHECKLIST.md` — padrões de tools MCP

**A criar (principais, por pacote):**

- Raiz: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `README.md`
- `packages/types/src/`: `tools/observability.ts`, `tools/knowledge.ts`, `datasets.ts`, `report.ts`, `audit.ts`, `eval.ts`, `index.ts`
- `packages/providers/src/`: `observability/fake-observability-provider.ts`, `knowledge/fake-knowledge-provider.ts`, `shared/jsonl.ts`, `shared/percentiles.ts`, `shared/text-search.ts`
- `mcp-servers/agentops-server/src/`: `main.ts`, `server-factory.ts`, `observability/tools.ts`, `knowledge/tools.ts`
- `packages/core/src/`: `question-parser.ts`, `engine.ts`, `rules/hypotheses.ts`, `rules/confidence.ts`, `report.ts`, `audit-log.ts`, `tool-invoker.ts`
- `apps/cli-agent/src/`: `main.ts`, `mcp-tool-invoker.ts`, `renderer.ts`
- `evals/`: `src/runner.ts`, `scoring/scorer.ts`, `cases/case-001-database-timeout.json`, `cases/case-002-payment-api-timeout.json`, `cases/case-003-missing-data.json`, `expected-answers/case-001.md` (golden de referência)
- `datasets/`: `logs/checkout-api.jsonl` (~300 linhas: 09:30–10:30, normal→incidente), `logs/payment-api.jsonl` (~150 linhas: cenário 14:00–14:20), `metrics/latency.json` (pontos de 1 min por serviço), `deployments/deployments.json`
- `knowledge-base/`: `runbooks/checkout-api-high-5xx.md`, `runbooks/database-timeout.md`, `adrs/adr-001-checkout-payment-flow.md`, `tech-specs/checkout-api.md` (RF18, conteúdo coerente com RF19)
- `skills/investigate-incident/skill.md` — conforme estrutura definida no `prompt.md` (RF15)
- `docs/`: `architecture.md`, `roadmap.md`, `decisions.md`
