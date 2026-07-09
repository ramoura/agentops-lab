# Tech Spec: checkout-api

## Visão geral

O `checkout-api` orquestra a finalização de compra: valida o carrinho, registra o pedido e grava a intenção de pagamento no banco de pagamentos (ver ADR-001).

## Endpoints

| Endpoint | Descrição |
| --- | --- |
| `POST /checkout` | Finaliza a compra; grava pedido e intenção de pagamento (chamada síncrona ao banco de pagamentos) |
| `GET /checkout/status` | Consulta o status de um checkout em andamento |
| `GET /health` | Health check |

## Dependências

- **Banco de pagamentos** (PostgreSQL): acesso via connection pool `payments` (20 conexões, aquisição 5000ms, query 3000ms).
- **payment-api**: consultado de forma assíncrona para reconciliação (fora do caminho crítico do `POST /checkout`).

## SLOs

- Disponibilidade: 99,9% mensal.
- Latência p99 do `POST /checkout`: **< 800ms** (baseline observado: ~450ms).
- Taxa de erro 5xx: < 0,5% das requisições.

## Modos de falha conhecidos

- Timeout no banco de pagamentos → `DatabaseTimeoutException` (HTTP 500).
- Esgotamento do pool `payments` → `ConnectionPoolExhaustedException` (HTTP 500).
- Falha de validação de entrada → HTTP 400 (não conta para o SLO de 5xx).

## Observabilidade

- Logs estruturados JSONL com `traceId` por requisição.
- Métricas de latência por minuto (p50/p95/p99) e contagem de requisições.
- Eventos de deploy registrados com versão e resumo da mudança.
