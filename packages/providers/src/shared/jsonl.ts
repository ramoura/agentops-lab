import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { z } from 'zod';

/**
 * Lê um arquivo JSONL validando cada linha contra o schema.
 * Linha malformada (JSON inválido ou fora do schema) é ignorada com warning em
 * stderr — nunca derruba a leitura nem contamina o resultado.
 * Arquivo inexistente (ENOENT) retorna `null`, para o provider tratar como
 * "serviço desconhecido" (`hasData: false`), não como erro.
 */
export async function readJsonlFile<T>(filePath: string, schema: z.ZodType<T>): Promise<T[] | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const entries: T[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnMalformedLine(filePath, i + 1, 'JSON inválido');
      continue;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      warnMalformedLine(filePath, i + 1, result.error.issues[0]?.message ?? 'fora do schema');
      continue;
    }
    entries.push(result.data);
  }
  return entries;
}

function warnMalformedLine(filePath: string, lineNumber: number, reason: string): void {
  // console.warn escreve em stderr no Node — stdout fica livre para o protocolo MCP.
  console.warn(`[providers] WARN linha ${lineNumber} malformada em ${basename(filePath)} ignorada: ${reason}`);
}
