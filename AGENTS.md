# AGENTS.md — AgentOps Lab

> Guia base para agentes de IA (e humanos) que forem trabalhar neste repositório.
> Este arquivo descreve **o que é o projeto, como ele deve ser estruturado e quais
> regras devem ser seguidas**.
---

## 1. O que é este projeto

**AgentOps Lab — Incident Investigation Assistant** é uma PoC que demonstra um
agente de investigação de incidentes de produção. O agente analisa um problema
operacional combinando **logs, métricas, eventos de deploy, runbooks, ADRs e tech
specs** para formular hipóteses de causa raiz e sugerir próximos passos seguros.

A PoC serve como base de estudo séria para os seguintes temas:

- MCP (Model Context Protocol)
- Skills
- Context Engineering
- Agentic Workflows
- Observability
- Incident Investigation
- Eval Harness
- Segurança read-only
- Auditabilidade
- Operação confiável de agentes

O projeto começa com **dados fake/simulados** e deve permitir evolução fácil para
integrações reais (CloudWatch, Splunk, Prometheus, OpenTelemetry).

> A especificação completa e canônica do projeto está em [`prompt.md`](./prompt.md).
> Em caso de dúvida ou conflito, **`prompt.md` é a fonte da verdade**.

---

## 2. Problema resolvido

O usuário faz uma pergunta em linguagem natural, por exemplo:

> Investigue por que o `checkout-api` teve aumento de erro 5xx hoje entre 10h e 10h30.

O agente deve, de forma orquestrada e auditável:

1. Entender o serviço afetado.
2. Entender a janela de tempo.
3. Buscar resumo de erros, top exceptions e logs recentes.
4. Buscar métricas de latência e volume.
5. Buscar eventos de deploy.
6. Consultar runbooks, ADRs e tech specs quando útil.
7. Formular hipóteses, **separando fatos de suposições**.
8. Citar evidências.
9. Sugerir próximos passos **seguros** (nunca ações destrutivas).
10. Ser avaliado por um Eval Harness.

---

## 3. Stack e princípios técnicos

- **Node.js + TypeScript**.
- Tipos explícitos; sem `any` desnecessário.
- Separação clara entre **domínio (core)**, **providers** e **CLI**.
- Funções pequenas, baixo acoplamento, alta coesão.
- Fácil substituição de *fake providers* por *providers reais* (interface estável).
- **Sem overengineering**, sem frameworks desnecessários, sem banco vetorial
  obrigatório, sem infraestrutura cloud obrigatória.
- Código limpo e **didático** — este é um laboratório de estudo.

---

## 4. Estrutura de pastas pretendida

> Estrutura-alvo. Ainda **não** implementada. Ajustes são permitidos desde que a
> decisão seja registrada em `docs/decisions.md`.

```text
agentops-lab/
  apps/
    cli-agent/               # CLI para conversar com o agente / rodar investigação
  mcp-servers/
    observability-server/    # tools de logs/métricas/deploys
    knowledge-server/        # tools de runbooks/ADRs/tech specs
  skills/
    investigate-incident/    # skill.md com o processo de investigação
  knowledge-base/
    runbooks/
    adrs/
    tech-specs/
    incidents/
  datasets/
    logs/                    # dados fake (JSON/JSONL)
    metrics/
    deployments/
  evals/
    cases/                   # casos de teste
    expected-answers/
    scoring/                 # lógica de pontuação
  packages/
    core/                    # domínio / orquestração
    providers/               # fake providers (e futuros reais)
    types/                   # tipos compartilhados
  docs/
    architecture.md
    roadmap.md
    decisions.md
  README.md
  package.json
  tsconfig.json
```

---

## 5. Tools esperadas (todas read-only)

As tools retornam **dados estruturados e previsíveis**. A investigação passa
**pelas tools**, não diretamente pelo prompt do agente.

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

### Como adicionar uma nova tool

1. Defina os tipos de entrada/saída em `packages/types`.
2. Implemente a leitura no provider correspondente (`packages/providers`).
3. Exponha a tool no MCP server adequado (observability ou knowledge).
4. Garanta que ela seja **read-only** e determinística sobre os dados fake.
5. Adicione/atualize casos no Eval Harness se ela mudar o comportamento esperado.

---

## 6. Skill: `investigate-incident`

Arquivo canônico: `skills/investigate-incident/skill.md`.

A skill padroniza o **processo de investigação**: identificar serviço/período/sintoma,
coletar evidências via tools, consultar knowledge base, formular hipóteses,
separar fato de suposição, classificar confiança (baixa/média/alta) e sugerir
próximos passos seguros.

**Saída esperada do agente:**

- Resumo executivo
- Evidências encontradas (com citação)
- Hipótese principal
- Hipóteses alternativas
- Próximos passos seguros
- Dados faltantes
- Confiança da análise

---

## 7. Regras de segurança (obrigatórias)

Estas regras são **inegociáveis** para qualquer agente ou código neste repositório:

1. **Todas as tools são read-only.** Nenhuma tool executa comando destrutivo.
2. O agente **não** sugere ação arriscada como primeira resposta.
3. Rollback, restart e afins podem ser **mencionados como sugestão**, nunca executados.
4. O agente diz claramente **quando não tem dados suficientes**.
5. O agente **registra quais tools foram chamadas** (auditabilidade).
6. O agente **separa evidência de hipótese**.
7. O agente **evita alucinação** — não inventa serviços, dados ou métricas.

### O que NÃO deve existir na primeira versão

Auto-healing · restart de serviços · rollback automático · escrita em sistemas
externos · dependência obrigatória de AWS/Splunk/Prometheus real · UI complexa ·
banco vetorial obrigatório · infraestrutura cloud obrigatória.

---

## 8. Cenário fake de referência

Usado como caso principal de demonstração e nos evals:

- **Serviço:** `checkout-api`
- **Janela:** `2026-07-08T10:00:00-03:00` → `2026-07-08T10:30:00-03:00`
- **Sintoma:** aumento de erro 5xx
- **Exception principal:** `DatabaseTimeoutException`
- **Endpoint afetado:** `POST /checkout`
- **Deploy suspeito:** `2026-07-08T10:03:00-03:00`
- **Latência p99:** subindo de ~`450ms` para ~`3200ms`
- **Hipótese provável:** regressão no deploy afetando acesso ao banco / connection pool

### Como adicionar um novo dataset

1. Adicione os arquivos em `datasets/{logs,metrics,deployments}` (JSON/JSONL).
2. Mantenha o schema consistente com os tipos em `packages/types`.
3. Garanta coerência temporal e de serviço entre logs, métricas e deploys.
4. Se for um novo incidente, considere adicionar um caso no Eval Harness.

---

## 9. Eval Harness

Localização: `evals/` (`cases/`, `expected-answers/`, `scoring/`).

Cada caso define `expected_findings` e `must_not_include`. O score é simples e
baseado em:

- Encontrou os findings esperados.
- Não incluiu termos proibidos.
- Citou evidências.
- Separou hipótese de fato.
- Sugeriu próximos passos seguros.

Casos mínimos:

```text
case-001-database-timeout.json
case-002-payment-api-timeout.json
case-003-missing-data.json
```

---

## 10. Comandos previstos

```bash
npm install
npm run investigate -- "Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08"
npm run eval
```

> Estes comandos ainda **não** existem — são o alvo da implementação.

---

## 11. Ordem de implementação recomendada

1. Core e tipos (`packages/core`, `packages/types`).
2. Datasets fake (`datasets/`).
3. Providers (`packages/providers`).
4. Tools (`mcp-servers/`).
5. Skill e knowledge base (`skills/`, `knowledge-base/`).
6. CLI (`apps/cli-agent`).
7. Eval Harness (`evals/`).
8. Documentação (`README.md`, `docs/`).
9. Rodar comandos possíveis e corrigir erros.

---

## 12. Convenções para agentes de IA

- Antes de implementar, **leia `prompt.md` inteiro** — ele é a especificação canônica.
- Registre decisões arquiteturais relevantes em `docs/decisions.md`.
- Prefira interfaces estáveis que permitam trocar fake providers por reais.
- Nunca introduza escrita em sistemas externos ou ações destrutivas.
- Mantenha a saída do agente no formato definido pela skill `investigate-incident`.
- Ao concluir uma etapa, valide com o Eval Harness quando aplicável.

---

## 13. Conceito central da PoC

```text
MCP/tools para acessar sistemas
+ Skills para padronizar investigação
+ Knowledge base para contexto
+ Eval Harness para confiabilidade
+ Segurança read-only para operação real
```
