# Tarefa 2.0: Datasets simulados, knowledge base, skill `investigate-incident` e fake providers (`@agentops/providers`)

## Visão geral

Materializar os três cenários (principal `checkout-api`, secundário `payment-api`, ausência de dados), a knowledge base institucional e a skill canônica de investigação; em seguida implementar `FakeObservabilityProvider` e `FakeKnowledgeProvider`, que leem esses artefatos do filesystem (read-only) e fazem toda a agregação (contagens, percentis por bucket, ranking de busca). Os datasets reais servem de fixtures determinísticas dos testes.

<skills>
### Conformidade com skills

- `desenvolver-mcp-tools` — a tool não lê arquivo direto: toda leitura/agregação fica no provider; vazio explícito ≠ erro; read-only estrito (nenhuma API de escrita importada).
</skills>

<requirements>
- Skill como Markdown com seções objetivo, quando usar, processo (11 passos), regras e saída esperada (RF15).
- Knowledge base mínima: `runbooks/checkout-api-high-5xx.md`, `runbooks/database-timeout.md`, `adrs/adr-001-checkout-payment-flow.md`, `tech-specs/checkout-api.md`, com conteúdo coerente com o cenário (RF18, RF19).
- Cenário principal: `checkout-api`, 2026-07-08T10:00–10:30 BRT, 5xx concentrado em `POST /checkout`, `DatabaseTimeoutException` dominante, deploy às 10:03, p99 ~450ms → ~3200ms (RF20).
- Volume realista com comportamento normal pré-incidente e mistura de níveis de log (RF21); cenário secundário e de ausência de dados para os cases 002/003 (RF22).
- Providers implementam `ObservabilityProvider`/`KnowledgeProvider` de `@agentops/types`, substituíveis por integrações reais sem mudar contrato (RF11); mesma entrada → mesma saída (RF9); consultas sem dados retornam resposta vazia bem definida (RF14).
</requirements>

## Subtarefas

- [x] 2.1 `datasets/logs/checkout-api.jsonl` (~300 linhas, 09:30–10:30), `logs/payment-api.jsonl` (~150 linhas, 14:00–14:20), `metrics/latency.json` (pontos de 1 min por serviço), `deployments/deployments.json`.
- [x] 2.2 `knowledge-base/` com os 4 documentos mínimos (RF18/RF19).
- [x] 2.3 `skills/investigate-incident/skill.md` conforme estrutura do `prompt.md` (RF15).
- [x] 2.4 `packages/providers`: `shared/jsonl.ts` (linha malformada → warning em stderr), `shared/percentiles.ts`, `shared/text-search.ts` (case/acento-insensível, pesos título ×3/headings ×2/corpo ×1, excerpt ≤ 240 chars).
- [x] 2.5 `FakeObservabilityProvider` (agregações, buckets de 5 min, janela `[from, to)`) e `FakeKnowledgeProvider` (busca por tipo, `getRunbook`).
- [x] 2.6 Testes unitários dos dois providers (+ fixtures sintéticas em `__fixtures__/` para casos de borda).

## Detalhes de implementação

Ver techspec: **"Mapeamento datasets → contratos"**, **"Parâmetros e defaults fixados"**, seção do `@agentops/providers` em "Visão dos componentes" e o risco "Percentis com poucos pontos" (documentar a interpolação escolhida).

## Critérios de sucesso

- Os números do cenário principal batem com os exemplos da techspec (ex.: `byEndpoint[0] = POST /checkout`, `DatabaseTimeoutException` no topo, p99 baseline ~450ms vs incidente ~3200ms, deploy 10:03).
- Serviço/período/documento inexistente retorna variante vazia (`hasData: false` / `found: false` / `matches: []`), nunca exceção.
- Nenhuma API de escrita de filesystem importada no pacote.

## Testes da tarefa

Casos da techspec: **15–35**.

### Testes unitários — FakeObservabilityProvider

- [x] 15. `getErrorSummary` do cenário principal: contagens 5xx/4xx corretas, `byEndpoint[0] = POST /checkout`, timeline com pico a partir do bucket 10:05.
- [x] 16. `getErrorSummary` fora da janela do incidente (09:00–09:30) → `hasData: true` com `count5xx` baixo/zero.
- [x] 17. Serviço inexistente → `hasData: false`, zeros, arrays vazios (RF14).
- [x] 18. Janela `[from, to)`: log exatamente em `to` fica de fora; em `from`, dentro.
- [x] 19. `getTopExceptions`: ordenação decrescente por count; `DatabaseTimeoutException` no topo.
- [x] 20. `getTopExceptions` respeita `limit` (limit=1 → 1 item).
- [x] 21. `getRecentLogs` filtra por `level=ERROR`; sem `level` retorna todos os níveis.
- [x] 22. `getRecentLogs` respeita `limit` default 50; `truncated: true` quando `totalMatched > 50`; ordenação decrescente por timestamp.
- [x] 23. `getLatencySummary` janela do incidente: `overall.p99 ≈ 3200`; baseline (09:30–10:00): `p99 ≈ 450`.
- [x] 24. `getLatencySummary` de serviço sem métricas → `overall: null`, `series: []`.
- [x] 25. `getDeploymentEvents` retorna o deploy de 10:03 na janela 09:48–10:30; não retorna na janela 10:10–10:30.
- [x] 26. Linha JSONL malformada na fixture sintética → ignorada com warning em stderr, demais linhas processadas.
- [x] 27. Determinismo: duas chamadas idênticas retornam resultados profundamente iguais (RF9).

### Testes unitários — FakeKnowledgeProvider

- [x] 28. `search('runbooks', 'checkout 5xx')` → `checkout-api-high-5xx` em 1º.
- [x] 29. Busca case/acento-insensível ("TIMEOUT", "conexao").
- [x] 30. Busca sem correspondência → `matches: []`.
- [x] 31. `search` não vaza entre tipos: query de runbook não retorna ADR e vice-versa.
- [x] 32. `limit` respeitado no ranking.
- [x] 33. `getRunbook('checkout-api-high-5xx')` → `found: true`, `content` com o markdown completo.
- [x] 34. `getRunbook('nao-existe')` → `found: false`, campos `null` (nunca exceção).
- [x] 35. `excerpt` limitado a 240 chars e contém o termo buscado.

### Testes de integração

- [ ] N/A nesta tarefa (providers exercitados via MCP na Tarefa 3.0).

## Arquivos relevantes

- `datasets/logs/checkout-api.jsonl`, `logs/payment-api.jsonl`, `metrics/latency.json`, `deployments/deployments.json`
- `knowledge-base/runbooks/checkout-api-high-5xx.md`, `runbooks/database-timeout.md`, `adrs/adr-001-checkout-payment-flow.md`, `tech-specs/checkout-api.md`
- `skills/investigate-incident/skill.md`
- `packages/providers/src/observability/fake-observability-provider.ts`, `knowledge/fake-knowledge-provider.ts`, `shared/jsonl.ts`, `shared/percentiles.ts`, `shared/text-search.ts`
- `packages/providers/src/**/*.test.ts`, `__fixtures__/`
