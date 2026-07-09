# Checklist de Tool / MCP Server — AgentOps Lab

Percorra este checklist ao final de **cada** tool ou MCP server. Não considere a tool
pronta sem ele. Baseado em padrões de mercado de MCP e no guia da Anthropic
"writing tools for agents".

---

## 1. Escopo e localização

- [ ] A tool é realmente necessária para investigar incidentes? (se não → não crie)
- [ ] Não existe outra tool que já faça isso (sem sobreposição/duplicação)
- [ ] Está no server certo:
  - `observability-server` → logs, métricas, eventos de deploy
  - `knowledge-server` → runbooks, ADRs, tech specs
- [ ] O server mantém responsabilidade única (um domínio + uma fronteira de dados)

## 2. Nome e descrição

- [ ] Nome em `snake_case`, verbo + recurso (ex.: `get_error_summary`, `search_runbooks`)
- [ ] Nome deixa óbvio **o que faz** e **quando usar**
- [ ] Descrição orientada ao agente responde:
  - [ ] O que a tool faz
  - [ ] Quando o agente deve usá-la
  - [ ] O que cada parâmetro significa (com defaults)
  - [ ] O que ela retorna

## 3. Contrato (schema in/out)

- [ ] Input schema tipado em `packages/types`
- [ ] Output schema tipado em `packages/types`
- [ ] Saída tem **forma estável** (mesma estrutura sempre, inclusive quando vazia)
- [ ] Efeitos colaterais documentados → aqui: **NENHUM (read-only)**
- [ ] Erros possíveis documentados (ex.: serviço inexistente)

## 4. Eficiência de contexto (tokens)

- [ ] Não retorna "tudo" / dump ilimitado
- [ ] Tem pelo menos um de: **filtro**, **paginação**, **range de tempo**, **limite/truncamento**
- [ ] Defaults sensatos (ex.: `limit` default 50, janela obrigatória)
- [ ] Prefere agregação/resumo quando possível em vez de dados crus

## 5. Segurança (read-only) — obrigatório

- [ ] Nenhuma escrita, execução de comando, restart, rollback ou chamada mutável
- [ ] Entrada validada: tipos, ranges, enums (`level`), formato de timestamp (ISO)
- [ ] Rejeita entrada inválida no primeiro erro, com mensagem clara
- [ ] Ausência de dados = resultado vazio explícito (não erro silencioso, não invenção)
- [ ] Rodar 2x não muda nada (idempotente / sem efeito colateral)

## 6. Arquitetura (baixo acoplamento)

- [ ] A tool **não lê arquivo direto** — chama um provider via interface estável
- [ ] Provider fake pode ser trocado por real (CloudWatch/Splunk/Prometheus) sem tocar na tool
- [ ] `types` / `providers` / `mcp-servers` / `core` com responsabilidades separadas
- [ ] Funções pequenas, sem estado escondido, determinísticas sobre os dados fake

## 7. Integração e testes

- [ ] A tool é chamada pela camada de orquestração, que registra a chamada (auditabilidade)
- [ ] Eval Harness atualizado se o comportamento esperado do agente mudou
- [ ] Testada com: caso normal, caso sem dados, caso de entrada inválida

## 8. Anti-padrões — confirme que NÃO caiu em nenhum

- [ ] Não retorna dump bruto ilimitado
- [ ] Não duplica/sobrepõe outra tool
- [ ] Não coloca lógica de dados no prompt do agente
- [ ] Não acopla ao formato do arquivo fake
- [ ] Não faz operação de escrita/execução "por conveniência"
- [ ] Não introduz overengineering (banco vetorial, framework pesado) sem necessidade
