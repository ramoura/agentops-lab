/**
 * Utilidades de tempo do core: deslocamento de janelas preservando o offset
 * do timestamp original. O core não conhece filesystem nem providers, então
 * mantém sua própria cópia mínima destas funções.
 */

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

/** Desloca um timestamp ISO em `deltaMs`, preservando o offset original. */
export function shiftIso(isoTimestamp: string, deltaMs: number): string {
  return formatWithOffset(Date.parse(isoTimestamp) + deltaMs, extractOffset(isoTimestamp));
}

/** Trecho `HH:MM` de um timestamp ISO, no fuso do próprio timestamp. */
export function hhmm(isoTimestamp: string): string {
  const match = /T(\d{2}:\d{2})/.exec(isoTimestamp);
  return match?.[1] ?? isoTimestamp;
}
