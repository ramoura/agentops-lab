import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Globs: workspaces ainda não criados (mcp-servers, apps, evals) são ignorados até existirem.
    projects: ['packages/*', 'mcp-servers/*', 'apps/*', 'evals*'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'mcp-servers/*/src/**/*.ts',
        'apps/*/src/**/*.ts',
        'evals/src/**/*.ts',
        'evals/scoring/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/__fixtures__/**',
        // Entrypoints (composition roots): exercitados pelos testes E2E/stdio
        // como processos filhos, que o coverage v8 não instrumenta.
        'apps/cli-agent/src/main.ts',
        'mcp-servers/agentops-server/src/main.ts',
      ],
    },
  },
});
