import process from 'node:process';
import { DeterministicInvestigationEngine, PtBrQuestionParser } from '@agentops/core';
import type { ToolInvoker, ToolName } from '@agentops/types';
import { McpConnectionError, McpToolInvoker } from './mcp-tool-invoker.js';
import { renderMissingFields, renderReport, renderUsage, shouldUseColor } from './renderer.js';

/**
 * Entrypoint de `npm run investigate -- "<pergunta>"` (RF1): interpreta a
 * pergunta, spawna o agentops-server via MCP stdio, executa o engine e imprime
 * o relatório. Progresso por etapa vai para stderr; o relatório final vai para
 * stdout — `> relatorio.txt` produz um arquivo limpo.
 */

/** Mensagem de progresso por tool (passos 2–8 da skill), exibida em stderr. */
const PROGRESS_MESSAGES: Record<ToolName, string> = {
  get_error_summary: 'Coletando resumo de erros…',
  get_top_exceptions: 'Coletando top exceptions…',
  get_recent_logs: 'Coletando logs recentes…',
  get_latency_summary: 'Coletando resumo de latência…',
  get_deployment_events: 'Coletando eventos de deploy…',
  search_runbooks: 'Buscando runbooks relacionados…',
  get_runbook: 'Lendo runbook relacionado…',
  search_adrs: 'Buscando ADRs relacionados…',
  search_tech_specs: 'Buscando tech specs relacionadas…',
};

function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Decorator de progresso: anuncia cada etapa em stderr antes de invocar a tool. */
function withProgress(inner: ToolInvoker): ToolInvoker {
  return {
    async invoke<TIn, TOut>(tool: ToolName, params: TIn): Promise<TOut> {
      progress(PROGRESS_MESSAGES[tool] ?? `Consultando ${tool}…`);
      return inner.invoke<TIn, TOut>(tool, params);
    },
  };
}

async function main(): Promise<number> {
  const useColor = shouldUseColor(process.stdout);
  const question = process.argv.slice(2).join(' ').trim();

  if (question === '') {
    process.stderr.write(renderUsage());
    return 1;
  }

  // Passo 1 da skill — identificar serviço/janela/sintoma. Pergunta ambígua
  // orienta e encerra sem chamar nenhuma tool (RF3/US10).
  const parsed = new PtBrQuestionParser().parse(question);
  if (!parsed.ok) {
    process.stdout.write(renderMissingFields(parsed.missing, useColor));
    return 0;
  }

  progress(`Investigando ${parsed.context.service} de ${parsed.context.window.from} a ${parsed.context.window.to}…`);
  progress('Iniciando o agentops-server (MCP via stdio)…');

  let invoker: McpToolInvoker;
  try {
    invoker = await McpToolInvoker.connect();
  } catch (error) {
    const detail = error instanceof McpConnectionError ? error.message : String(error);
    process.stderr.write(
      `Não foi possível conectar ao servidor de tools: ${detail}\n` +
        'Verifique se as dependências foram instaladas com "npm install" e tente novamente.\n',
    );
    return 1;
  }

  try {
    const engine = new DeterministicInvestigationEngine();
    const report = await engine.investigate(parsed.context, withProgress(invoker));
    progress('Montando o relatório…');
    process.stdout.write(renderReport(report, useColor));
    return 0;
  } finally {
    await invoker.close().catch(() => {
      // Encerramento do processo filho é melhor esforço: o relatório já saiu.
    });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Nunca stack trace cru para o usuário (fluxo de erro do PRD).
    process.stderr.write(`A investigação falhou: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
