/** Utilidades de tempo: janelas semiabertas `[from, to)` e buckets de 5 minutos. */

export const BUCKET_SIZE_MS = 5 * 60 * 1000;

const OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/;

/** Offset textual do timestamp ISO (ex.: `-03:00`); `Z` quando UTC. */
export function extractOffset(isoTimestamp: string): string {
  const match = OFFSET_RE.exec(isoTimestamp);
  return match?.[1] ?? 'Z';
}

function offsetToMs(offset: string): number {
  if (offset === 'Z') {
    return 0;
  }
  const sign = offset.startsWith('-') ? -1 : 1;
  const [hours = 0, minutes = 0] = offset
    .slice(1)
    .split(':')
    .map((part) => Number(part));
  return sign * (hours * 60 + minutes) * 60_000;
}

/** Formata um instante epoch como ISO 8601 no offset informado (ex.: `-03:00`). */
export function formatWithOffset(epochMs: number, offset: string): string {
  const shifted = new Date(epochMs + offsetToMs(offset));
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  return `${date}T${time}${offset}`;
}

/** `true` quando o instante está na janela semiaberta `[from, to)`. */
export function isInWindow(epochMs: number, fromMs: number, toMs: number): boolean {
  return epochMs >= fromMs && epochMs < toMs;
}

/** Índice do bucket de 5 min de um instante, relativo ao início da janela. */
export function bucketIndex(epochMs: number, fromMs: number): number {
  return Math.floor((epochMs - fromMs) / BUCKET_SIZE_MS);
}

/** Quantidade de buckets de 5 min necessários para cobrir a janela. */
export function bucketCount(fromMs: number, toMs: number): number {
  return Math.ceil((toMs - fromMs) / BUCKET_SIZE_MS);
}
