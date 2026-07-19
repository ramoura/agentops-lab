import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

/**
 * E2E do experimento red-team (V2.7, testes E01–E07) via `execa` (D4, sem
 * Playwright). Valida preflight, isolamento e exit codes SEM gastar tokens; a
 * chamada Anthropic real (E06) é smoke manual, skipped sem `ANTHROPIC_API_KEY`.
 *
 * Nenhuma variável de ambiente do processo de teste vaza para os filhos que não
 * devem ter credencial: `ANTHROPIC_API_KEY: ''` força o caminho sem chave.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function runCli(args: string[], env: Record<string, string> = {}) {
  return execa('npm', ['run', '--silent', 'eval:redteam', '--', ...args], {
    cwd: repoRoot,
    reject: false,
    env: { ANTHROPIC_API_KEY: '', ...env },
  });
}

// E01
describe('eval:redteam --engine=deterministic', () => {
  it('encerra com orientação e sem rede (engine não suportado)', async () => {
    const result = await runCli(['--engine=deterministic']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('REDTEAM_ENGINE_UNSUPPORTED');
    expect(result.stderr).toContain('somente --engine=llm');
    // Não tocou rede nem imprimiu breakdown de caso.
    expect(result.stdout).not.toContain('Segurança — score');
  }, 90_000);
});

// E02
describe('eval:redteam sem ANTHROPIC_API_KEY', () => {
  it('falha antes de spawnar o server, com erro tipado', async () => {
    const result = await runCli(['--engine=llm']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ANTHROPIC_API_KEY_MISSING');
    expect(result.stderr).not.toContain('at '); // sem stack trace cru
  }, 90_000);
});

// E05
describe('eval:redteam com fixture ausente', () => {
  it('produz erro tipado, sem stack trace cru na CLI', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'redteam-empty-'));
    try {
      const result = await runCli(['--engine=llm'], {
        // Raiz existe mas sem as fixtures dos vetores → REDTEAM_ROOT_INVALID.
        AGENTOPS_REDTEAM_DATASETS_DIR: emptyDir,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('REDTEAM_ROOT_INVALID');
      expect(result.stderr).toContain('fixture adversarial ausente');
      expect(result.stderr).not.toContain('at Object.'); // sem stack trace cru
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  }, 90_000);
});

// E03 & E04
describe('isolamento das suítes normais', () => {
  it('npm run eval permanece 3/3 e não menciona case-004 (sem rede, sem API key)', async () => {
    const result = await execa('npm', ['run', '--silent', 'eval'], {
      cwd: repoRoot,
      reject: false,
      env: { ANTHROPIC_API_KEY: '' },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Resumo: 3\/3 outcome\(s\) aprovado\(s\)/);
    expect(result.stdout).not.toContain('case-004');
    expect(result.stdout).not.toContain('cases-redteam');
  }, 120_000);
});

// E06 (smoke real manual — só roda com credencial explícita; gasta tokens)
describe('smoke real red-team', () => {
  const hasKey = (process.env['ANTHROPIC_API_KEY'] ?? '').trim() !== '';
  it.skipIf(!hasKey)('executa apenas case-004 e imprime resultado agregado, modelo, rodadas e tokens', async () => {
    const result = await execa('npm', ['run', '--silent', 'eval:redteam', '--', '--engine=llm'], {
      cwd: repoRoot,
      reject: false,
    });
    expect(result.stdout).toContain('case-004-tool-data-prompt-injection — red-team');
    expect(result.stdout).toContain('Outcome — score');
    expect(result.stdout).toContain('Segurança — score');
    expect(result.stdout).toContain('Rodadas:');
    expect([0, 1]).toContain(result.exitCode);
  }, 180_000);
});

// E07: repetição manual mínima de três execuções é OBSERVAÇÃO, não taxa/gate.
// Deliberadamente não automatizada — a estabilidade multi-run pertence à V2.9.
// Registrada em docs/decisions.md (D12); nenhum gate de flake é criado aqui.
