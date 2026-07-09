# Documento de Requisitos do Produto (PRD)

# AgentOps Lab — Incident Investigation Assistant

## Visão Geral

O AgentOps Lab é uma PoC de um assistente de investigação de incidentes de produção. A partir de uma pergunta em linguagem natural (ex.: "Investigue por que o `checkout-api` teve aumento de erro 5xx entre 10h e 10h30"), o assistente identifica o serviço e a janela de tempo afetados, consulta logs, métricas, eventos de deploy e documentação técnica (runbooks, ADRs, tech specs) por meio de tools read-only expostas via MCP, e produz uma análise estruturada que separa fatos de hipóteses, cita evidências e sugere próximos passos seguros.

O produto é um laboratório de estudo pessoal: seu valor está em servir de base moderna e realista para estudar MCP, skills, context engineering, workflows agênticos, observabilidade, eval harness, segurança read-only e auditabilidade — conceitos centrais para a operação confiável de agentes de IA. A primeira versão usa dados simulados e raciocínio determinístico, mas com arquitetura preparada para evoluir para integrações reais (CloudWatch, Splunk, Prometheus, OpenTelemetry) e para um motor baseado em LLM.

## Objetivos

- **Investigação end-to-end funcional**: após `npm install`, o comando `npm run investigate -- "<pergunta>"` produz um relatório completo de investigação (resumo executivo, evidências, hipóteses, próximos passos, dados faltantes, confiança) para o cenário simulado do `checkout-api`.
- **Confiabilidade mensurável**: `npm run eval` executa ao menos 3 casos de teste e gera um score por caso; o caso principal (`case-001-database-timeout`) deve encontrar 100% dos findings esperados e 0 termos proibidos.
- **Segurança verificável**: 100% das tools são read-only; nenhuma tool escreve em sistema externo ou executa comando; nenhuma resposta recomenda ação destrutiva como primeira opção.
- **Auditabilidade**: toda investigação registra quais tools foram chamadas, com quais parâmetros e em qual ordem.
- **Extensibilidade demonstrada**: adicionar um novo dataset, uma nova tool ou uma nova skill está documentado no README e não exige mudança na arquitetura.
- **Valor de estudo**: o projeto demonstra de forma legível o conceito "MCP/tools + skills + knowledge base + eval harness + segurança read-only" e usa o protocolo MCP real (servidores dedicados), permitindo estudar o protocolo na prática.

## Histórias de Usuário

Persona primária: **desenvolvedor backend/SRE em estudo** (o próprio autor do laboratório), interessado em entender como agentes de IA podem apoiar investigação de incidentes usando MCP, skills, context engineering, observabilidade e eval harness. Persona secundária: **engenheiro on-call hipotético**, usado como referência de UX para o formato do relatório.

- **US1** — Como engenheiro, quero fazer uma pergunta em linguagem natural sobre um incidente via CLI para receber uma análise estruturada com evidências e hipóteses, sem precisar consultar manualmente logs, métricas e deploys.
- **US2** — Como engenheiro, quero que o assistente identifique automaticamente o serviço, a janela de tempo e o sintoma a partir da minha pergunta, para não ter que informar parâmetros técnicos manualmente.
- **US3** — Como engenheiro, quero que o relatório separe claramente fatos (com evidência citada) de suposições, para poder confiar na análise e julgar as hipóteses por conta própria.
- **US4** — Como engenheiro, quero que o assistente consulte runbooks, ADRs e tech specs relevantes, para que a análise incorpore o conhecimento institucional documentado.
- **US5** — Como engenheiro, quero receber apenas sugestões de próximos passos seguros (nunca execução de ações), para poder usar o assistente sobre sistemas de produção sem risco.
- **US6** — Como engenheiro, quero rodar `npm run eval` e ver um score por caso de teste, para medir objetivamente se mudanças no assistente melhoraram ou pioraram a qualidade das investigações.
- **US7** — Como engenheiro, quero ver no final da investigação quais tools foram chamadas e com quais parâmetros, para auditar o comportamento do agente.
- **US8** — Como engenheiro, quero adicionar novos cenários de incidente (datasets, casos de eval, runbooks) seguindo instruções do README, para expandir o laboratório com novos estudos.
- **US9 (caso de borda)** — Como engenheiro, quando pergunto sobre um serviço ou período sem dados disponíveis, quero que o assistente diga explicitamente o que está faltando em vez de inventar conclusões.
- **US10 (caso de borda)** — Como engenheiro, quando a pergunta é ambígua (sem serviço ou sem janela de tempo identificáveis), quero que o assistente informe o que não conseguiu extrair e o que precisa para prosseguir.

## Principais funcionalidades

### F1. CLI de investigação

- **O que faz**: recebe uma pergunta em linguagem natural e conduz uma investigação completa, imprimindo o relatório estruturado no terminal.
- **Por que é importante**: é a interface única do produto; materializa a experiência de "perguntar a um colega que investiga por você".
- **Como funciona em alto nível**: a CLI interpreta a pergunta (serviço, janela, sintoma), executa o processo definido pela skill `investigate-incident` consultando as tools via MCP, e formata o relatório final.

Requisitos funcionais:

1. **RF1**: A CLI deve aceitar uma pergunta em linguagem natural como argumento via `npm run investigate -- "<pergunta>"`.
2. **RF2**: A CLI deve extrair da pergunta o serviço afetado, a janela de tempo e o sintoma relatado.
3. **RF3**: Quando não conseguir extrair serviço ou janela de tempo, a CLI deve informar explicitamente o que faltou e o que é necessário para prosseguir, sem tentar adivinhar.
4. **RF4**: O relatório final deve conter, nesta ordem: resumo executivo, evidências encontradas, hipótese principal, hipóteses alternativas, próximos passos seguros, dados faltantes e confiança da análise (baixa, média ou alta).
5. **RF5**: Toda afirmação apresentada como evidência deve referenciar o dado que a sustenta (ex.: exception observada nos logs, métrica de latência, evento de deploy, trecho de runbook).
6. **RF6**: A investigação deve ser conduzida exclusivamente por meio das tools; o relatório não pode conter fatos que não vieram de uma chamada de tool.
7. **RF7**: Ao final da investigação, a CLI deve exibir o registro de auditoria: tools chamadas, parâmetros e ordem de execução.

### F2. MCP servers (observabilidade e conhecimento)

- **O que faz**: expõe os dados operacionais e a base de conhecimento como tools via protocolo MCP, em dois servidores dedicados — `observability-server` (logs, métricas, deploys) e `knowledge-server` (runbooks, ADRs, tech specs).
- **Por que é importante**: é o núcleo do estudo de MCP; separa o acesso a dados do raciocínio do agente e permite trocar as fontes fake por integrações reais sem alterar o consumidor.
- **Como funciona em alto nível**: cada servidor implementa o protocolo MCP real (stdio) e responde às tools com dados estruturados e previsíveis lidos das fontes simuladas.

Requisitos funcionais:

8. **RF8**: O sistema deve prover MCP servers usando o protocolo MCP real — preferencialmente dois servidores independentes (`observability-server` e `knowledge-server`); se isso gerar complexidade excessiva na primeira versão, é aceitável um único servidor (`agentops-server`), desde que use MCP real e seja fácil separar em dois posteriormente.
9. **RF9**: Toda tool deve retornar dados estruturados, tipados e previsíveis (mesma entrada produz mesma saída).
10. **RF10**: Nenhuma tool pode escrever, alterar ou apagar dados, nem executar comandos em sistemas externos (read-only estrito).
11. **RF11**: As fontes de dados devem ser substituíveis: trocar o provider fake por um provider real (ex.: CloudWatch) não pode exigir mudança no contrato das tools.

### F3. Tools de consulta read-only

- **O que faz**: conjunto de tools que respondem às perguntas típicas de uma investigação: resumo de erros, top exceptions, logs recentes, latência/volume, eventos de deploy e busca na documentação.
- **Por que é importante**: define o vocabulário de investigação do agente; cada etapa do processo tem uma tool correspondente, tornando o fluxo auditável.
- **Como funciona em alto nível**: cada tool recebe parâmetros explícitos (serviço, janela de tempo ou termo de busca) e retorna um resultado estruturado a partir dos datasets ou da knowledge base.

Requisitos funcionais:

12. **RF12**: O servidor de observabilidade deve expor, no mínimo: `get_error_summary(service, from, to)`, `get_top_exceptions(service, from, to)`, `get_recent_logs(service, level, from, to)`, `get_latency_summary(service, from, to)` e `get_deployment_events(service, from, to)`.
13. **RF13**: O servidor de conhecimento deve expor, no mínimo: `search_runbooks(query)`, `get_runbook(name)`, `search_adrs(query)` e `search_tech_specs(query)`.
14. **RF14**: Consultas sobre serviço, período ou documento inexistente devem retornar resposta vazia ou de "não encontrado" bem definida — nunca erro não tratado nem dado inventado.

### F4. Skill `investigate-incident`

- **O que faz**: documento que padroniza o processo de investigação — quando usar, passos, regras de conduta e formato de saída.
- **Por que é importante**: é o objeto de estudo de "skills" e context engineering; garante investigações consistentes e codifica as regras de segurança (não inventar dados, citar evidências, classificar confiança).
- **Como funciona em alto nível**: arquivo Markdown em `skills/investigate-incident/` que descreve o processo em 11 passos (identificar contexto → coletar dados → consultar documentação → formular hipóteses → separar fatos de suposições → sugerir próximos passos seguros) e que o agente segue durante a investigação.

Requisitos funcionais:

15. **RF15**: A skill deve existir como arquivo Markdown com as seções: objetivo, quando usar, processo, regras e saída esperada, conforme definido no prompt base.
16. **RF16**: O comportamento da investigação deve seguir o processo e as regras da skill: a ordem das etapas e o formato do relatório devem corresponder ao que a skill descreve.
17. **RF17**: As regras da skill devem ser observáveis na saída: hipóteses sempre com confiança classificada (baixa/média/alta), dados faltantes declarados e nenhuma recomendação perigosa como primeira opção.

### F5. Knowledge base

- **O que faz**: coleção de documentos Markdown com conhecimento institucional simulado — runbooks, ADRs e tech specs coerentes com o cenário de incidente.
- **Por que é importante**: demonstra como contexto documental enriquece a investigação além dos dados de telemetria; é a base do estudo de context engineering.
- **Como funciona em alto nível**: arquivos organizados por tipo (`runbooks/`, `adrs/`, `tech-specs/`), pesquisáveis pelas tools do knowledge-server.

Requisitos funcionais:

18. **RF18**: A knowledge base deve conter, no mínimo: `runbooks/checkout-api-high-5xx.md`, `runbooks/database-timeout.md`, `adrs/adr-001-checkout-payment-flow.md` e `tech-specs/checkout-api.md`.
19. **RF19**: O conteúdo dos documentos deve ser coerente com o cenário simulado (o runbook de 5xx do checkout deve orientar a verificar connection pool e mudanças recentes em acesso ao banco).

### F6. Datasets simulados

- **O que faz**: dados fake em JSON/JSONL (logs, métricas, deploys) que materializam um cenário de incidente realista e determinístico.
- **Por que é importante**: permite investigações reproduzíveis sem dependência de infraestrutura real — pré-requisito para evals confiáveis.
- **Como funciona em alto nível**: arquivos versionados no repositório, lidos pelos providers fake do observability-server.

Requisitos funcionais:

20. **RF20**: Os datasets devem materializar o cenário principal: serviço `checkout-api`, janela de 2026-07-08T10:00 a 10:30 (BRT), aumento de erros 5xx concentrado em `POST /checkout`, exception dominante `DatabaseTimeoutException`, deploy às 10:03 e latência p99 subindo de ~450ms para ~3200ms.
21. **RF21**: O volume de dados deve ser suficiente para a investigação parecer realista (períodos de comportamento normal antes do incidente, mistura de níveis de log), sem excesso que dificulte a leitura ou o versionamento.
22. **RF22**: Deve existir ao menos um cenário secundário e um cenário de ausência de dados para sustentar os casos de eval 002 e 003.

### F7. Eval Harness

- **O que faz**: executa casos de teste de investigação e pontua as respostas do agente por matching determinístico.
- **Por que é importante**: demonstra o conceito de eval harness — medir objetivamente a confiabilidade de um agente — e protege contra regressões durante a evolução do laboratório.
- **Como funciona em alto nível**: `npm run eval` roda cada caso (pergunta + findings esperados + termos proibidos), executa a investigação e compara a saída com os critérios, gerando um score por caso e um resumo geral.

Requisitos funcionais:

23. **RF23**: Deve existir o comando `npm run eval` que executa todos os casos e imprime score por caso e resultado agregado.
24. **RF24**: Devem existir ao menos 3 casos: `case-001-database-timeout` (cenário principal), `case-002-payment-api-timeout` (cenário secundário) e `case-003-missing-data` (dados ausentes).
25. **RF25**: Cada caso deve declarar: id, pergunta, findings esperados (`expected_findings`) e termos proibidos (`must_not_include`).
26. **RF26**: O scoring deve ser determinístico (matching de termos/padrões, sem LLM) e avaliar: presença dos findings esperados, ausência dos termos proibidos, citação de evidências, separação entre fato e hipótese, e presença de próximos passos seguros.
27. **RF27**: O resultado do eval deve indicar, por caso, quais critérios passaram e quais falharam — não apenas um número agregado.

## Experiência do usuário

- **Persona e necessidade**: engenheiro experiente, confortável com terminal, que quer entender rapidamente "o que aconteceu, qual a evidência e o que fazer com segurança" — e, como estudante de AgentOps, quer conseguir ler e auditar cada passo do agente.
- **Fluxo principal (investigação)**: o usuário digita uma pergunta em linguagem natural → o assistente indica que está investigando e quais etapas está executando → o relatório final aparece em seções claramente rotuladas (Resumo executivo, Evidências, Hipótese principal, Hipóteses alternativas, Próximos passos seguros, Dados faltantes, Confiança) → em seguida, o registro de auditoria das tools chamadas.
- **Fluxo secundário (eval)**: o usuário roda `npm run eval` → vê progresso por caso → recebe tabela/resumo final com score e critérios que falharam.
- **Fluxo de erro**: perguntas ambíguas ou sem dados produzem mensagens orientativas ("não identifiquei o serviço; mencione o nome do serviço na pergunta"), nunca stack traces crus nem respostas inventadas.
- **UI/UX**: saída 100% textual, organizada com títulos de seção e listas; investigação completa legível em uma tela de terminal sem rolagem excessiva; mensagens em português, consistentes com a pergunta do usuário.
- **Acessibilidade**: a informação não pode depender de cor — cores ANSI são apenas reforço, e a saída deve permanecer completa e compreensível em terminais sem suporte a cor, em leitores de tela e quando redirecionada para arquivo (`> relatorio.txt`).

## Restrições técnicas de alto nível

- **Stack**: Node.js + TypeScript, com tipos explícitos e separação entre domínio, providers e CLI.
- **Protocolo MCP real (não negociável)**: as tools devem ser expostas por MCP servers de verdade (protocolo MCP via stdio, SDK oficial), e não apenas por uma camada de funções "MCP-like".
- **Raciocínio determinístico na v1**: o "agente" da v1 é um *investigation engine* determinístico, que simula o raciocínio de investigação de forma estruturada e previsível, sem chamadas a LLM em tempo de execução — sem necessidade de API key, sem custo por execução e com saída reproduzível (pré-requisito do eval determinístico).
- **Segurança read-only (não negociável)**: nenhuma tool escreve em sistemas, executa comandos ou dispara ações; o assistente apenas lê dados e sugere passos, nunca executa remediação.
- **Sem dependências de infraestrutura**: roda 100% local com `npm install`; nenhuma dependência obrigatória de AWS, Splunk, Prometheus, banco vetorial ou serviço cloud.
- **Dados e privacidade**: todos os dados são fake e versionados no repositório; nenhum dado real ou sensível pode ser incluído nos datasets ou na knowledge base.
- **Evolutibilidade**: o desenho deve suportar as fases futuras planejadas sem reestruturação do projeto — em especial, adicionar um motor LLM reutilizando as mesmas MCP tools (V2) e substituir providers fake por integrações reais como CloudWatch, Splunk, Prometheus ou OpenTelemetry (V3).
- **Desempenho**: investigação completa e suite de evals devem concluir em segundos em uma máquina de desenvolvimento comum (sem meta formal de latência — é um laboratório local).

## Fora do escopo

- **Ações de remediação**: auto-healing, reinício de serviços, rollback automático ou qualquer escrita em sistemas externos — o assistente apenas sugere, nunca executa.
- **Motor LLM na v1**: raciocínio via API de LLM (Anthropic ou outra) fica para versão futura; a v1 é 100% determinística.
- **Integrações reais de observabilidade**: CloudWatch, Splunk, Prometheus, OpenTelemetry e afins são apenas direção de evolução documentada, não parte da v1.
- **LLM-as-judge no eval**: o scoring da v1 é exclusivamente por matching determinístico.
- **UI gráfica ou web**: nenhuma interface além do CLI.
- **Busca semântica/banco vetorial**: a busca na knowledge base é textual simples; RAG com embeddings fica como consideração futura.
- **Multiusuário, autenticação e controle de acesso**: o laboratório é local e individual.
- **Alarmes e detecção proativa**: o assistente só investiga sob demanda; não monitora nem dispara alertas.
- **Cobertura ampla de cenários**: apenas os cenários necessários para os 3 casos de eval; um catálogo maior de incidentes simulados é evolução futura.

Direção de evolução futura (fora do escopo da v1, mas que a arquitetura deve permitir):

- **V2**: adicionar LLM real usando as mesmas MCP tools.
- **V3**: trocar providers fake por CloudWatch, Splunk ou Prometheus reais.
- **V4**: adicionar tracing, audit log mais completo, policies, segurança e governança.
- **V5**: adicionar interface web ou integração com Slack/Jira, se fizer sentido.
