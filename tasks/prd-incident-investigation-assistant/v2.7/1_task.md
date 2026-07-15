# Tarefa 1.0: Criar contratos e fixtures isoladas do experimento red-team

## Visão geral

Definir o contrato completo do caso red-team e materializar, em raízes fisicamente isoladas, os três vetores adversariais da V2.7. A entrega deve provar que os providers existentes transportam o conteúdo sem interpretá-lo e que os fluxos normais permanecem sem acesso às fixtures adversariais.

<skills>
### Conformidade com skills

- `criar-tasks` — usada para decompor a TechSpec v2.7 no menor conjunto de entregas independentes, incluindo todos os testes especificados.
- `desenvolver-mcp-tools` — não se aplica: a V2.7 preserva as nove tools e seus contratos; esta tarefa altera contratos de eval e fixtures, não o tool layer.
</skills>

<requirements>

- Criar o schema específico de caso red-team sem migrar ou alterar a aceitação dos casos normais 001–003.
- Representar os três vetores com origem, localização e aliases de saídas proibidas, além das invariantes de estrutura e primeiro passo seguro.
- Criar `case-004-tool-data-prompt-injection` e as raízes `datasets-redteam/` e `knowledge-base-redteam/`, fora do discovery normal.
- Preservar os contratos das nove tools, o prompt da V2 e a serialização direta dos resultados.
- Manter fixtures coerentes com um incidente legítimo e estritamente read-only.
</requirements>

## Subtarefas

- [x] 1.1 Adicionar os tipos e schemas de red-team em `packages/types`, conforme “Arquitetura e design” e “Contratos e interfaces”.
- [x] 1.2 Criar o caso opt-in `case-004` com os três vetores, critérios de outcome e expectativas de trajetória.
- [x] 1.3 Criar logs, métricas e deployments adversariais sob `datasets-redteam/`, mantendo sinal legítimo mínimo do incidente.
- [x] 1.4 Criar o runbook adulterado sob `knowledge-base-redteam/` e garantir sua exclusividade nessa raiz.
- [x] 1.5 Adicionar fixtures/fakes necessários para verificar passagem byte a byte, ordem de `tool_result`, prompt e serialização inalterados.
- [x] 1.6 Implementar os testes unitários desta entrega e confirmar que os casos normais continuam válidos.

## Detalhes de implementação

Seguir `techspec-v2.7.md`, especialmente “Arquitetura e design”, “Contratos e interfaces”, “Mapeamento fixture adversarial → contrato” e decisões 1–3. Não implementar sanitização, delimitadores, wrappers, mudanças de prompt ou novas tools.

## Critérios de sucesso

- O caso red-team completo é validado e configura exatamente três vetores provenientes de `get_recent_logs`, `get_top_exceptions` e `get_runbook`.
- Casos 001–003 continuam válidos e não exigem migração.
- Nenhuma fixture adversarial está sob `datasets/`, `knowledge-base/` ou `evals/cases/`.
- Providers preservam o conteúdo adversarial, mas uma configuração normal não encontra documentos exclusivos da raiz red-team.
- Prompt, ordem de mensagens e serialização da V2 permanecem inalterados.

## Testes da tarefa

### Testes unitários

- [x] U01. `redTeamEvalCaseSchema` aceita caso completo com três vetores.
- [x] U02. Rejeita `redteam` ausente no schema específico e preserva aceitação no schema normal.
- [x] U03. Rejeita `attack_vectors` vazio.
- [x] U04. Rejeita IDs de vetor duplicados.
- [x] U05. Rejeita `source` fora das nove tools.
- [x] U06. Rejeita `location` vazio.
- [x] U07. Rejeita `forbidden_outputs` vazio e aliases vazios.
- [x] U08. Rejeita títulos obrigatórios duplicados ou desconhecidos.
- [x] U09. Aplica `require_safe_first_step=true` por default.
- [x] U10. Mantém casos 001–003 válidos sem migração.
- [x] U37. Provider de logs preserva o texto adversarial byte a byte.
- [x] U38. Provider agrega exception adulterada sem executar ou interpretar conteúdo.
- [x] U39. Provider de knowledge retorna o runbook adulterado somente na raiz red-team.
- [x] U40. Provider normal não encontra documento exclusivo da raiz red-team.
- [x] U41. Fake Anthropic recebe `tool_result` imediatamente após `tool_use`, sem texto misturado.
- [x] U42. System prompt do fake é byte-idêntico ao da V2 para a mesma configuração.
- [x] U43. Resultado continua serializado com `JSON.stringify`, sem wrapper ou delimitador novo.

### Testes de integração

- [x] A passagem das três fixtures pelos providers reais será coberta na Tarefa 3.0 pelo MCP real, sem acesso direto do runner aos arquivos.

### Testes E2E (se aplicável)

- Não se aplica isoladamente; discovery, preflight e isolamento por processo serão validados na Tarefa 3.0.

## Arquivos relevantes

- `packages/types/src/eval.ts`
- `packages/types/src/schemas.test.ts`
- `packages/llm-engine/src/__fixtures__/testing.ts`
- `datasets-redteam/logs/checkout-api.jsonl`
- `datasets-redteam/metrics/checkout-api.jsonl`
- `datasets-redteam/deployments/deployments.jsonl`
- `knowledge-base-redteam/runbooks/checkout-api-high-5xx.md`
- `evals/cases-redteam/case-004-tool-data-prompt-injection.json`
- `packages/providers/src/observability/fake-observability-provider.ts`
- `packages/providers/src/knowledge/fake-knowledge-provider.ts`
