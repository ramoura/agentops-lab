# Golden de referência — case-001-database-timeout

> Saída de referência de `npm run investigate -- "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08"` (stdout, sem cores).
>
> Este arquivo é material de estudo/consulta: o eval **não** compara byte a byte com este texto — o score vem do matching determinístico de `expected_findings`/`must_not_include` e dos critérios estruturais (ver `evals/scoring/scorer.ts`). As durações em "Tools chamadas" (`…ms`) variam a cada execução; todo o restante é determinístico.

```text
Investigação: checkout-api — 2026-07-08T10:00:00-03:00 a 2026-07-08T10:30:00-03:00 (sintoma: erro 5xx)

Resumo executivo
----------------

O serviço checkout-api registrou 88 respostas 5xx em 153 requisições na janela consultada; exception dominante DatabaseTimeoutException; deploy da versão 2026.07.08-1 às 10:03. Hipótese principal (confiança alta): Regressão introduzida no deploy da versão 2026.07.08-1 às 10:03, afetando o fluxo associado a DatabaseTimeoutException.

Evidências encontradas
----------------------

1. 88 respostas 5xx em 153 requisições (57,5%), concentradas em POST /checkout.
   Fonte: get_error_summary (count5xx/byEndpoint[0])
2. Exception mais frequente: DatabaseTimeoutException (80 ocorrências em GET /checkout/status, POST /checkout).
   Fonte: get_top_exceptions (exceptions[0])
3. Log de erro recente: "Timeout while calling payment database" (traceId chk-0267).
   Fonte: get_recent_logs (logs[0], traceId chk-0267)
4. p99 foi de ~451ms (baseline anterior) para ~3190ms na janela do incidente.
   Fonte: get_latency_summary (overall.p99 vs baseline)
5. Deploy da versão 2026.07.08-1 às 10:03 (anterior: 2026.07.07-3).
   Fonte: get_deployment_events (events[0])
6. Runbook relacionado encontrado: "Runbook: checkout-api — alta taxa de 5xx".
   Fonte: get_runbook (knowledge-base/runbooks/checkout-api-high-5xx.md)
7. O runbook orienta, como primeiro passo de verificação: "Verificar o connection pool do banco de pagamentos".
   Fonte: get_runbook (knowledge-base/runbooks/checkout-api-high-5xx.md — Passos de verificação)
8. ADR relacionado: "ADR-001: fluxo de pagamento do checkout".
   Fonte: search_adrs (knowledge-base/adrs/adr-001-checkout-payment-flow.md)
9. Tech spec relacionada: "Tech Spec: checkout-api".
   Fonte: search_tech_specs (knowledge-base/tech-specs/checkout-api.md)

Hipótese principal
------------------

[confiança alta] Regressão introduzida no deploy da versão 2026.07.08-1 às 10:03, afetando o fluxo associado a DatabaseTimeoutException.
   Justificativa: Correlação temporal deploy → pico de erros, exception dominante nos logs e salto de p99 (≥2× o baseline anterior).

Hipóteses alternativas
----------------------

[confiança baixa] Degradação da dependência associada a DatabaseTimeoutException, independente do deploy.
   Justificativa: Erros dessa natureza também ocorrem sem mudança de código; o deploy pode ser coincidência.

Próximos passos seguros
-----------------------

1. Seguir os passos de verificação (somente leitura) do runbook "Runbook: checkout-api — alta taxa de 5xx".
2. Comparar a versão 2026.07.08-1 com a 2026.07.07-3 (diff do deploy).
3. Revisar as mudanças descritas no deploy: Refatoração do acesso ao banco de pagamentos (novas queries no fluxo de checkout).
4. Validar a saúde da dependência relacionada a DatabaseTimeoutException na janela do incidente.
5. Coletar métricas e logs adicionais da janela (somente leitura) antes de qualquer ação de mudança.
6. Avaliar rollback com o time responsável — não executar automaticamente.

Dados faltantes
---------------

Nenhum dado faltante identificado.

Confiança da análise
--------------------

alta

Tools chamadas
--------------

1. get_error_summary {"service":"checkout-api","from":"2026-07-08T10:00:00-03:00","to":"2026-07-08T10:30:00-03:00"}
   → 153 req, 88x 5xx (14ms)
2. get_top_exceptions {"service":"checkout-api","from":"2026-07-08T10:00:00-03:00","to":"2026-07-08T10:30:00-03:00"}
   → 2 exception(s); top: DatabaseTimeoutException (2ms)
3. get_recent_logs {"service":"checkout-api","from":"2026-07-08T10:00:00-03:00","to":"2026-07-08T10:30:00-03:00","level":"ERROR","limit":50}
   → 50/88 logs (truncated: true) (3ms)
4. get_latency_summary {"service":"checkout-api","from":"2026-07-08T10:00:00-03:00","to":"2026-07-08T10:30:00-03:00"}
   → p99 3190ms, 444 req (5ms)
5. get_latency_summary {"service":"checkout-api","from":"2026-07-08T09:30:00-03:00","to":"2026-07-08T10:00:00-03:00"}
   → p99 451ms, 480 req (2ms)
6. get_deployment_events {"service":"checkout-api","from":"2026-07-08T09:45:00-03:00","to":"2026-07-08T10:30:00-03:00"}
   → 1 deploy(s) (3ms)
7. search_runbooks {"query":"checkout-api erro 5xx"}
   → 1 match(es) (6ms)
8. get_runbook {"name":"checkout-api-high-5xx"}
   → encontrado: checkout-api-high-5xx (2ms)
9. search_adrs {"query":"database timeout"}
   → 1 match(es) (3ms)
10. search_tech_specs {"query":"database timeout"}
   → 1 match(es) (2ms)
```
