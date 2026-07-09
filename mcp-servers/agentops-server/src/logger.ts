/**
 * Logger do agentops-server: escreve exclusivamente em stderr — stdout é o
 * canal JSON-RPC do protocolo MCP (regra inegociável em servers stdio).
 * Nível controlado por `AGENTOPS_LOG_LEVEL` (default `warn`).
 */

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const DEFAULT_LEVEL: LogLevel = 'warn';

function resolveLevel(raw: string | undefined): LogLevel {
  const normalized = raw?.trim().toLowerCase();
  return LOG_LEVELS.includes(normalized as LogLevel) ? (normalized as LogLevel) : DEFAULT_LEVEL;
}

const activeLevel = resolveLevel(process.env['AGENTOPS_LOG_LEVEL']);

function write(level: LogLevel, message: string): void {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(activeLevel)) {
    return;
  }
  process.stderr.write(`[agentops-server] ${level.toUpperCase()} ${message}\n`);
}

export const logger = {
  debug: (message: string) => write('debug', message),
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string) => write('error', message),
};
