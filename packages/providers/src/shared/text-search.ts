import { EXCERPT_MAX_LENGTH } from '@agentops/types';

/**
 * Busca textual simples da knowledge base (sem embeddings):
 * - normalização case/acento-insensível;
 * - token casa por prefixo de palavra ("timeout" casa "timeouts"; "conexao" casa "conexão");
 * - score = frequência ponderada: título ×3, headings ×2, corpo ×1.
 */

const TITLE_WEIGHT = 3;
const HEADING_WEIGHT = 2;
const BODY_WEIGHT = 1;

/**
 * Normaliza preservando o comprimento (1 char de entrada → 1 char de saída):
 * minúsculas e sem acentos, mantendo os índices alinhados com o texto original
 * para o recorte do excerpt. (Limitação aceita: caracteres fora do BMP.)
 */
export function normalizeText(text: string): string {
  let out = '';
  for (const char of text) {
    out += (char.normalize('NFD')[0] ?? char).toLowerCase();
  }
  return out;
}

/** Tokeniza a query: normaliza e divide em palavras alfanuméricas. */
export function tokenize(query: string): string[] {
  return normalizeText(query)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function tokenRegex(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Início de palavra, sem exigir fim: prefixo casa plurais/derivados.
  return new RegExp(`(?<![a-z0-9])${escaped}`, 'g');
}

/** Ocorrências do token (já normalizado) em um texto normalizado. */
export function countOccurrences(normalizedText: string, token: string): number {
  return normalizedText.match(tokenRegex(token))?.length ?? 0;
}

export interface DocumentSections {
  title: string;
  headings: string;
  body: string;
}

/** Separa o markdown em título (primeiro `# `), headings (`##`+) e corpo. */
export function splitMarkdownSections(content: string, fallbackTitle: string): DocumentSections {
  let title: string | null = null;
  const headings: string[] = [];
  const body: string[] = [];
  for (const line of content.split('\n')) {
    const titleMatch = /^#\s+(.+)$/.exec(line);
    if (titleMatch && title === null) {
      title = (titleMatch[1] as string).trim();
      continue;
    }
    if (/^#{2,}\s/.test(line)) {
      headings.push(line.replace(/^#{2,}\s+/, ''));
      continue;
    }
    body.push(line);
  }
  return { title: title ?? fallbackTitle, headings: headings.join('\n'), body: body.join('\n') };
}

/** Score ponderado do documento para os tokens da query (0 = nenhum match). */
export function scoreDocument(sections: DocumentSections, tokens: readonly string[]): number {
  const title = normalizeText(sections.title);
  const headings = normalizeText(sections.headings);
  const body = normalizeText(sections.body);
  let score = 0;
  for (const token of tokens) {
    score +=
      TITLE_WEIGHT * countOccurrences(title, token) +
      HEADING_WEIGHT * countOccurrences(headings, token) +
      BODY_WEIGHT * countOccurrences(body, token);
  }
  return score;
}

const EXCERPT_SLICE = 200; // + reticências nas bordas, sempre ≤ EXCERPT_MAX_LENGTH

/**
 * Trecho de até 240 chars ao redor da primeira ocorrência de um token da query.
 * Sem ocorrência no conteúdo, retorna o início do documento.
 */
export function buildExcerpt(content: string, tokens: readonly string[]): string {
  const flat = content.replace(/\s/g, ' ');
  const normalized = normalizeText(flat);

  let firstIndex = -1;
  for (const token of tokens) {
    const match = tokenRegex(token).exec(normalized);
    if (match && (firstIndex === -1 || match.index < firstIndex)) {
      firstIndex = match.index;
    }
  }

  const start = firstIndex === -1 ? 0 : Math.max(0, firstIndex - 60);
  const slice = flat.slice(start, start + EXCERPT_SLICE).replace(/\s+/g, ' ').trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = start + EXCERPT_SLICE < flat.length ? '…' : '';
  return `${prefix}${slice}${suffix}`.slice(0, EXCERPT_MAX_LENGTH);
}
