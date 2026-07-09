import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DocumentKind,
  DocumentMatch,
  DocumentSearchResult,
  KnowledgeProvider,
  RunbookResult,
} from '@agentops/types';
import { buildExcerpt, scoreDocument, splitMarkdownSections, tokenize } from '../shared/text-search.js';

export interface FakeKnowledgeProviderOptions {
  /** Diretório raiz da knowledge base (contém `runbooks/`, `adrs/`, `tech-specs/`). */
  knowledgeBaseDir: string;
  /** Prefixo do campo `path` dos matches (caminho relativo ao repositório). */
  pathPrefix?: string;
}

const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_PATH_PREFIX = 'knowledge-base';

/**
 * Provider fake da knowledge base: busca textual simples (case/acento-insensível,
 * pesos título ×3 / headings ×2 / corpo ×1) por tipo de documento, sem vazar
 * entre tipos. Read-only (`fs.readFile`/`fs.readdir`); documento inexistente é
 * resultado válido (`matches: []` / `found: false`), nunca exceção (RF14).
 */
export class FakeKnowledgeProvider implements KnowledgeProvider {
  private readonly knowledgeBaseDir: string;
  private readonly pathPrefix: string;
  private readonly documentsCache = new Map<DocumentKind, Array<{ name: string; content: string }>>();

  constructor(options: FakeKnowledgeProviderOptions) {
    this.knowledgeBaseDir = options.knowledgeBaseDir;
    this.pathPrefix = options.pathPrefix ?? DEFAULT_PATH_PREFIX;
  }

  async search(kind: DocumentKind, query: string, limit?: number): Promise<DocumentSearchResult> {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
      return { query, matches: [] };
    }

    const matches: DocumentMatch[] = [];
    for (const document of await this.loadDocuments(kind)) {
      const sections = splitMarkdownSections(document.content, document.name);
      const score = scoreDocument(sections, tokens);
      if (score > 0) {
        matches.push({
          name: document.name,
          title: sections.title,
          path: `${this.pathPrefix}/${kind}/${document.name}.md`,
          score,
          excerpt: buildExcerpt(document.content, tokens),
        });
      }
    }

    matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return { query, matches: matches.slice(0, limit ?? DEFAULT_SEARCH_LIMIT) };
  }

  async getRunbook(name: string): Promise<RunbookResult> {
    // Entrada não confiável: o nome é um basename, nunca um caminho.
    if (!/^[a-z0-9][a-z0-9-_.]*$/i.test(name)) {
      return { found: false, name: null, title: null, content: null };
    }
    let content: string;
    try {
      content = await readFile(join(this.knowledgeBaseDir, 'runbooks', `${name}.md`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { found: false, name: null, title: null, content: null };
      }
      throw error;
    }
    return { found: true, name, title: splitMarkdownSections(content, name).title, content };
  }

  private async loadDocuments(kind: DocumentKind): Promise<Array<{ name: string; content: string }>> {
    const cached = this.documentsCache.get(kind);
    if (cached) {
      return cached;
    }
    const dir = join(this.knowledgeBaseDir, kind);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.documentsCache.set(kind, []);
        return [];
      }
      throw error;
    }
    const documents: Array<{ name: string; content: string }> = [];
    for (const file of files.filter((f) => f.endsWith('.md')).sort()) {
      documents.push({ name: file.slice(0, -3), content: await readFile(join(dir, file), 'utf8') });
    }
    this.documentsCache.set(kind, documents);
    return documents;
  }
}
