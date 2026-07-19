import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { investigationTraceRecordSchema } from '@agentops/types';
import type { InvestigationTraceRecord, RoundContentBlock, RoundToolResult } from '@agentops/types';
import { formatUsageLine } from './main.js';
import { renderReport, shouldUseColor } from './renderer.js';

/**
 * Leitor humano do trace JSONL (`AGENTOPS_TRACE_LOG`, opt-in): isola um
 * registro (ou um grupo por `runId`) e monta um "replay" legível — cabeçalho,
 * score/critérios do eval quando existir, o loop agêntico rodada a rodada
 * (tool_use/tool_result decodificados) e o resultado final, reaproveitando o
 * mesmo `renderReport`/`formatUsageLine` do `investigate`. Não faz parte do
 * fluxo default: é uma ferramenta de depuração sobre o arquivo já gravado.
 */

export class TraceViewArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceViewArgError';
  }
}

export type TraceSelector =
  | { kind: 'last' }
  | { kind: 'case'; caseId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'trace'; traceId: string };

export interface TraceViewOptions {
  path: string;
  selector: TraceSelector;
  all: boolean;
}

export function usage(): string {
  return [
    'Uso: npm run trace:view -- <trace.jsonl> [opções]',
    '',
    'Opções:',
    '  --case=<caseId>   Registro(s) desse caso de eval (default: só o mais recente; --all mostra todos).',
    '  --run=<runId>     Todos os registros desse runId (um eval inteiro, em ordem).',
    '  --trace=<traceId> Um registro específico.',
    '  --all             Com --case/--run, mostra todas as ocorrências, não só a mais recente.',
    '',
    'Sem opções, mostra o último registro do arquivo (a investigação mais recente).',
    '',
    'Exemplos:',
    '  npm run trace:view -- evals/runs/trace.jsonl',
    '  npm run trace:view -- evals/runs/trace.jsonl --case=case-001-database-timeout',
    '  npm run trace:view -- evals/runs/trace.jsonl --run=2026-07-11T19-25-11-791Z-769d',
    '',
  ].join('\n');
}

export function parseArgs(argv: string[]): TraceViewOptions {
  let path: string | undefined;
  let selector: TraceSelector = { kind: 'last' };
  let all = false;

  for (const arg of argv) {
    if (arg === '--all') {
      all = true;
    } else if (arg.startsWith('--case=')) {
      selector = { kind: 'case', caseId: arg.slice('--case='.length) };
    } else if (arg.startsWith('--run=')) {
      selector = { kind: 'run', runId: arg.slice('--run='.length) };
    } else if (arg.startsWith('--trace=')) {
      selector = { kind: 'trace', traceId: arg.slice('--trace='.length) };
    } else if (arg.startsWith('--')) {
      throw new TraceViewArgError(`opção desconhecida: "${arg}"`);
    } else if (path === undefined) {
      path = arg;
    } else {
      throw new TraceViewArgError(`argumento inesperado: "${arg}"`);
    }
  }

  if (path === undefined) {
    throw new TraceViewArgError('caminho do arquivo de trace é obrigatório.');
  }

  return { path, selector, all };
}

/**
 * Extrai as substrings de cada valor JSON top-level do conteúdo bruto, contando
 * profundidade de `{}`/`[]` e ignorando chaves/colchetes dentro de strings
 * (aspas + escapes). O trace é gravado como JSONL compacto (`appendTraceRecord`,
 * uma linha por registro) — mas o arquivo pode ter sido reformatado manualmente
 * (pretty-print, `jq .` sem `-c`) depois; dividir por valor em vez de por linha
 * lê os dois formatos, e qualquer mistura entre eles, sem exigir re-gravação.
 */
function splitJsonValues(content: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        values.push(content.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return values;
}

/** Valores JSON quebrados ou fora do schema viram aviso em stderr e são ignorados, nunca abortam a leitura. */
export async function loadTraceRecords(path: string): Promise<InvestigationTraceRecord[]> {
  const content = await readFile(path, 'utf8');
  const records: InvestigationTraceRecord[] = [];

  const values = splitJsonValues(content);
  for (const [index, value] of values.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      process.stderr.write(`Aviso: registro ${index + 1} de "${path}" não é JSON válido, ignorado.\n`);
      continue;
    }
    const result = investigationTraceRecordSchema.safeParse(parsed);
    if (!result.success) {
      process.stderr.write(`Aviso: registro ${index + 1} de "${path}" não corresponde ao schema de trace, ignorado.\n`);
      continue;
    }
    records.push(result.data);
  }
  return records;
}

/**
 * `--run` sempre devolve o grupo inteiro (é o próprio propósito do runId).
 * `--case`/`--trace`/default devolvem só a ocorrência mais recente, a menos
 * que `--all` seja passado — evita reimprimir todo o histórico quando o
 * arquivo acumulou várias execuções do mesmo caso.
 */
export function selectRecords(records: InvestigationTraceRecord[], options: TraceViewOptions): InvestigationTraceRecord[] {
  const selector = options.selector;
  const matches = ((): InvestigationTraceRecord[] => {
    switch (selector.kind) {
      case 'trace':
        return records.filter((record) => record.traceId === selector.traceId);
      case 'run':
        return records.filter((record) => record.runId === selector.runId);
      case 'case':
        return records.filter((record) => record.caseId === selector.caseId);
      case 'last':
        return records.length > 0 ? [records[records.length - 1] as InvestigationTraceRecord] : [];
    }
  })();

  if (selector.kind === 'run' || options.all || matches.length <= 1) {
    return matches;
  }
  return [matches[matches.length - 1] as InvestigationTraceRecord];
}

interface Colorizer {
  title: (text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
}

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  cyan: '[36m',
} as const;

function colorizer(useColor: boolean): Colorizer {
  if (!useColor) {
    return { title: (text) => text, bold: (text) => text, dim: (text) => text };
  }
  return {
    title: (text) => `${ANSI.bold}${ANSI.cyan}${text}${ANSI.reset}`,
    bold: (text) => `${ANSI.bold}${text}${ANSI.reset}`,
    dim: (text) => `${ANSI.dim}${text}${ANSI.reset}`,
  };
}

function renderContentBlock(block: RoundContentBlock): string {
  return block.type === 'text' ? `💬 ${block.text}` : `→ ${block.name}(${JSON.stringify(block.input)})`;
}

/** `content` é a string exata enviada ao modelo — normalmente JSON serializado; decodifica quando possível. */
function renderToolResult(result: RoundToolResult): string {
  const prefix = result.is_error === true ? '← [ERRO] ' : '← ';
  try {
    return `${prefix}${JSON.stringify(JSON.parse(result.content))}`;
  } catch {
    return `${prefix}${result.content}`;
  }
}

export function renderRecord(record: InvestigationTraceRecord, useColor: boolean): string {
  const c = colorizer(useColor);
  const lines: string[] = [];

  const label =
    record.source === 'eval'
      ? `eval · ${record.caseId ?? '?'}`
      : record.source === 'compare'
        ? `compare · ${record.caseId ?? '?'}`
        : 'investigate';
  lines.push(c.title(`═══ ${label} ═══`));
  lines.push(`traceId:  ${record.traceId}`);
  lines.push(`runId:    ${record.runId}`);
  lines.push(`quando:   ${record.timestamp}`);
  lines.push(`engine:   ${record.engine}${record.model !== null ? ` (${record.model})` : ''}`);
  lines.push(`pergunta: ${record.question}`);
  lines.push('');

  if (record.eval !== null) {
    const approved = record.eval.criteria.filter((criterion) => criterion.passed).length;
    lines.push(
      c.bold(
        `Score: ${record.eval.score.toFixed(2)} (${approved}/${record.eval.criteria.length} critérios) — ` +
          (record.eval.passed ? 'APROVADO' : 'REPROVADO'),
      ),
    );
    for (const criterion of record.eval.criteria) {
      lines.push(`  [${criterion.passed ? 'OK' : 'FALHOU'}] ${criterion.name} — ${criterion.details}`);
    }
    lines.push('');
  }

  if (record.rounds !== null && record.rounds.length > 0) {
    lines.push(c.bold('Loop agêntico (rodada a rodada)'));
    lines.push('');
    for (const round of record.rounds) {
      lines.push(c.dim(`━━━ Rodada ${round.round} (stop_reason: ${round.stopReason ?? '?'}) ━━━`));
      for (const block of round.assistantContent) {
        lines.push(renderContentBlock(block));
      }
      for (const result of round.toolResults) {
        lines.push(renderToolResult(result));
      }
      lines.push('');
    }
  }

  if (record.usage !== null) {
    lines.push(
      formatUsageLine({
        inputTokens: record.usage.input_tokens,
        outputTokens: record.usage.output_tokens,
        cacheReadTokens: record.usage.cache_read_input_tokens,
        cacheCreationTokens: record.usage.cache_creation_input_tokens,
        rounds: record.usage.rounds,
      }),
    );
    lines.push('');
  }

  lines.push(c.bold('Resultado final'));
  lines.push('');
  if (record.outcome.kind === 'report') {
    lines.push(renderReport(record.outcome.report, useColor));
  } else if (record.outcome.kind === 'markdown') {
    lines.push(record.outcome.markdown);
  } else {
    lines.push('(clarification — não é esperado em um registro gravado; nenhuma tool foi chamada)');
  }

  return lines.join('\n');
}

async function main(): Promise<number> {
  let options: TraceViewOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof TraceViewArgError) {
      process.stderr.write(`${error.message}\n\n${usage()}`);
      return 1;
    }
    throw error;
  }

  let records: InvestigationTraceRecord[];
  try {
    records = await loadTraceRecords(options.path);
  } catch (error) {
    process.stderr.write(`Não foi possível ler "${options.path}": ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const selected = selectRecords(records, options);
  if (selected.length === 0) {
    process.stderr.write('Nenhum registro encontrado para o filtro informado.\n');
    return 1;
  }

  const useColor = shouldUseColor(process.stdout);
  const separator = `\n\n${'='.repeat(70)}\n\n`;
  process.stdout.write(`${selected.map((record) => renderRecord(record, useColor)).join(separator)}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`trace:view falhou: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
