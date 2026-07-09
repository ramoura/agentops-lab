# Runbook: checkout-api — alta taxa de 5xx

## Sintomas

- Aumento repentino de respostas 5xx no `checkout-api`, tipicamente concentrado no endpoint `POST /checkout`.
- Latência p99 acima de 1000ms (baseline normal: ~450ms).
- Exceptions frequentes: `DatabaseTimeoutException` e `ConnectionPoolExhaustedException`.

## Passos de verificação

1. **Verificar o connection pool do banco de pagamentos**: o pool `payments` tem 20 conexões e timeout de aquisição de 5000ms (ver ADR-001). Uso acima de 90% indica saturação — procurar logs `Connection pool 'payments' usage`.
2. **Verificar deploys recentes**: mudanças em queries, transações ou no acesso ao banco de pagamentos são a causa mais comum de regressão. Comparar a versão atual com a anterior e revisar o diff do fluxo de checkout.
3. **Verificar latência p99**: um salto de p99 simultâneo ao aumento de 5xx indica gargalo de dependência (banco ou gateway), não erro de validação.
4. **Verificar top exceptions**: `DatabaseTimeoutException` aponta para o banco de pagamentos; `ConnectionPoolExhaustedException` indica esgotamento de conexões — as duas juntas sugerem queries lentas segurando o pool.
5. **Verificar o banco de pagamentos**: métricas de CPU, locks e queries lentas na janela do incidente.

## Ações seguras

- Comparar a versão deployada com a anterior (diff de queries e configuração de pool).
- Coletar traces distribuídos da janela para confirmar onde o tempo é gasto.
- Avaliar rollback **com o time responsável** — nunca executar rollback automaticamente.

## Escalonamento

- Time dono: `squad-checkout`. Em caso de indisponibilidade total, acionar o on-call de plataforma.
