import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FakeKnowledgeProvider, FakeObservabilityProvider } from '@agentops/providers';
import { logger } from './logger.js';
import { createAgentopsServer, SERVER_NAME, SERVER_VERSION } from './server-factory.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const server = createAgentopsServer({
  observability: new FakeObservabilityProvider({ datasetsDir: join(repoRoot, 'datasets') }),
  knowledge: new FakeKnowledgeProvider({ knowledgeBaseDir: join(repoRoot, 'knowledge-base') }),
});

try {
  // stdout é o canal JSON-RPC do protocolo; qualquer log vai para stderr.
  await server.connect(new StdioServerTransport());
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} conectado via stdio (9 tools read-only)`);
} catch (error) {
  logger.error(`falha ao iniciar o server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
