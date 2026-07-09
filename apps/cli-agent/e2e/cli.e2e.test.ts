import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECTION_TITLES } from '../src/renderer.js';

/**
 * E2E da CLI como processo real (testes 71–74 e 76 da techspec): exercita o
 * comando `npm run investigate` de ponta a ponta — script raiz, spawn do
 * agentops-server via MCP stdio, engine e renderer.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const ANSI_RE = /\[[0-9;]*m/;

const QUESTION_CASE_001 = 'Investigue por que o checkout-api teve aumento de erro 5xx entre 10h e 10h30 em 2026-07-08';
const QUESTION_CASE_003 = 'Investigue por que o inventory-api teve erro 5xx entre 10h e 10h30 em 2026-07-08';

function runInvestigate(args: string[]) {
  return execa('npm', ['run', '--silent', 'investigate', ...args], {
    cwd: repoRoot,
    reject: false,
  });
}

function expectSectionsInOrder(stdout: string): void {
  // Cabeçalho sublinhado — inequívoco mesmo quando o título aparece no corpo do texto
  const positions = SECTION_TITLES.map((title) => stdout.indexOf(`${title}\n${'-'.repeat(title.length)}`));
  for (const [index, position] of positions.entries()) {
    expect(position, `seção "${SECTION_TITLES[index]}" ausente`).toBeGreaterThanOrEqual(0);
    if (index > 0) {
      expect(position, `seção "${SECTION_TITLES[index]}" fora de ordem`).toBeGreaterThan(positions[index - 1] as number);
    }
  }
}

// Teste 71
describe('npm run investigate -- "<pergunta case-001>"', () => {
  it('sai com código 0 e imprime as 7 seções do RF4 na ordem + "Tools chamadas"', async () => {
    const result = await runInvestigate(['--', QUESTION_CASE_001]);

    expect(result.exitCode, result.stderr).toBe(0);
    expectSectionsInOrder(result.stdout);
    expect(result.stdout).toContain('get_error_summary');
    // Progresso por etapa vai para stderr, não contamina o relatório
    expect(result.stderr).toContain('Coletando resumo de erros…');
    expect(result.stdout).not.toContain('Coletando resumo de erros…');
  }, 90_000);
});

// Teste 72
describe('pergunta ambígua (US10)', () => {
  it('orienta listando serviço e janela faltantes, sem chamar nenhuma tool, exit code 0', async () => {
    const result = await runInvestigate(['--', 'por que deu erro?']);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('serviço: não identifiquei o serviço');
    expect(result.stdout).toContain('janela de tempo:');
    // Nenhuma tool chamada: sem seção de auditoria e sem progresso de coleta
    expect(result.stdout).not.toContain('Tools chamadas');
    expect(result.stderr).not.toContain('Coletando');
    expect(result.stdout).not.toContain('get_error_summary');
  }, 90_000);
});

// Teste 73
describe('sem argumento', () => {
  it('imprime mensagem de uso e sai com código 1', async () => {
    const result = await runInvestigate([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Uso: npm run investigate -- "<pergunta>"');
  }, 90_000);
});

// Teste 74
describe('npm run investigate -- "<pergunta case-003>" (US9)', () => {
  it('declara os dados faltantes e confiança baixa, sem inventar findings', async () => {
    const result = await runInvestigate(['--', QUESTION_CASE_003]);

    expect(result.exitCode, result.stderr).toBe(0);
    expectSectionsInOrder(result.stdout);

    const missingSection = result.stdout.slice(
      result.stdout.indexOf('Dados faltantes'),
      result.stdout.indexOf('Confiança da análise'),
    );
    expect(missingSection).toContain('- Sem');
    expect(missingSection).toContain('inventory-api');

    const confidenceSection = result.stdout.slice(result.stdout.indexOf('Confiança da análise'));
    expect(confidenceSection).toContain('baixa');
    expect(result.stdout).not.toContain('DatabaseTimeoutException');
  }, 90_000);
});

// Teste 76
describe('saída redirecionada para arquivo', () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'agentops-e2e-'));
  });

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('gera relatorio.txt completo e sem códigos ANSI', async () => {
    const reportPath = join(outDir, 'relatorio.txt');
    const result = await execa('npm', ['run', '--silent', 'investigate', '--', QUESTION_CASE_001], {
      cwd: repoRoot,
      reject: false,
      stdout: { file: reportPath },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const content = await readFile(reportPath, 'utf8');
    expectSectionsInOrder(content);
    expect(content).not.toMatch(ANSI_RE);
    expect(content.trim().length).toBeGreaterThan(0);
  }, 90_000);
});
