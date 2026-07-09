import type { Hypothesis } from '@agentops/types';
import { TRAFFIC_JUMP_FACTOR, dominantException, firstDeploy, hasLatencyJump } from '../findings.js';
import type { InvestigationFindings } from '../findings.js';
import { hhmm } from '../time.js';
import { classifyConfidence } from './confidence.js';

export interface HypothesesResult {
  primary: Hypothesis | null;
  alternatives: Hypothesis[];
}

/**
 * Regras determinísticas de hipótese (passo 9 da skill):
 *
 * - **R1 — Regressão de deploy**: deploy na janela estendida + exception
 *   dominante + p99 ≥ 2× baseline → "regressão introduzida no deploy X".
 * - **R2 — Dependência degradada**: sem deploy + exception dominante de
 *   timeout → "dependência externa/banco degradado".
 * - **R3 — Dados insuficientes**: nenhuma telemetria → sem hipótese
 *   (`primary: null`), o relatório declara o que faltou (US9).
 */
export function formulateHypotheses(findings: InvestigationFindings): HypothesesResult {
  const deploy = firstDeploy(findings);
  const dominant = dominantException(findings);
  const latencyJump = hasLatencyJump(findings);
  const runbookCorroborates = findings.runbook?.found === true;

  // R1 — Regressão de deploy
  if (deploy !== null && dominant !== null && latencyJump) {
    const confidence = classifyConfidence({
      errorEvidence: true,
      latencyJump: true,
      deployInWindow: true,
      runbookCorroborates,
    });
    return {
      primary: {
        statement: `Regressão introduzida no deploy da versão ${deploy.version} às ${hhmm(deploy.timestamp)}, afetando o fluxo associado a ${dominant.exception}.`,
        rationale:
          'Correlação temporal deploy → pico de erros, exception dominante nos logs e salto de p99 (≥2× o baseline anterior).',
        confidence,
      },
      alternatives: [
        {
          statement: `Degradação da dependência associada a ${dominant.exception}, independente do deploy.`,
          rationale: 'Erros dessa natureza também ocorrem sem mudança de código; o deploy pode ser coincidência.',
          confidence: 'baixa',
        },
      ],
    };
  }

  // R2 — Dependência degradada
  if (deploy === null && dominant !== null && /timeout/i.test(dominant.exception)) {
    const confidence = classifyConfidence({
      errorEvidence: true,
      latencyJump,
      deployInWindow: false,
      runbookCorroborates,
    });
    const alternatives: Hypothesis[] = [];
    const windowVolume = findings.latencyWindow?.hasData === true ? findings.latencyWindow.requestCount : null;
    const baselineVolume = findings.latencyBaseline?.hasData === true ? findings.latencyBaseline.requestCount : null;
    if (
      windowVolume !== null &&
      baselineVolume !== null &&
      baselineVolume > 0 &&
      windowVolume >= TRAFFIC_JUMP_FACTOR * baselineVolume
    ) {
      alternatives.push({
        statement: 'Mudança de tráfego: aumento de volume na janela pressionando a dependência.',
        rationale: `Volume da janela (${windowVolume} req) ≥ 1,5× o baseline anterior (${baselineVolume} req).`,
        confidence: 'baixa',
      });
    }
    return {
      primary: {
        statement: `Dependência externa/banco de dados degradado, sinalizado por ${dominant.exception} sem deploy na janela.`,
        rationale:
          'Exception dominante de timeout sem evento de deploy na janela estendida aponta para degradação fora do código do serviço.',
        confidence,
      },
      alternatives,
    };
  }

  // R3 — Dados insuficientes; também o fallback seguro quando nenhuma regra
  // casa: melhor nenhuma hipótese do que uma hipótese sem evidência (US9).
  return { primary: null, alternatives: [] };
}
