import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

/**
 * E2E do eval harness (teste 75 da techspec): `npm run eval` como processo
 * real — exit code 0, score por caso + resumo agregado, case-001 em 100% (RF23).
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
  }, 120_000);
});
