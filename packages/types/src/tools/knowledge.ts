import { z } from 'zod';
import { formatToolError, limitSchema } from '../common.js';

/** Tipos de documento da knowledge base — um diretório por tipo. */
export const documentKindSchema = z.enum(['runbooks', 'adrs', 'tech-specs']);
export type DocumentKind = z.infer<typeof documentKindSchema>;

/** Termo de busca: não pode ser vazio nem só espaços (`EMPTY_QUERY`). */
export const querySchema = z
  .string()
  .refine((value) => value.trim().length > 0, formatToolError('EMPTY_QUERY', "'query' não pode ser vazia"));

// ---------------------------------------------------------------------------
// search_runbooks / search_adrs / search_tech_specs
// (contrato compartilhado — muda apenas o diretório-alvo)
// ---------------------------------------------------------------------------

export const searchDocumentsInputShape = {
  query: querySchema,
  limit: limitSchema(10, 5),
} as const;
export const searchDocumentsInputSchema = z.object(searchDocumentsInputShape);
export type SearchDocumentsInput = z.infer<typeof searchDocumentsInputSchema>;

export const searchRunbooksInputSchema = searchDocumentsInputSchema;
export const searchAdrsInputSchema = searchDocumentsInputSchema;
export const searchTechSpecsInputSchema = searchDocumentsInputSchema;

/** Comprimento máximo do excerpt retornado pela busca. */
export const EXCERPT_MAX_LENGTH = 240;

export const documentMatchSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  path: z.string().min(1),
  score: z.number().min(0),
  excerpt: z.string().max(EXCERPT_MAX_LENGTH),
});
export type DocumentMatch = z.infer<typeof documentMatchSchema>;

export const documentSearchResultSchema = z.object({
  query: z.string(),
  matches: z.array(documentMatchSchema),
});
export type DocumentSearchResult = z.infer<typeof documentSearchResultSchema>;

// ---------------------------------------------------------------------------
// get_runbook
// ---------------------------------------------------------------------------

export const getRunbookInputShape = {
  name: z
    .string()
    .trim()
    .min(1, formatToolError('INVALID_ARGUMENT', "'name' não pode ser vazio"))
    .max(200, formatToolError('INVALID_ARGUMENT', "'name' deve ter no máximo 200 caracteres")),
} as const;
export const getRunbookInputSchema = z.object(getRunbookInputShape);
export type GetRunbookInput = z.infer<typeof getRunbookInputSchema>;

/** Runbook não encontrado é resultado válido (`found: false`), nunca erro (RF14). */
export const runbookResultSchema = z.object({
  found: z.boolean(),
  name: z.string().nullable(),
  title: z.string().nullable(),
  content: z.string().nullable(),
});
export type RunbookResult = z.infer<typeof runbookResultSchema>;

// ---------------------------------------------------------------------------
// Provider (fake na v1 — RF11)
// ---------------------------------------------------------------------------

export interface KnowledgeProvider {
  search(kind: DocumentKind, query: string, limit?: number): Promise<DocumentSearchResult>;
  getRunbook(name: string): Promise<RunbookResult>;
}
