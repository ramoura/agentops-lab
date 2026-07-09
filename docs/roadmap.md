# Roadmap — AgentOps Lab

A v1 é 100% local, determinística e read-only; a V2 (motor LLM) está **entregue**. As fases abaixo são direção de evolução — a arquitetura atual foi desenhada para suportá-las **sem reestruturação** (interfaces estáveis de provider, contratos únicos em `types`, superfícies dos SDKs MCP e Anthropic isoladas em arquivos únicos).

## Migração do SDK MCP v1.x → v2 (exercício de estudo)

O projeto usa o SDK oficial `@modelcontextprotocol/sdk` **v1.x** (release estável). O v2 (pacotes `@modelcontextprotocol/server` / `@modelcontextprotocol/client`) traz breaking changes conhecidos. A migração é um exercício de estudo planejado e **localizado por design**: a superfície de contato com o SDK está isolada em

- `mcp-servers/agentops-server/src/server-factory.ts` (+ registro das tools) — lado server;
- `apps/cli-agent/src/mcp-tool-invoker.ts` — lado client.

Nenhum outro pacote importa o SDK. O eval harness serve de rede de segurança da migração: `npm run eval` deve permanecer com case-001 em 100% antes e depois.

## V2 — Motor LLM reutilizando as mesmas MCP tools ✅ (entregue)

Especificação: [`techspec-v2.md`](../tasks/prd-incident-investigation-assistant/techspec-v2.md).

- **Entregue**: `LlmInvestigationAssistant` (`packages/llm-engine`) com loop agêntico manual sobre a Messages API da Anthropic, consumindo as **mesmas 9 tools MCP** descobertas em runtime via `listTools()` (nenhuma mudança em server/providers/datasets). Em vez de forçar a interface `InvestigationEngine` (que exige contexto parseado e report estruturado), a V2 introduziu a abstração `InvestigationAssistant` (pergunta crua → `InvestigationOutcome`), com o caminho da V1 preservado byte-idêntico atrás do adapter `DeterministicInvestigationAssistant`.
- **Entregue**: a skill `investigate-incident` passou de "processo espelhado em código" a **contexto do modelo** (system prompt com contrato de formato + guardrails).
- **Entregue**: seleção de engine por `--engine=deterministic|llm` + env `AGENTOPS_ENGINE` na CLI e no eval, com o determinístico como default sem API key; `npm run eval:llm` como smoke opt-in.
- **Entregue**: scoring do modo llm 100% determinístico via `TextReportScorer` (mesmos 5 grupos de critérios sobre as seções do markdown), com o scorer da V1 intocado.

## V2.1 — Evoluções incrementais do motor LLM

Experimentos que reutilizam os contratos existentes (`InvestigationAssistant`, `ToolInvoker`, `InvestigationOutcome`, eval harness) — nenhum exige reestruturação; cada um vira um novo `--engine=<kind>` ou um ajuste localizado.

### V2.1 — Tolerância de fraseado no scorer

Pendência assumida da V2 (descartada de propósito naquela fase): tolerância de sinônimos/fraseado nos `expected_findings` do modo llm e, se a taxa de flake incomodar, um segundo scorer. Motivação concreta observada na validação da V2: o case-003 reprovou com o modelo escrevendo "Não há registros de erro" em vez do termo literal `Sem registros` — comportamento correto, fraseado diferente (risco documentado na techspec-v2, "Riscos conhecidos").

### V2.2 — Motor via Tool Runner do SDK (`--engine=tool-runner`)

Substituir o loop agêntico manual pelo `client.beta.messages.toolRunner()` do `@anthropic-ai/sdk`, atrás da mesma interface `InvestigationAssistant` e consumindo as mesmas 9 tools MCP via `McpToolInvoker`.

- **Pergunta de AgentOps**: o que se perde e o que se ganha ao delegar o loop ao SDK? Comparar lado a lado com o harness manual da V2 — visibilidade por rodada, auditoria (RF7) via hooks por turno em vez de decorator próprio, tratamento de falha de tool, contagem de tokens, manutenção frente à evolução da API (ex.: a remoção do `temperature` que quebrou a V2 em runtime).
- **Custo de montar**: baixo — CLI, eval e scorer não mudam; é um novo assistant + mapeamento das definições MCP para o formato de tool do runner.
- **Risco**: o tool runner é superfície beta do SDK; a auditoria deixa de ser garantia estrutural e passa a depender dos hooks expostos.

### V2.3 — Motor via Claude Agent SDK, com API key e com assinatura

Terceiro adapter (`AgentSdkInvestigationAssistant`) usando o `@anthropic-ai/claude-agent-sdk` (Claude Code como biblioteca): `query()` com o `agentops-server` registrado como MCP server, tools embutidas de filesystem/bash **desabilitadas** (preserva a garantia read-only — o agente só enxerga as 9 tools do lab) e a skill como system prompt.

- **Pergunta de AgentOps**: comparar o harness do Claude Code (loop, gestão de contexto, permissões prontos) com o harness manual da V2 sobre as mesmas tools e o mesmo eval. É exatamente estudar o que a V2 decidiu não esconder.
- **Duas variantes de autenticação**:
  - **API key** (`ANTHROPIC_API_KEY`): cobrança por token, sem restrição de uso; serve para o eval e para comparação justa com a V2.
  - **Assinatura Claude Pro/Max** (login do Claude Code / `claude setup-token`): a Messages API **não** aceita assinatura — o Agent SDK é o único caminho para usar a cota da assinatura neste lab. Restrições a documentar: termos de uso permitem apenas uso pessoal/interativo (CI e automação exigem API), rate limits compartilhados com o uso interativo do Claude Code (janelas de 5h + limites semanais), e menos controle de modelo/parâmetros.
- **Trade-off central** (registrado em [`decisions.md`](./decisions.md) D9): o loop deixa de ser visível — rodadas, tool_use/tool_result e auditoria passam a depender dos hooks do Agent SDK; o audit log estrutural (RF7) precisa ser reimplementado sobre esses hooks e validado pelo eval.
- **Custo/benefício**: como substituto da API não compensa (uma investigação da V2 custa centavos — ~57k tokens de entrada); como experimento de comparação de harnesses, é a pergunta mais interessante do roadmap V2.x.

### V2.4 — Provedores alternativos: OpenRouter / OpenAI (adapter OpenAI-compatible)

Quarto adapter atrás da mesma interface `InvestigationAssistant`, falando o dialeto **OpenAI-compatible** (`chat/completions`). Um único adapter cobre OpenRouter, OpenAI e dezenas de provedores (Groq, Together, Ollama local…) — muda só `baseURL` + key; o OpenRouter inclusive serve os próprios modelos Claude por essa via. Seleção por `AGENTOPS_LLM_PROVIDER=anthropic|openrouter|openai` + `AGENTOPS_LLM_MODEL`, mantendo Anthropic como default.

- **O que muda**: o loop da V2 é anthropic-shaped — blocos `tool_use`/`tool_result` viram `tool_calls[]` + mensagens `role: "tool"` com `tool_call_id`; `stop_reason` vira `finish_reason`; schema de tool ganha o envelope `{type: "function", function: {...}}`; `system` vira mensagem `role: "system"`. Caminho recomendado: novo workspace `packages/openai-engine` espelhando o padrão do `llm-engine` (porta fina `OpenAiChatPort` + fake nos testes, zero tokens na suíte default). O mapeamento MCP → tools continua passthrough (ambos usam JSON Schema).
- **O que não muda**: server/tools MCP, `McpToolInvoker`, audit log, skill, contrato de formato, `TextReportScorer`, eval e CLI (além da seleção de provider).
- **Pergunta de AgentOps (o benefício real)**: transformar o lab numa **bancada de comparação de modelos** — mesmos 3 casos, mesmas tools, mesmo scorer determinístico, medindo por modelo: aderência ao contrato de formato, citação de fontes, segurança dos próximos passos, rodadas e tokens gastos. Economia é secundária: a investigação típica custa centavos no `claude-sonnet-5`; modelos abertos via OpenRouter (DeepSeek, Qwen, Llama) custam 10–50× menos, com taxa de ~5% na compra de créditos.
- **Riscos**: qualidade de tool calling varia muito entre modelos (o `TextReportScorer` existe para acusar isso); dois dialetos de API para manter frente a upstreams que evoluem (o caso do `temperature` da V2 aconteceria em dobro); prompt caching difere por provedor (explícito na Anthropic, automático na OpenAI, dependente do provedor no OpenRouter) — relevante porque o loop reenvia o histórico a cada rodada; OpenRouter adiciona um terceiro na cadeia de dados.
- **Registrar em `decisions.md`**: adapter dedicado por dialeto (em vez de generalizar a porta da V2 para um formato neutro) e o trade-off assumido.

## V3 — Providers reais de observabilidade

- Implementar `ObservabilityProvider` para CloudWatch, Splunk, Prometheus e/ou OpenTelemetry — **sem tocar no contrato das tools** (RF11).
- Knowledge base real: repositório de runbooks/ADRs da organização (git) atrás de `KnowledgeProvider`.
- Credenciais de menor privilégio (somente leitura), validação de host/escopo, e seleção de provider por configuração do server.
- Datasets fake permanecem como fixtures dos testes e dos evals.

## V4 — Tracing, policies e governança

- Exportar o audit log como spans OpenTelemetry (`ToolCallRecord.durationMs` já existe nos contratos).
- Policies declarativas de acesso por tool (que serviços/janelas podem ser consultados) e rate limiting.
- Audit log persistente (arquivo/banco) com correlação por investigação.
- Hardening: sandboxing do server, allowlist de diretórios dos providers de filesystem.

## V5 — Interfaces adicionais

- Integração com Slack (perguntas no canal de incidente) e/ou Jira (anexar relatório ao ticket), se fizer sentido.
- UI web de leitura dos relatórios e do histórico de investigações.
- Catálogo maior de cenários simulados e de casos de eval.
