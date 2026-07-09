import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  documentSearchResultSchema,
  getRunbookInputSchema,
  runbookResultSchema,
  searchDocumentsInputSchema,
} from '@agentops/types';
import type { DocumentKind, KnowledgeProvider } from '@agentops/types';
import { withValidation } from '../tool-result.js';

/** Anotações comuns: todas as tools são read-only e determinísticas (RF10/RF9). */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Shape de descoberta compartilhado pelas tools de busca (`search_*`). */
function searchShape() {
  return {
    query: z
      .string()
      .describe(
        'Termos de busca separados por espaço (ex.: "checkout 5xx database timeout"). ' +
          'Case/acento-insensível. Não pode ser vazia.',
      ),
    limit: z.number().optional().describe('Máximo de documentos no ranking (1–10; default 5).'),
  };
}

/** As três tools de busca compartilham contrato; muda apenas o diretório-alvo. */
const SEARCH_TOOLS: Array<{ name: string; kind: DocumentKind; title: string; description: string }> = [
  {
    name: 'search_runbooks',
    kind: 'runbooks',
    title: 'Busca de runbooks',
    description:
      'Busca textual nos runbooks operacionais (procedimentos de verificação e mitigação por serviço/sintoma). ' +
      'Use quando já souber o serviço e o sintoma, para encontrar o procedimento relacionado — em seguida, ' +
      'recupere o conteúdo completo com get_runbook usando o campo name do melhor match. ' +
      'Retorna ranking por relevância com excerpt; nenhuma correspondência retorna matches: [] — não é erro.',
  },
  {
    name: 'search_adrs',
    kind: 'adrs',
    title: 'Busca de ADRs',
    description:
      'Busca textual nos ADRs (registros de decisão arquitetural). Use para entender decisões de arquitetura ' +
      'relacionadas ao componente sob suspeita (ex.: termos derivados da exception dominante, como "database" ' +
      'ou "payment"). Retorna ranking por relevância com excerpt; nenhuma correspondência retorna matches: [] — não é erro.',
  },
  {
    name: 'search_tech_specs',
    kind: 'tech-specs',
    title: 'Busca de tech specs',
    description:
      'Busca textual nas tech specs (especificações técnicas dos serviços: dependências, fluxos, limites). ' +
      'Use para entender como o serviço afetado funciona por dentro e de quais dependências ele precisa. ' +
      'Retorna ranking por relevância com excerpt; nenhuma correspondência retorna matches: [] — não é erro.',
  },
];

/**
 * Registra as 4 tools de knowledge base (runbooks, ADRs, tech specs) delegando
 * ao provider — a tool nunca lê arquivo diretamente (RF11). Documento não
 * encontrado é resultado válido (`matches: []` / `found: false`), nunca erro (RF14).
 */
export function registerKnowledgeTools(server: McpServer, provider: KnowledgeProvider): void {
  for (const { name, kind, title, description } of SEARCH_TOOLS) {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: searchShape(),
        outputSchema: documentSearchResultSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      withValidation(name, searchDocumentsInputSchema, (input) => provider.search(kind, input.query, input.limit)),
    );
  }

  server.registerTool(
    'get_runbook',
    {
      title: 'Conteúdo de runbook',
      description:
        'Recupera o conteúdo Markdown completo de um runbook pelo identificador (campo name retornado por ' +
        'search_runbooks — basename sem extensão, ex.: "checkout-api-high-5xx"). Use após a busca para ler ' +
        'os passos de verificação e mitigação. Nome inexistente retorna found: false com campos null — não é erro.',
      inputSchema: {
        name: z
          .string()
          .describe('Identificador do runbook: basename sem extensão (ex.: "checkout-api-high-5xx").'),
      },
      outputSchema: runbookResultSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withValidation('get_runbook', getRunbookInputSchema, (input) => provider.getRunbook(input.name)),
  );
}
