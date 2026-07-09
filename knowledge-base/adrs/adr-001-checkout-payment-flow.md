# ADR-001: fluxo de pagamento do checkout

- **Status**: aceito
- **Data**: 2026-03-14

## Contexto

O `checkout-api` precisa registrar a intenção de pagamento de forma consistente com o pedido. Avaliamos uma integração assíncrona via fila e uma chamada síncrona ao banco de pagamentos.

## Decisão

O `POST /checkout` faz uma **chamada síncrona ao banco de pagamentos** dentro da mesma transação do pedido, usando o connection pool dedicado `payments`:

- Tamanho do pool: **20 conexões**.
- Timeout de aquisição de conexão: **5000ms**.
- Timeout de query: **3000ms** — estourado, a requisição falha com `DatabaseTimeoutException` (HTTP 500).

## Consequências

- **Positivas**: consistência forte entre pedido e pagamento; sem infraestrutura de mensageria.
- **Negativas**: o banco de pagamentos vira dependência crítica de latência do checkout. Queries lentas seguram conexões do pool e podem derrubar a taxa de sucesso do `POST /checkout` em cascata.
- **Mitigação**: monitorar p99 e uso do pool; toda mudança em queries do fluxo de checkout deve passar por revisão de plano de execução.
