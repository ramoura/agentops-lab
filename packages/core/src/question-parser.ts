import type { MissingField, ParseResult, QuestionParser, TimeWindow } from '@agentops/types';

/**
 * Parser determinístico de perguntas em PT-BR (RF2): extrai serviço, janela e
 * sintoma por regex/dicionário, sem NLP e sem LLM. Regra dura (RF3): nunca
 * adivinhar — toda ausência vira `missing` com hint acionável, e a CLI orienta
 * o usuário sem chamar nenhuma tool.
 */

/** Offset fixo do laboratório (America/Sao_Paulo, sem DST na v1). */
export const DEFAULT_OFFSET = '-03:00';

/** Remove acentos e baixa a caixa — extração é insensível a ambos. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Serviço
// ---------------------------------------------------------------------------

const BACKTICK_SERVICE_RE = /`([^`\n]+)`/;
/** Token kebab-case iniciado por letra (não casa datas como `2026-07-08`). */
const KEBAB_SERVICE_RE = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/;

function extractService(question: string, normalized: string): string | null {
  const backtick = BACKTICK_SERVICE_RE.exec(question);
  if (backtick?.[1] !== undefined && backtick[1].trim().length > 0) {
    return backtick[1].trim();
  }
  const kebab = KEBAB_SERVICE_RE.exec(normalized);
  return kebab?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Janela de tempo
// ---------------------------------------------------------------------------

/** Timestamp ISO completo com offset explícito, aceito diretamente. */
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/g;
/** Data isolada `YYYY-MM-DD` (fora de um timestamp ISO completo). */
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b(?!T)/;
/** Hora em PT-BR: `10h`, `10h30` ou `10:30`. */
const TIME_TOKEN = String.raw`(\d{1,2})(?:h(\d{2})?|:(\d{2}))`;
/** Par de horários: "entre 10h e 10h30", "das 14h às 14h20", "de 10:00 a 10:30". */
const TIME_RANGE_RE = new RegExp(String.raw`(?:entre|das|de)\s+${TIME_TOKEN}\s+(?:e|as|a|ate)\s+${TIME_TOKEN}`);
/** Qualquer referência de horário solto (para diferenciar "sem data" de "sem janela"). */
const ANY_TIME_RE = /\b\d{1,2}h(?:\d{2})?\b|\b\d{1,2}:\d{2}\b/;

const WINDOW_HINT_EXAMPLE = 'informe a data e o horário, ex.: "entre 10h e 10h30 em 2026-07-08"';
const INVERTED_HINT = 'a janela está invertida: o horário inicial deve ser anterior ao final, ex.: "entre 10h e 10h30"';

type WindowExtraction = { ok: true; window: TimeWindow } | { ok: false; hint: string };

function toTime(hourRaw: string, minuteH: string | undefined, minuteColon: string | undefined): string | null {
  const hour = Number(hourRaw);
  const minute = Number(minuteH ?? minuteColon ?? '0');
  if (hour > 23 || minute > 59) {
    return null;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(hour)}:${pad(minute)}`;
}

/** Garante segundos no timestamp ISO (`10:00-03:00` → `10:00:00-03:00`). */
function withSeconds(isoTimestamp: string): string {
  return isoTimestamp.replace(/T(\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/, 'T$1:00$2');
}

function checkOrder(from: string, to: string): WindowExtraction {
  if (Date.parse(from) >= Date.parse(to)) {
    return { ok: false, hint: INVERTED_HINT };
  }
  return { ok: true, window: { from, to } };
}

function extractWindow(question: string, normalized: string): WindowExtraction {
  // 1. Timestamps ISO completos são aceitos diretamente.
  const isoMatches = question.match(ISO_TS_RE);
  if (isoMatches !== null && isoMatches.length >= 2) {
    return checkOrder(withSeconds(isoMatches[0] as string), withSeconds(isoMatches[1] as string));
  }

  // 2. Par de horários em PT-BR + data.
  const range = TIME_RANGE_RE.exec(normalized);
  const date = DATE_RE.exec(normalized)?.[1] ?? null;
  if (range !== null) {
    const fromTime = toTime(range[1] as string, range[2], range[3]);
    const toTimeStr = toTime(range[4] as string, range[5], range[6]);
    if (fromTime === null || toTimeStr === null) {
      return { ok: false, hint: WINDOW_HINT_EXAMPLE };
    }
    if (date === null) {
      return { ok: false, hint: 'encontrei o horário, mas não a data; informe a data, ex.: "em 2026-07-08"' };
    }
    return checkOrder(`${date}T${fromTime}:00${DEFAULT_OFFSET}`, `${date}T${toTimeStr}:00${DEFAULT_OFFSET}`);
  }

  // 3. Horário solto sem par ou sem data — não adivinhar "hoje" nem a duração.
  if (ANY_TIME_RE.test(normalized)) {
    if (date === null) {
      return { ok: false, hint: 'encontrei o horário, mas não a data; informe a data, ex.: "em 2026-07-08"' };
    }
    return { ok: false, hint: 'informe o início e o fim da janela, ex.: "entre 10h e 10h30"' };
  }

  // 4. Data sem horário, ou nenhuma referência temporal.
  if (date !== null) {
    return { ok: false, hint: 'informe o horário da janela, ex.: "entre 10h e 10h30"' };
  }
  return { ok: false, hint: WINDOW_HINT_EXAMPLE };
}

// ---------------------------------------------------------------------------
// Sintoma
// ---------------------------------------------------------------------------

/** Dicionário canônico de sintomas (padrões avaliados sobre o texto normalizado). */
const SYMPTOMS: ReadonlyArray<{ symptom: string; pattern: RegExp }> = [
  { symptom: 'erro 5xx', pattern: /\berros? 5xx\b|\b5xx\b/ },
  { symptom: 'timeout', pattern: /\btime ?outs?\b/ },
  { symptom: 'latência alta', pattern: /\blatencia (?:alta|elevada)\b|\balta latencia\b|\baumento de latencia\b/ },
];

function extractSymptom(normalized: string): string | null {
  for (const { symptom, pattern } of SYMPTOMS) {
    if (pattern.test(normalized)) {
      return symptom;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parser PT-BR por regex/dicionário — determinístico e sem adivinhação (RF2/RF3). */
export class PtBrQuestionParser implements QuestionParser {
  parse(question: string): ParseResult {
    const normalized = normalize(question);
    const service = extractService(question, normalized);
    const window = extractWindow(question, normalized);

    const missing: MissingField[] = [];
    if (service === null) {
      missing.push({
        field: 'service',
        hint: 'não identifiquei o serviço; mencione o nome do serviço na pergunta, ex.: `checkout-api`',
      });
    }
    if (!window.ok) {
      missing.push({ field: 'window', hint: window.hint });
    }
    if (missing.length > 0 || !window.ok || service === null) {
      return { ok: false, missing };
    }

    return {
      ok: true,
      context: {
        question,
        service,
        window: window.window,
        symptom: extractSymptom(normalized),
      },
    };
  }
}
