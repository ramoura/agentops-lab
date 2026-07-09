import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

/**
 * E2E do eval harness (teste 75 da techspec V1 + cenários da V2): `npm run
 * eval` como processo real — exit code 0, score por caso + resumo agregado,
 * case-001 em 100% (RF23). O smoke com LLM real (`npm run eval:llm`) é
 * opt-in: skipped sem `ANTHROPIC_API_KEY` — é o único teste da suíte que
 * gasta tokens, e apenas sob decisão explícita do usuário.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('npm run eval', () => {
  it('sai com código 0, imprime score por caso + resumo agregado e case-001 = 100%', async () => {
    const result = await execa('npm', ['run', '--silent', 'eval'], { cwd: repoRoot, reject: false });

    expect(result.exitCode, result.stderr).toBe(0);

    // Score por caso (RF23/RF27)
    expect(result.stdout).toContain('case-001-database-timeout — score 1.00');
    expect(result.stdout).toContain('case-002-payment-api-timeout — score');
    expect(result.stdout).toContain('case-003-missing-data — score');

    // Breakdown de critérios (RF27)
    expect(result.stdout).toContain('[OK] finding:DatabaseTimeoutException');
    expect(result.stdout).toContain('[OK] proximos_passos_seguros');

    // Resumo agregado
    expect(result.stdout).toMatch(/Resumo: \d\/3 caso\(s\) aprovado\(s\) · score médio \d\.\d{2}/);

    // case-001 = 100% (meta do PRD): APROVADO, sem critério reprovado
    const case001Block = result.stdout.slice(
      result.stdout.indexOf('case-001-database-timeout'),
      result.stdout.indexOf('case-002-payment-api-timeout'),
    );
    expect(case001Block).toContain('APROVADO');
    expect(case001Block).not.toContain('[FALHOU]');

    // Progresso em stderr, resultados em stdout
    expect(result.stderr).toContain('Executando 3 caso(s) de eval…');
    expect(result.stdout).not.toContain('Executando 3 caso(s) de eval…');

    // V2: o resumo indica o engine usado (default deterministic)
    expect(result.stdout).toContain('· engine: deterministic');
  }, 120_000);
});

// V2 — flag inválida no eval
describe('npm run eval -- --engine=foo', () => {
  it('sai com código 1 e orienta o uso, sem executar nenhum caso', async () => {
    const result = await execa('npm', ['run', '--silent', 'eval', '--', '--engine=foo'], {
      cwd: repoRoot,
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--engine inválido: "foo"');
    expect(result.stderr).toContain('Uso: npm run eval -- [--engine=deterministic|llm]');
    expect(result.stdout).not.toContain('case-001');
  }, 90_000);
});

/**
 * Smoke opt-in com LLM real (V2): o ÚNICO ponto da suíte que gasta tokens —
 * skipped sem `ANTHROPIC_API_KEY` (nunca roda em CI por default). Exercita o
 * caminho do script `npm run eval:llm` (runner + motor LLM real + scorer
 * text-mode) restrito ao case-001, o menor custo possível.
 */
const hasApiKey = (process.env['ANTHROPIC_API_KEY'] ?? '').trim() !== '';

describe('smoke opt-in com LLM real (npm run eval:llm)', () => {
  it('o script eval:llm existe na raiz e aponta para o runner com --engine=llm', async () => {
    const { default: rootPackage } = await import(join(repoRoot, 'package.json'), { with: { type: 'json' } });

    expect(rootPackage.scripts['eval:llm']).toBe('tsx evals/src/runner.ts --engine=llm');
  });

  it.skipIf(!hasApiKey)('pontua o case-001 com o motor LLM real e breakdown por critério', async () => {
    const { loadCases, runEvals } = await import('../src/runner.js');
    const [case001] = await loadCases();
    expect(case001?.id).toBe('case-001-database-timeout');

    const casesDir = await mkdtemp(join(tmpdir(), 'agentops-eval-llm-'));
    try {
      await writeFile(join(casesDir, 'case-001-database-timeout.json'), JSON.stringify(case001), 'utf8');

      const outLines: string[] = [];
      const summary = await runEvals({
        engine: 'llm',
        casesDir,
        out: (line) => outLines.push(line),
        err: () => {},
      });

      expect(summary.engine).toBe('llm');
      expect(summary.results).toHaveLength(1);
      const output = outLines.join('\n');
      expect(output).toContain('case-001-database-timeout — score');
      expect(output).toMatch(/\[(OK|FALHOU)\] finding:DatabaseTimeoutException/);
      expect(output).toContain('· engine: llm');
    } finally {
      await rm(casesDir, { recursive: true, force: true });
    }
  }, 300_000);
});
