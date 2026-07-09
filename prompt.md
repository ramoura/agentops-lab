Você é um arquiteto de software sênior, Staff Engineer, especialista em agentes de IA, MCP, observabilidade, engenharia de contexto, segurança e Developer Experience.

Quero que você desenvolva uma PoC chamada:

# AgentOps Lab — Incident Investigation Assistant

## Visão geral

Esta PoC deve demonstrar um agente de investigação de incidentes capaz de analisar um problema operacional usando logs, métricas, eventos de deploy, runbooks, ADRs e tech specs.

O objetivo não é apenas criar um MCP server simples. O objetivo é construir uma base moderna para estudar:

* MCP
* Skills
* Context Engineering
* Agentic Workflows
* Observability
* Incident Investigation
* Eval Harness
* Segurança read-only
* Auditabilidade
* Operação confiável de agentes

A PoC deve começar com dados fake/simulados e depois permitir fácil evolução para integrações reais com CloudWatch, Splunk, Prometheus ou OpenTelemetry.

---

# Problema que a PoC deve resolver

O usuário deve conseguir fazer uma pergunta como:

> Investigue por que o `checkout-api` teve aumento de erro 5xx hoje entre 10h e 10h30.

O agente deve:

1. Entender o serviço afetado.
2. Entender a janela de tempo.
3. Buscar resumo de erros.
4. Buscar top exceptions.
5. Buscar logs recentes.
6. Buscar métricas de latência e volume.
7. Buscar eventos de deploy.
8. Consultar runbooks.
9. Consultar ADRs/tech specs quando útil.
10. Formular hipóteses.
11. Separar fatos de suposições.
12. Citar evidências.
13. Sugerir próximos passos seguros.
14. Não executar nenhuma ação destrutiva.
15. Ser avaliado por um pequeno Eval Harness.

---

# Escopo da primeira versão

Crie um MVP funcional, simples e bem estruturado.

## Deve conter

* Projeto em Node.js + TypeScript.
* Um CLI simples para conversar com o agente ou rodar uma investigação.
* Dados fake em JSON/JSONL.
* Um “MCP-like tool layer” ou MCP server real, dependendo do que for mais viável no contexto do projeto.
* Tools read-only para consultar dados.
* Base de conhecimento em Markdown.
* Uma skill chamada `investigate-incident`.
* Um Eval Harness simples com casos de teste.
* Documentação clara no README.
* Estrutura preparada para evolução futura.

## Não deve conter na primeira versão

* Auto-healing.
* Reinício de serviços.
* Rollback automático.
* Escrita em sistemas externos.
* Dependência obrigatória de AWS, Splunk ou Prometheus real.
* UI complexa.
* Banco vetorial obrigatório.
* Infraestrutura cloud obrigatória.

---

# Arquitetura esperada

Estruture o projeto aproximadamente assim:

```text
agentops-lab/
  apps/
    cli-agent/
  mcp-servers/
    observability-server/
    knowledge-server/
  skills/
    investigate-incident/
  knowledge-base/
    runbooks/
    adrs/
    tech-specs/
    incidents/
  datasets/
    logs/
    metrics/
    deployments/
  evals/
    cases/
    expected-answers/
    scoring/
  packages/
    core/
    providers/
    types/
  docs/
    architecture.md
    roadmap.md
    decisions.md
  README.md
  package.json
  tsconfig.json
```

Se você achar uma estrutura melhor, pode propor, mas explique a decisão.

---

# Dados simulados

Crie um cenário fake de incidente envolvendo:

* Serviço: `checkout-api`
* Janela: `2026-07-08T10:00:00-03:00` até `2026-07-08T10:30:00-03:00`
* Sintoma: aumento de erro 5xx
* Exception principal: `DatabaseTimeoutException`
* Endpoint afetado: `POST /checkout`
* Deploy próximo ao início do problema: `2026-07-08T10:03:00-03:00`
* Latência p99 aumentando de algo como `450ms` para `3200ms`
* Hipótese provável: mudança recente aumentou tempo de acesso ao banco ou piorou uso do connection pool

Exemplo de log:

```json
{
  "timestamp": "2026-07-08T10:07:12-03:00",
  "service": "checkout-api",
  "level": "ERROR",
  "traceId": "abc-123",
  "endpoint": "POST /checkout",
  "exception": "DatabaseTimeoutException",
  "message": "Timeout while calling payment database"
}
```

Crie quantidade suficiente de dados para a investigação parecer realista, mas sem exagerar.

---

# Tools esperadas

Implemente tools read-only como:

```text
get_error_summary(service, from, to)
get_top_exceptions(service, from, to)
get_recent_logs(service, level, from, to)
get_latency_summary(service, from, to)
get_deployment_events(service, from, to)
search_runbooks(query)
get_runbook(name)
search_adrs(query)
search_tech_specs(query)
```

Cada tool deve retornar dados estruturados e previsíveis.

Evite fazer tudo diretamente no prompt do agente. A investigação deve passar pelas tools.

---

# Skill: investigate-incident

Crie um arquivo:

```text
skills/investigate-incident/skill.md
```

A skill deve conter:

```markdown
# Skill: investigate-incident

## Objetivo
Investigar incidentes de produção usando logs, métricas, eventos de deploy e documentação técnica.

## Quando usar
Use quando o usuário mencionar erro, latência, instabilidade, queda, alarme, timeout, exceção ou incidente.

## Processo
1. Identificar serviço, período e sintoma.
2. Buscar resumo de erros.
3. Buscar top exceptions.
4. Buscar logs recentes.
5. Buscar métricas de latência e volume.
6. Buscar eventos de deploy.
7. Consultar runbook relacionado.
8. Consultar ADRs/tech specs quando necessário.
9. Formular hipóteses.
10. Separar fatos de suposições.
11. Sugerir próximos passos seguros.

## Regras
- Não inventar dados.
- Sempre citar evidências encontradas.
- Não executar ações destrutivas.
- Não recomendar ação perigosa como primeira opção.
- Quando faltar dado, dizer claramente o que falta.
- Classificar confiança da hipótese: baixa, média ou alta.

## Saída esperada
- Resumo executivo
- Evidências encontradas
- Hipótese principal
- Hipóteses alternativas
- Próximos passos seguros
- Dados faltantes
- Confiança da análise
```

---

# Knowledge base

Crie arquivos Markdown em:

```text
knowledge-base/runbooks/
knowledge-base/adrs/
knowledge-base/tech-specs/
```

Inclua pelo menos:

```text
runbooks/checkout-api-high-5xx.md
runbooks/database-timeout.md
adrs/adr-001-checkout-payment-flow.md
tech-specs/checkout-api.md
```

O conteúdo pode ser fake, mas deve ser coerente.

---

# Comportamento esperado do agente

Quando eu executar algo como:

```bash
npm run investigate -- "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08"
```

A saída esperada deve ser parecida com:

```text
Resumo executivo:
O checkout-api apresentou aumento de erros 5xx a partir de 10h07, principalmente no endpoint POST /checkout.

Evidências:
- A exception mais frequente foi DatabaseTimeoutException.
- A latência p99 subiu de aproximadamente 450ms para 3200ms.
- Houve deploy às 10h03, poucos minutos antes do aumento de erros.
- Os erros estão concentrados no endpoint POST /checkout.
- O runbook checkout-api-high-5xx indica verificar pool de conexão e mudanças recentes em chamadas ao banco.

Hipótese principal:
A causa provável é uma regressão introduzida no deploy das 10h03, afetando o acesso ao banco ou o uso do connection pool.

Confiança:
Média/Alta.

Próximos passos seguros:
1. Comparar a versão atual com a versão anterior.
2. Verificar alterações relacionadas a queries, transações ou connection pool.
3. Validar métricas do banco durante a janela do incidente.
4. Avaliar rollback, mas não executar automaticamente.
5. Coletar traces para confirmar onde o tempo está sendo gasto.

Dados faltantes:
- Métricas reais do banco.
- Traces distribuídos.
- Diff do deploy.
```

---

# Eval Harness

Crie uma pasta:

```text
evals/
  cases/
  expected-answers/
  scoring/
```

Crie pelo menos 3 casos:

```text
case-001-database-timeout.json
case-002-payment-api-timeout.json
case-003-missing-data.json
```

Cada caso deve conter:

```json
{
  "id": "case-001",
  "question": "Investigue o aumento de erro no checkout-api entre 10h e 10h30 em 2026-07-08.",
  "expected_findings": [
    "DatabaseTimeoutException",
    "latência p99 aumentou",
    "deploy ocorreu antes do aumento",
    "endpoint POST /checkout afetado"
  ],
  "must_not_include": [
    "certeza absoluta",
    "ação destrutiva",
    "reiniciar produção automaticamente",
    "inventar serviço inexistente"
  ]
}
```

Implemente um comando:

```bash
npm run eval
```

Ele deve executar os casos e gerar um score simples baseado em:

* Achou os findings esperados.
* Não incluiu termos proibidos.
* Citou evidências.
* Separou hipótese de fato.
* Sugeriu próximos passos seguros.

Não precisa ser perfeito. O objetivo é demonstrar o conceito.

---

# Requisitos de segurança

A PoC deve seguir estes princípios:

1. Todas as tools são read-only.
2. Nenhuma tool executa comando destrutivo.
3. O agente não deve sugerir ação arriscada como primeira resposta.
4. O agente deve dizer quando não tem dados suficientes.
5. O agente deve registrar quais tools foram chamadas.
6. O agente deve separar evidência de hipótese.
7. O agente deve evitar alucinação.

---

# Documentação obrigatória

Crie um bom `README.md` explicando:

* O que é a PoC.
* Qual problema ela resolve.
* Como instalar.
* Como executar.
* Como rodar investigação.
* Como rodar evals.
* Como adicionar novo dataset.
* Como adicionar nova skill.
* Como adicionar nova tool.
* Como evoluir para CloudWatch/Splunk/Prometheus real.

Crie também:

```text
docs/architecture.md
docs/roadmap.md
docs/decisions.md
```

---

# Qualidade esperada

Quero código limpo, simples e didático.

Use boas práticas de TypeScript:

* Tipos explícitos.
* Separação entre domínio, providers e CLI.
* Funções pequenas.
* Baixo acoplamento.
* Fácil substituição de fake providers por providers reais.
* Sem overengineering.
* Sem frameworks desnecessários.

---

# Estratégia de execução

Antes de codar, faça:

1. Leia este prompt inteiro.
2. Explique rapidamente sua interpretação.
3. Proponha a estrutura final de pastas.
4. Liste os arquivos que serão criados.
5. Depois implemente.

Durante a implementação:

1. Comece pelo core e tipos.
2. Depois datasets fake.
3. Depois providers.
4. Depois tools.
5. Depois skill e knowledge base.
6. Depois CLI.
7. Depois eval harness.
8. Depois documentação.
9. Por fim, rode os testes/comandos possíveis e corrija erros.

---

# Resultado final esperado

Ao final, quero conseguir clonar/abrir o projeto e executar:

```bash
npm install
npm run investigate -- "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08"
npm run eval
```

E quero que a PoC demonstre claramente este conceito:

```text
MCP/tools para acessar sistemas
+ Skills para padronizar investigação
+ Knowledge base para contexto
+ Eval Harness para confiabilidade
+ Segurança read-only para operação real
```

Trate essa PoC como uma base de estudo séria para o futuro da engenharia de software com agentes de IA.
