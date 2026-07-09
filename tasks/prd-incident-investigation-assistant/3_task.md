# Tarefa 3.0: MCP server `agentops-server` com as 9 tools read-only

## Visão geral

Implementar o MCP server único da v1 (`@agentops/agentops-server`) usando o SDK oficial `@modelcontextprotocol/sdk` v1.x via stdio, expondo as 9 tools read-only organizadas em módulos `observability/` (5 tools) e `knowledge/` (4 tools), com validação Zod na entrada, delegação aos providers e resposta via `structuredContent` (+ espelho em `content[0].text`). Logs do server exclusivamente em stderr.

<skills>
### Conformidade com skills

- `desenvolver-mcp-tools` — norma central desta tarefa: um domínio por módulo, tools `snake_case` verbo+recurso, contratos em `packages/types`, leitura só via provider, vazio explícito ≠ erro, read-only estrito, entrada validada por Zod, descrições orientadas ao agente. Percorrer `references/TOOL_CHECKLIST.md` por tool implementada.
</skills>

<requirements>
- MCP server com protocolo real via stdio, server único como fallback autorizado do RF8, estruturado para separação futura em dois servers (factory comum + módulos por domínio).
- Tools de observabilidade: `get_error_summary`, `get_top_exceptions`, `get_recent_logs`, `get_latency_summary`, `get_deployment_events` (RF12).
- Tools de conhecimento: `search_runbooks`, `get_runbook`, `search_adrs`, `search_tech_specs` (RF13).
- Dados estruturados, tipados e previsíveis (RF9); read-only estrito — nenhuma escrita ou execução de comando (RF10).
- Consultas sem dados retornam variante vazia bem definida, nunca erro não tratado (RF14); erros de validação usam `isError: true` com códigos `INVALID_ARGUMENT` / `INVALID_TIME_RANGE` / `EMPTY_QUERY`.
- Providers plugados via interfaces, sem mudar contrato das tools (RF11).
</requirements>

## Subtarefas

- [x] 3.1 `server-factory.ts` (`McpServer` + `StdioServerTransport`) e `main.ts` compondo os módulos; logging em stderr com nível via `AGENTOPS_LOG_LEVEL` (default `warn`).
- [x] 3.2 `observability/tools.ts`: registrar as 5 tools de telemetria delegando ao `FakeObservabilityProvider`.
- [x] 3.3 `knowledge/tools.ts`: registrar as 4 tools de documentação delegando ao `FakeKnowledgeProvider`.
- [x] 3.4 Validação de entrada (Zod de `@agentops/types`) e envelope `ToolError` para parâmetros inválidos; descrições de tool orientadas ao agente.
- [x] 3.5 Testes de integração via protocolo MCP real (client SDK spawnando o server, conexão reutilizada por suite).

## Detalhes de implementação

Ver techspec: **"Endpoints da API"** (documentação tool a tool: parâmetros, defaults, respostas, exemplos), decisões 1, 2 e 5 em **"Principais decisões"** e a regra de stderr em **"Monitoramento e observabilidade"**.

## Critérios de sucesso

- Client MCP conecta via stdio e descobre exatamente as 9 tools, cada uma com descrição e inputSchema.
- Nenhuma tool escreve, altera ou executa comandos (verificável por grep de APIs de escrita); stdout carrega apenas o protocolo JSON-RPC.
- Saídas validam contra os schemas Zod de saída; ausência de dados nunca produz `isError`.

## Testes da tarefa

Casos da techspec: **62–66**.

### Testes unitários

- [x] Cobertos pelos schemas (Tarefa 1.0) e providers (Tarefa 2.0); lógica própria do server é exercitada via protocolo abaixo.

### Testes de integração

- [x] 62. Descoberta: client SDK conecta e `listTools()` retorna exatamente as 9 tools, cada uma com descrição não vazia e inputSchema.
- [x] 63. `callTool` das 9 tools com parâmetros válidos → `structuredContent` valida contra o schema de saída Zod correspondente (9 casos).
- [x] 64. Validação via protocolo: `callTool('get_error_summary', {from > to})` → `isError: true` com prefixo `INVALID_TIME_RANGE`; `search_runbooks` com query vazia → `EMPTY_QUERY`.
- [x] 65. Vazio via protocolo: serviço inexistente → resposta bem formada `hasData: false` (não `isError`) (RF14).
- [x] 66. Determinismo fim-a-fim: mesma chamada duas vezes → `structuredContent` idêntico (RF9).

## Arquivos relevantes

- `mcp-servers/agentops-server/src/main.ts`, `server-factory.ts`, `observability/tools.ts`, `knowledge/tools.ts`
- `mcp-servers/agentops-server/src/**/*.test.ts` (integração via stdio)
- `.claude/skills/desenvolver-mcp-tools/references/TOOL_CHECKLIST.md` (checklist por tool)
