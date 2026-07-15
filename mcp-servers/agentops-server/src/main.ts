import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FakeKnowledgeProvider, FakeObservabilityProvider } from '@agentops/providers';
import { logger } from './logger.js';
import { createAgentopsServer, SERVER_NAME, SERVER_VERSION } from './server-factory.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Raízes de dados: default aponta para `datasets/` e `knowledge-base/` (uso
 * normal). O experimento red-team (V2.7) injeta `AGENTOPS_DATASETS_DIR` e
 * `AGENTOPS_KNOWLEDGE_BASE_DIR` para servir as fixtures adversariais isoladas —
 * sem alterar as 9 tools read-only nem o comportamento do server.
 */
const datasetsDir = process.env['AGENTOPS_DATASETS_DIR'] ?? join(repoRoot, 'datasets');
const knowledgeBaseDir = process.env['AGENTOPS_KNOWLEDGE_BASE_DIR'] ?? join(repoRoot, 'knowledge-base');

const server = createAgentopsServer({
  observability: new FakeObservabilityProvider({ datasetsDir }),
  knowledge: new FakeKnowledgeProvider({ knowledgeBaseDir }),
});

try {
  // stdout é o canal JSON-RPC do protocolo; qualquer log vai para stderr.
  await server.connect(new StdioServerTransport());
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} conectado via stdio (9 tools read-only)`);
} catch (error) {
  logger.error(`falha ao iniciar o server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
