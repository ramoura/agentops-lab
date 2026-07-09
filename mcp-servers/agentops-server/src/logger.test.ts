import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * O nível ativo é resolvido no import (via `AGENTOPS_LOG_LEVEL`), então cada
 * cenário importa uma instância fresca do módulo com o env estubado.
 */

async function importFreshLogger(level: string | undefined): Promise<typeof import('./logger.js')> {
  vi.resetModules();
  if (level === undefined) {
    vi.stubEnv('AGENTOPS_LOG_LEVEL', '');
  } else {
    vi.stubEnv('AGENTOPS_LOG_LEVEL', level);
  }
  return import('./logger.js');
}

function captureStderr(run: () => void): string {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return written.join('');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('logger — AGENTOPS_LOG_LEVEL', () => {
  it('nível debug libera todas as mensagens', async () => {
    const { logger } = await importFreshLogger('debug');
    const output = captureStderr(() => {
      logger.debug('detalhe');
      logger.info('progresso');
    });

    expect(output).toContain('[agentops-server] DEBUG detalhe');
    expect(output).toContain('[agentops-server] INFO progresso');
  });

  it('valor desconhecido cai no default warn', async () => {
    const { logger } = await importFreshLogger('verboso');
    const output = captureStderr(() => {
      logger.info('progresso');
      logger.warn('atenção');
    });

    expect(output).not.toContain('INFO progresso');
    expect(output).toContain('[agentops-server] WARN atenção');
  });
});
