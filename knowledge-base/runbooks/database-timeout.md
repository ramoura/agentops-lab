# Runbook: timeout de banco de dados (DatabaseTimeoutException)

## Sintomas

- `DatabaseTimeoutException` nos logs de qualquer serviço que acesse banco relacional.
- Requisições lentas ou abortadas; latência p99 muito acima do baseline.
- Possível efeito cascata: esgotamento do pool de conexões (`ConnectionPoolExhaustedException`).

## Causas comuns

1. **Query nova ou alterada sem índice adequado** — geralmente introduzida por um deploy recente.
2. **Conexões presas**: transação longa segura uma conexão do pool e as demais requisições esperam até estourar o timeout.
3. **Degradação do próprio banco**: CPU alta, lock contention, manutenção ou failover em andamento.
4. **Aumento de tráfego** acima da capacidade do pool de conexões.

## Passos de verificação

1. Identificar a janela do problema e correlacionar com eventos de deploy do serviço afetado.
2. Verificar o uso do pool de conexões (cada conexão presa reduz a capacidade efetiva).
3. Verificar queries lentas no banco durante a janela (logs de `Slow query`).
4. Comparar latência p99 da janela com o baseline imediatamente anterior.

## Ações seguras

- Mapear a query ou transação responsável antes de qualquer intervenção.
- Avaliar rollback do deploy suspeito com o time responsável — não executar automaticamente.
- Nunca reiniciar o banco ou derrubar conexões em produção como primeira opção.
