import { describe, expect, it } from 'vitest';
import { PtBrQuestionParser } from './question-parser.js';

const parser = new PtBrQuestionParser();

function parseOk(question: string) {
  const result = parser.parse(question);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('esperava ok: true');
  }
  return result.context;
}

function parseFail(question: string) {
  const result = parser.parse(question);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('esperava ok: false');
  }
  return result.missing;
}

describe('PtBrQuestionParser — serviço', () => {
  // Teste 1
  it('extrai serviço entre crases', () => {
    const context = parseOk('Investigue o `checkout-api` entre 10h e 10h30 em 2026-07-08');
    expect(context.service).toBe('checkout-api');
  });

  // Teste 2
  it('extrai serviço kebab-case sem crases', () => {
    const context = parseOk('o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08');
    expect(context.service).toBe('checkout-api');
  });

  // Teste 8
  it('pergunta sem serviço identificável → missing contém service', () => {
    const missing = parseFail('Investigue o aumento de erros entre 10h e 10h30 em 2026-07-08');
    expect(missing.map((m) => m.field)).toContain('service');
    const serviceMissing = missing.find((m) => m.field === 'service');
    expect(serviceMissing?.hint).toBeTruthy();
  });
});

describe('PtBrQuestionParser — janela de tempo', () => {
  // Teste 3
  it('janela "entre 10h e 10h30 em 2026-07-08" com offset -03:00', () => {
    const context = parseOk('Por que o checkout-api falhou entre 10h e 10h30 em 2026-07-08?');
    expect(context.window).toEqual({
      from: '2026-07-08T10:00:00-03:00',
      to: '2026-07-08T10:30:00-03:00',
    });
  });

  // Teste 4
  it('janela "entre 10:00 e 10:30 em 2026-07-08" (formato com dois-pontos)', () => {
    const context = parseOk('Por que o checkout-api falhou entre 10:00 e 10:30 em 2026-07-08?');
    expect(context.window).toEqual({
      from: '2026-07-08T10:00:00-03:00',
      to: '2026-07-08T10:30:00-03:00',
    });
  });

  // Teste 5
  it('janela "das 14h às 14h20 em 2026-07-08" (variação das/às)', () => {
    const context = parseOk('O payment-api teve timeouts das 14h às 14h20 em 2026-07-08');
    expect(context.window).toEqual({
      from: '2026-07-08T14:00:00-03:00',
      to: '2026-07-08T14:20:00-03:00',
    });
  });

  // Teste 6
  it('timestamps ISO completos são aceitos diretamente', () => {
    const context = parseOk(
      'Investigue o checkout-api entre 2026-07-08T10:00:00-03:00 e 2026-07-08T10:30:00-03:00',
    );
    expect(context.window).toEqual({
      from: '2026-07-08T10:00:00-03:00',
      to: '2026-07-08T10:30:00-03:00',
    });
  });

  // Teste 7
  it('hora sem data → missing window com hint pedindo a data (não adivinha hoje)', () => {
    const missing = parseFail('O checkout-api teve erro 5xx entre 10h e 10h30');
    const windowMissing = missing.find((m) => m.field === 'window');
    expect(windowMissing).toBeDefined();
    expect(windowMissing?.hint).toMatch(/data/i);
  });

  // Teste 9
  it('pergunta sem nenhuma referência temporal → missing contém window', () => {
    const missing = parseFail('O checkout-api está com erro 5xx');
    expect(missing.map((m) => m.field)).toContain('window');
  });

  // Teste 10
  it('pergunta sem serviço e sem janela → missing lista ambos', () => {
    const missing = parseFail('por que deu erro?');
    const fields = missing.map((m) => m.field);
    expect(fields).toContain('service');
    expect(fields).toContain('window');
    expect(missing).toHaveLength(2);
  });

  // Teste 13
  it('range invertido ("entre 10h30 e 10h") → erro orientativo, nunca janela negativa', () => {
    const missing = parseFail('O checkout-api falhou entre 10h30 e 10h em 2026-07-08');
    const windowMissing = missing.find((m) => m.field === 'window');
    expect(windowMissing).toBeDefined();
    expect(windowMissing?.hint).toMatch(/anterior ao final|invertida/i);
  });
});

describe('PtBrQuestionParser — sintoma', () => {
  // Teste 11
  it.each([
    ['aumento de erro 5xx', 'erro 5xx'],
    ['muitos timeouts', 'timeout'],
    ['latência alta', 'latência alta'],
  ])('detecta o sintoma em "%s"', (phrase, expected) => {
    const context = parseOk(`O checkout-api apresentou ${phrase} entre 10h e 10h30 em 2026-07-08`);
    expect(context.symptom).toBe(expected);
  });

  // Teste 12
  it('pergunta sem sintoma → symptom: null (investigação genérica prossegue)', () => {
    const context = parseOk('O que aconteceu com o checkout-api entre 10h e 10h30 em 2026-07-08?');
    expect(context.symptom).toBeNull();
  });

  // Teste 14
  it('acentos e caixa não afetam a extração ("LATÊNCIA", "latencia")', () => {
    const upper = parseOk('O checkout-api teve LATÊNCIA ALTA entre 10h e 10h30 em 2026-07-08');
    const unaccented = parseOk('O checkout-api teve latencia alta entre 10h e 10h30 em 2026-07-08');
    expect(upper.symptom).toBe('latência alta');
    expect(unaccented.symptom).toBe('latência alta');
    expect(upper.service).toBe('checkout-api');
  });
});
