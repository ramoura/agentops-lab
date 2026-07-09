# Skill: investigate-incident

## Objetivo

Investigar incidentes de produção usando logs, métricas, eventos de deploy e documentação técnica (runbooks, ADRs, tech specs), produzindo uma análise estruturada que separa fatos de hipóteses, cita evidências e sugere próximos passos seguros.

## Quando usar

Use quando o usuário mencionar erro, latência, instabilidade, queda, alarme, timeout, exceção ou incidente em um serviço.

## Processo

1. Identificar serviço, período e sintoma a partir da pergunta. Se serviço ou período não puderem ser identificados, informar o que falta e parar — nunca adivinhar.
2. Buscar resumo de erros (`get_error_summary`): volume, taxa de 5xx/4xx, endpoints afetados e timeline do pico.
3. Buscar top exceptions (`get_top_exceptions`): identificar a exception dominante.
4. Buscar logs recentes (`get_recent_logs`, nível ERROR): coletar mensagens e traceIds como evidência concreta.
5. Buscar métricas de latência e volume (`get_latency_summary`): comparar a janela do incidente com o baseline imediatamente anterior de mesma duração.
6. Buscar eventos de deploy (`get_deployment_events`): incluir os 15 minutos anteriores à janela para capturar deploys imediatamente antes do sintoma.
7. Consultar runbook relacionado (`search_runbooks` com serviço + sintoma; depois `get_runbook` no melhor resultado).
8. Consultar ADRs/tech specs quando necessário (`search_adrs` / `search_tech_specs` com termos derivados da exception dominante).
9. Formular hipóteses: correlacionar deploy × exception dominante × salto de latência; propor hipótese principal e alternativas.
10. Separar fatos de suposições: fato é somente o que veio de uma tool, com citação; hipótese fica em seção própria com confiança classificada.
11. Sugerir próximos passos seguros: apenas leitura, comparação e coleta; ações de mudança (ex.: rollback) apenas como avaliação com o time, nunca em primeira posição.

## Regras

- Não inventar dados: todo fato do relatório nasce de uma chamada de tool.
- Sempre citar evidências encontradas (tool + referência do dado).
- Não executar ações destrutivas — as tools são read-only.
- Não recomendar ação perigosa como primeira opção.
- Quando faltar dado, dizer claramente o que falta (seção "Dados faltantes").
- Classificar confiança da hipótese: baixa, média ou alta.

## Saída esperada

- Resumo executivo
- Evidências encontradas
- Hipótese principal
- Hipóteses alternativas
- Próximos passos seguros
- Dados faltantes
- Confiança da análise
