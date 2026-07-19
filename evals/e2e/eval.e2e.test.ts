import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createChatPort } from '@agentops/cli-agent/chat-port-factory';
import { McpToolInvoker } from '@agentops/cli-agent/mcp-tool-invoker';
import {
  buildSystemPrompt,
  LlmInvestigationAssistant,
  resolveLlmEngineConfig,
} from '@agentops/llm-engine';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

/**
 * E2E do eval harness (teste 75 da techspec V1 + cenários da V2): `npm run
 * eval` como processo real — exit code 0, score por caso + resumo agregado,
 * case-001 em 100% (RF23). O smoke com LLM real (`npm run eval:llm`) é
 * opt-in: skipped sem `OPENROUTER_API_KEY` — é o único teste da suíte que
 * gasta tokens, e apenas sob decisão explícita do usuário.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('npm run eval', () => {
  it('sai com código 0, imprime score por caso + resumo agregado e case-001 = 100%', async () => {
    const result = await execa('npm', ['run', '--silent', 'eval'], { cwd: repoRoot, reject: false });

    expect(result.exitCode, result.stderr).toBe(0);

    // Score por caso (RF23/RF27)
    expect(result.stdout).toContain('case-001-database-timeout — outcome 1.00');
    expect(result.stdout).toContain('case-002-payment-api-timeout — outcome');
    expect(result.stdout).toContain('case-003-missing-data — outcome');

    // Breakdown de critérios (RF27)
    expect(result.stdout).toContain('[OK] finding:DatabaseTimeoutException');
    expect(result.stdout).toContain('[OK] proximos_passos_seguros');
    expect(result.stdout).toContain('Trajetória — score 1.00');
    expect(result.stdout).toContain('trajectory:required:latency_baseline');
    expect(result.stdout).toContain('trajectory:no_exact_duplicates');
    expect(result.stdout).toContain('Métricas:');

    // Resumo agregado
    expect(result.stdout).toMatch(/Resumo: \d\/3 outcome\(s\) aprovado\(s\) · score médio \d\.\d{2}/);
    expect(result.stdout).toContain('trajetória média 1.00 (informativa)');

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

describe('eval determinístico com envs de provider definidas', () => {
  it('E2E-001: reproduz os scores sem exigir OPENAI_API_KEY', async () => {
    const result = await execa('npm', ['run', '--silent', 'eval'], {
      cwd: repoRoot,
      reject: false,
      env: {
        AGENTOPS_LLM_PROVIDER: 'openai',
        AGENTOPS_LLM_MODEL: 'gpt-test',
        OPENAI_API_KEY: '',
      },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('Resumo: 3/3 outcome(s) aprovado(s) · score médio 1.00');
    expect(result.stdout).toContain('· engine: deterministic');
    expect(result.stderr).not.toContain('OPENAI_API_KEY');
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

describe('npm run eval:llm com OpenAI sem chave', () => {
  it('E2E-005: falha antes do spawn citando OPENAI_API_KEY e sem órfão', async () => {
    const result = await execa('npm', ['run', '--silent', 'eval:llm'], {
      cwd: repoRoot,
      reject: false,
      env: {
        AGENTOPS_LLM_PROVIDER: 'openai',
        AGENTOPS_LLM_MODEL: 'gpt-test',
        OPENAI_API_KEY: '',
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('OPENAI_API_KEY');
    expect(result.stderr).not.toContain('Iniciando o agentops-server');
    expect(result.stdout).toBe('');
  }, 90_000);
});

/**
 * Smoke opt-in com LLM real (E2E-004): o único ponto da V2.4 que gasta tokens —
 * skipped sem `OPENROUTER_API_KEY` (nunca roda em CI por default). Exercita o
 * caminho do eval (runner + motor LLM real + scorer text-mode) restrito ao
 * case-001, com o baseline `deepseek/deepseek-chat` via OpenRouter.
 */
const hasOpenRouterApiKey = (process.env['OPENROUTER_API_KEY'] ?? '').trim() !== '';

describe('E2E-004: smoke opt-in com OpenRouter (npm run eval:llm)', () => {
  it('o script eval:llm existe na raiz e aponta para o runner com --engine=llm', async () => {
    const { default: rootPackage } = await import(join(repoRoot, 'package.json'), { with: { type: 'json' } });

    expect(rootPackage.scripts['eval:llm']).toBe('tsx evals/src/runner.ts --engine=llm');
  });

  it.skipIf(!hasOpenRouterApiKey)('pontua o case-001 com OpenRouter e breakdown por critério', async () => {
    const { loadCases, runEvals } = await import('../src/runner.js');
    const [case001] = await loadCases();
    expect(case001?.id).toBe('case-001-database-timeout');

    // Assistant real injetado (mesma montagem do runner) para que o teste
    // possa ler o `lastUsage` agregado — a asserção de cache da V2.5 precisa
    // de `rounds` e `cacheReadTokens`, que não saem em stdout. As definições
    // das tools são pré-carregadas de um server MCP efêmero; a investigação em
    // si usa o invoker que o próprio runner spawna.
    const config = resolveLlmEngineConfig({
      ...process.env,
      AGENTOPS_LLM_PROVIDER: 'openrouter',
      AGENTOPS_LLM_MODEL: 'deepseek/deepseek-chat',
    });
    const toolLoader = await McpToolInvoker.connect({ serverStderr: 'inherit' });
    const toolDefinitions = await toolLoader.listTools().finally(() => toolLoader.close());
    const assistant = new LlmInvestigationAssistant(
      createChatPort(config),
      async () => toolDefinitions,
      config,
      buildSystemPrompt(),
    );

    const casesDir = await mkdtemp(join(tmpdir(), 'agentops-eval-llm-'));
    try {
      await writeFile(join(casesDir, 'case-001-database-timeout.json'), JSON.stringify(case001), 'utf8');

      const outLines: string[] = [];
      const errLines: string[] = [];
      const summary = await runEvals({
        engine: 'llm',
        assistant,
        casesDir,
        out: (line) => outLines.push(line),
        err: (line) => errLines.push(line),
      });

      expect(summary.engine).toBe('llm');
      expect(summary.results).toHaveLength(1);
      const output = outLines.join('\n');
      expect(output).toContain('case-001-database-timeout — outcome');
      expect(output).toMatch(/\[(OK|FALHOU)\] finding:DatabaseTimeoutException/);
      expect(output).toContain('· engine: llm');

      // V2.5 — asserção LENIENTE de cache: em investigação com 2+ rodadas, a
      // rodada 2 deve ter lido o prefixo escrito pela rodada 1
      // (`cacheReadTokens > 0` no agregado). Valores exatos são proibidos —
      // variam por execução (TTL/eviction do lado do servidor). Rodada única
      // não tem o que ler; cache desligado por env não tem o que assertar.
      const usage = assistant.lastUsage;
      expect(usage).not.toBeNull();
      expect(errLines.join('\n')).toContain('Cache:');
      if (config.cacheEnabled && usage !== null && usage.rounds >= 2) {
        expect(usage.cacheReadTokens).toBeGreaterThan(0);
      }
    } finally {
      await rm(casesDir, { recursive: true, force: true });
    }
  }, 300_000);
});
