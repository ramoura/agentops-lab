# Mini-spec — Trace completo de investigação em disco (JSONL)

> Complementa `techspec-v2.md`/`techspec-v2.5.md`. Substitui a proposta anterior (`mini-spec-eval-run-log.md`,
> descartada): em vez de um log só de score/resumo exclusivo do eval, esta versão registra o **trace completo de cada
investigação** — usado tanto por `npm run investigate` quanto por cada caso do `npm run eval`. Não está numerada no
`docs/roadmap.md`; candidata a um item próprio (ex.: V2.13) quando aprovada — é a infraestrutura que V2.6 (trajectory
> evals), V2.9 (medição de flake) e V2.4/V2.8 (comparação entre modelos/abordagens) já pressupõem.

## Objetivo

Persistir, em **JSON Lines** append-only, o conteúdo integral de cada investigação: pergunta, motor, modelo, resultado
final (`InvestigationOutcome` inteiro — report estruturado ou markdown), a trilha de auditoria completa das tools (RF7)
e, no motor LLM, o histórico rodada a rodada do loop agêntico (o que o modelo pediu, o que voltou de cada tool, uso de
tokens por rodada). Quando o trace nasce de um caso de eval, o próprio registro carrega o score/critérios daquele caso —
**o resultado do eval passa a estar contido no jsonl**, sem precisar de um formato de resumo separado.

O console continua exatamente como hoje (RF27: breakdown por critério em `npm run eval`, relatório em
`npm run investigate`) — o arquivo é um artefato **paralelo e opcional**, para análise posterior (comparar modelos,
depurar uma investigação específica, estudar o comportamento do loop).

## Não-objetivos

- Não altera o comportamento default nem o gate de CI: sem a env de opt-in, zero I/O extra, saída em stdout/stderr
  byte-idêntica à de hoje.
- Não substitui o console do eval (RF27) nem o do `investigate` — o arquivo é aditivo.
- Não constrói dashboard/comparador (`eval:compare`) — fica para depois que houver dado real acumulado (V2.9/V2.10).
- Não versiona os arquivos gerados (`.gitignore`).
- Não tenta recuperar trace de investigações que falharam antes de produzir um outcome (ex.: `api_error`, pergunta que
  não parseia num caso de eval) — fica como possível evolução futura, não é core desta passada.

## Design

### Trigger — opt-in por env, mesmo padrão de `AGENTOPS_LLM_CACHE`/`AGENTOPS_ENGINE`

| Variável             | Default       | Uso                                                                                                                                                                                        |
|----------------------|---------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `AGENTOPS_TRACE_LOG` | — (desligado) | Caminho do arquivo JSONL. Quando definida, **cada investigação bem-sucedida** (via `investigate` ou por caso de `eval`) anexa um registro. Diretório criado recursivamente se não existir. |

```bash
# Uma investigação avulsa
AGENTOPS_TRACE_LOG=evals/runs/trace.jsonl npm run investigate -- --engine=llm "Investigue o checkout-api..."

# Um eval inteiro: 3 registros no mesmo arquivo, um por caso, agrupáveis por runId
AGENTOPS_LLM_MODEL=claude-sonnet-5 AGENTOPS_TRACE_LOG=evals/runs/trace.jsonl npm run eval -- --engine=llm
AGENTOPS_LLM_MODEL=claude-haiku-4-5-20251001 AGENTOPS_TRACE_LOG=evals/runs/trace.jsonl npm run eval -- --engine=llm
```

### Formato do registro — `InvestigationTraceRecord` (novo, `@agentops/types`)

Reaproveita schemas que já existem (`investigationReportSchema`, `toolCallRecordSchema`, `missingFieldSchema`,
`evalCaseResultSchema`) — o trace não duplica shape, só agrega.

```typescript
// packages/types/src/trace.ts (novo módulo, aditivo, exportado em index.ts)

/** Mirror leve dos blocos da Messages API — só o necessário para o trace (sem cache_control). */
export const roundContentBlockSchema = z.union([
    z.object({type: z.literal('text'), text: z.string()}),
    z.object({type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.unknown())}),
]);
export type RoundContentBlock = z.infer<typeof roundContentBlockSchema>;

export const roundToolResultSchema = z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.string(),        // conteúdo EXATO enviado ao modelo (JSON.stringify do resultado, ou a mensagem de erro)
    is_error: z.boolean().optional(),
});

export const roundUsageSchema = z.object({
    input_tokens: z.number().min(0),
    output_tokens: z.number().min(0),
    cache_creation_input_tokens: z.number().min(0),
    cache_read_input_tokens: z.number().min(0),
});

/** Uma rodada do loop agêntico: o que o modelo produziu + o que voltou de tool. */
export const roundTraceSchema = z.object({
    round: z.number().int().min(1),
    assistantContent: z.array(roundContentBlockSchema),
    stopReason: z.string().nullable(),
    usage: roundUsageSchema,
    toolResults: z.array(roundToolResultSchema), // vazio na rodada final (end_turn)
});
export type RoundTrace = z.infer<typeof roundTraceSchema>;

const outcomeTraceSchema = z.discriminatedUnion('kind', [
    z.object({kind: z.literal('report'), report: investigationReportSchema}),
    z.object({kind: z.literal('markdown'), markdown: z.string(), audit: z.array(toolCallRecordSchema)}),
    z.object({kind: z.literal('clarification'), missing: z.array(missingFieldSchema)}),
]);

export const investigationTraceRecordSchema = z.object({
    traceId: z.string().min(1),             // 1 por investigação (timestamp + sufixo curto)
    runId: z.string().min(1),               // agrupa os N traces de uma mesma invocação de eval; == traceId em investigate avulso
    timestamp: z.string().datetime({offset: true}),
    source: z.enum(['investigate', 'eval']),
    caseId: z.string().min(1).nullable(),   // id do caso (evals/cases/*.json); null fora do eval
    question: z.string().min(1),
    engine: engineKindSchema,
    model: z.string().nullable(),           // AGENTOPS_LLM_MODEL resolvido; null no motor deterministic
    outcome: outcomeTraceSchema,            // InvestigationOutcome inteiro — report OU markdown+audit OU clarification
    audit: z.array(toolCallRecordSchema),   // trilha de auditoria (RF7), extraída do outcome para consulta direta
    rounds: z.array(roundTraceSchema).nullable(),  // só motor llm; null no deterministic
    usage: roundUsageSchema.extend({rounds: z.number().min(0)}).nullable(), // agregado (LlmUsage); null no deterministic
    eval: evalCaseResultSchema.nullable(),  // score/critérios do caso; null em investigate avulso
});
export type InvestigationTraceRecord = z.infer<typeof investigationTraceRecordSchema>;
```

```json
{
    "traceId": "2026-07-11T14-32-07-123Z-8f2a",
    "runId": "2026-07-11T14-32-05-901Z-c103",
    "timestamp": "2026-07-11T14:32:07.123Z",
    "source": "eval",
    "caseId": "case-001-database-timeout",
    "question": "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08",
    "engine": "llm",
    "model": "claude-sonnet-5",
    "outcome": {
        "kind": "markdown",
        "markdown": "Resumo executivo\n----------------\n...",
        "audit": [
            {
                "seq": 1,
                "tool": "get_error_summary",
                "params": {
                    "service": "checkout-api",
                    "from": "2026-07-08T10:00:00-03:00",
                    "to": "2026-07-08T10:30:00-03:00"
                },
                "resultSummary": "412 req, 87x 5xx",
                "durationMs": 41
            }
        ]
    },
    "audit": [
        {
            "seq": 1,
            "tool": "get_error_summary",
            "...": "..."
        }
    ],
    "rounds": [
        {
            "round": 1,
            "assistantContent": [
                {
                    "type": "tool_use",
                    "id": "toolu_01",
                    "name": "get_error_summary",
                    "input": {
                        "service": "checkout-api",
                        "from": "2026-07-08T10:00:00-03:00",
                        "to": "2026-07-08T10:30:00-03:00"
                    }
                }
            ],
            "stopReason": "tool_use",
            "usage": {
                "input_tokens": 1800,
                "output_tokens": 120,
                "cache_creation_input_tokens": 6300,
                "cache_read_input_tokens": 0
            },
            "toolResults": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_01",
                    "content": "{\"service\":\"checkout-api\",\"hasData\":true,\"totalRequests\":412,\"count5xx\":87,...}"
                }
            ]
        }
    ],
    "usage": {
        "input_tokens": 9800,
        "output_tokens": 1800,
        "cache_creation_input_tokens": 6300,
        "cache_read_input_tokens": 42100,
        "rounds": 5
    },
    "eval": {
        "caseId": "case-001-database-timeout",
        "score": 1,
        "passed": true,
        "criteria": [
            {
                "name": "finding:DatabaseTimeoutException",
                "passed": true,
                "details": "encontrado no relatório"
            }
        ]
    }
}
```

> **Fidelidade dos dois motores é assimétrica, por desenho, não por limitação**: no motor `llm`, `toolResults[].content`
> é o texto **exato** que foi enviado ao modelo (`JSON.stringify` do resultado da tool, sem compactar — é o dado que
> efetivamente influenciou a resposta, então "todo o conteúdo" vale literalmente aqui). No motor `deterministic`, o`audit`
> continua sendo o resumo curto do RF7 (`resultSummary`, ex.: "412 req, 87x 5xx") — mudar isso tocaria`packages/core`/
`ToolCallRecord`, que o V2 declarou intocado, e o `report` estruturado já carrega o fato extraído (evidências,
> hipóteses) com precisão total; não há por que duplicar o payload bruto do provider ali.

### Captura das rodadas — extensão pontual do loop (`LlmInvestigationAssistant`)

Mesma ideia do `lastUsage` já existente (getter que expõe o estado da última chamada a `investigate()`), não um novo
mecanismo:

```typescript
// packages/llm-engine/src/llm-investigation-assistant.ts
export class LlmInvestigationAssistant implements InvestigationAssistant {
    private trace: RoundTrace[] = [];

    get lastTrace(): RoundTrace[] {
        return this.trace;
    }

    // ...
}
```

Dentro do loop, no ramo `tool_use` (hoje monta `messages` diretamente) e no ramo `end_turn` (retorno final), cada rodada
empurra um `RoundTrace` para `this.trace` — usando exatamente os dados que o loop já tem em mãos (`response.content`,
`response.stop_reason`, `response.usage`, e o `toolResults` que `executeToolUses` já calcula) — **sem** alterar a lógica
do loop, só capturar o que já existe. `cache_control` é descartado ao montar o `RoundTrace` (metadado de infraestrutura
de cache, não conteúdo da investigação).

### Onde monta e grava — novo módulo em `apps/cli-agent` (reuso já existe nessa direção)

`evals/src/runner.ts` já importa `McpToolInvoker`, `renderReport` e `resolveEngineArgs` de `@agentops/cli-agent/*` — o
trace-log segue o mesmo padrão de reuso em vez de virar um workspace novo:

```jsonc
// apps/cli-agent/package.json — novo subpath export
"exports": {
  "./main": "./src/main.ts",
  "./mcp-tool-invoker": "./src/mcp-tool-invoker.ts",
  "./renderer": "./src/renderer.ts",
  "./trace-log": "./src/trace-log.ts"
}
```

```typescript
// apps/cli-agent/src/trace-log.ts (novo)
export function buildTraceRecord(input: {
    source: 'investigate' | 'eval';
    runId: string;
    caseId: string | null;
    question: string;
    engine: EngineKind;
    model: string | null;
    outcome: InvestigationOutcome;
    rounds: RoundTrace[] | null;
    usage: LlmUsage | null;
    evalResult: EvalCaseResult | null;
}): InvestigationTraceRecord;

export function generateRunId(): string;                                  // timestamp + sufixo curto (node:crypto randomUUID)
export async function appendTraceRecord(path: string, record: InvestigationTraceRecord): Promise<void>;
```

`appendTraceRecord`: `mkdir(dirname(path), { recursive: true })` +
`appendFile(path, JSON.stringify(record) + '\n', 'utf8')` — uma linha por chamada, nunca reescreve o arquivo (seguro
para execuções concorrentes/interrompidas). `buildTraceRecord` centraliza a extração de `audit` a partir do `outcome` (
branch por `kind`), evitando duplicar essa lógica entre `main.ts` e `runner.ts`.

### Mudanças nos dois entrypoints

**`apps/cli-agent/src/main.ts`**: lê `AGENTOPS_TRACE_LOG` do env; se definida, depois de obter `outcome` (e só quando
`outcome.kind !== 'clarification'`, já que RF3 não chama tool nenhuma e não há o que tracear além da própria pergunta
ambígua — fora de escopo desta passada), monta e grava um `InvestigationTraceRecord` com `source: 'investigate'`,
`caseId: null`, `runId === traceId` (uma investigação avulsa é seu próprio "run"). Falha ao gravar vira aviso em stderr,
nunca muda o exit code do relatório que já foi impresso.

**`evals/src/runner.ts`**: gera um `runId` uma vez no início de `runEvals()` (todos os casos da mesma execução
compartilham); dentro do loop, depois de calcular `result` (o `EvalCaseResult` do scorer) para cada caso, monta e grava
o trace daquele caso com `source: 'eval'`, `caseId: evalCase.id`, `eval: result`. Mesmo tratamento de falha (aviso em
stderr, não quebra o exit code determinado pelos scores).

Em ambos, `rounds`/`usage` vêm de `llmAssistant?.lastTrace ?? null` / `llmAssistant?.lastUsage ?? null` quando o motor é
`llm` (mesmo padrão do `readLastUsage` que o runner já tem hoje para a linha de cache em stderr).

### `.gitignore`

```diff
 node_modules/
 coverage/
 dist/
 *.log
 .idea/
 *.tsbuildinfo
+evals/runs/
```

## Testes

- `packages/types`: `investigationTraceRecordSchema` aceita um registro válido de cada `outcome.kind` (`report`/
  `markdown`/`clarification`); rejeita `eval.score` fora de `[0,1]` (paridade com o teste existente de
  `evalCaseResultSchema`).
- `apps/cli-agent/src/trace-log.test.ts`: `appendTraceRecord` cria o diretório quando ausente; duas chamadas produzem
  duas linhas, cada uma JSON válido via `investigationTraceRecordSchema.safeParse`; `buildTraceRecord` monta `audit`
  corretamente para os 3 `outcome.kind` (report → `outcome.report.audit`; markdown → `outcome.audit`; clarification →
  `[]`).
- `packages/llm-engine/src/llm-investigation-assistant.test.ts` (extensão dos testes existentes com`FakeAnthropicChat`):
  `lastTrace` tem uma entrada por rodada, na ordem; rodada com `tool_use` tem `toolResults`preenchido e correlacionado
  por `tool_use_id`; rodada final (`end_turn`) tem `toolResults: []`; `cache_control` nunca aparece em
  `assistantContent`/`toolResults` mesmo com `cacheEnabled: true`.
- `evals/src/runner.ts` (unitário, assistant fake — sem custo/rede):
  `runEvals({ engine: 'llm', assistant: fake, traceLogPath })` grava 3 registros (um por caso) com o mesmo `runId` e
  `caseId` correspondente a cada um; sem `traceLogPath` → nenhum arquivo criado (comportamento default inalterado).
- Regressão: suíte default (`npm test`, `npm run eval`/`npm run investigate` sem `AGENTOPS_TRACE_LOG`) permanece
  byte-idêntica em stdout/stderr.

## Consultando os dados depois (fora do escopo de código — só documentação de uso)

```bash
# Reconstruir um eval inteiro (3 casos) por runId
jq -c 'select(.runId == "2026-07-11T14-32-05-901Z-c103")' evals/runs/trace.jsonl

# Score médio por modelo, olhando só os registros que vieram de eval
jq -s '[.[] | select(.eval != null)] | group_by(.model) | map({model: .[0].model, avg: (map(.eval.score) | add / length)})' evals/runs/trace.jsonl

# Quantas rodadas cada investigação usou, por modelo — para comparar eficiência do loop
jq -c 'select(.usage != null) | {model, rounds: .usage.rounds, question}' evals/runs/trace.jsonl
```

## Riscos e cuidados

- **Tamanho do arquivo**: cada registro carrega o relatório/markdown inteiro + rodadas completas — bem maior que a
  proposta anterior (só score). Para o volume deste lab (3 casos de eval, uso manual do `investigate`) é tranquilo; se a
  V2.9 (N execuções repetidas) usar isso pesadamente, rotação/compactação vira pauta própria.
- **`toolResults[].content` sem limite de tamanho**: é o payload exato enviado ao modelo — nos datasets fake atuais é
  pequeno, mas ao evoluir para providers reais (V3) um `get_recent_logs` com `limit` alto pode gerar entradas de trace
  grandes. Vale revisitar truncamento nessa fase, não agora.
- **Investigações que falham não geram trace** (não-objetivo explícito acima): quem quiser depurar um `api_error`/
  `max_rounds_exceeded` ainda depende só da mensagem de erro em stderr — se isso incomodar na prática, é uma extensão
  pequena (gravar trace parcial no `catch`).
- **`rounds`/`usage` dependem do assistant concreto expor `lastTrace`/`lastUsage`**: com um assistant fake injetado nos
  testes sem esses campos, o trace grava `rounds: null`/`usage: null` mesmo em `engine: 'llm'` — mesma limitação
  documentada na proposta anterior, agora também vale para `rounds`.
