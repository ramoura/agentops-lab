import type { Confidence } from '@agentops/types';

/** Sinais independentes de evidência que sustentam uma hipótese (RF17). */
export interface ConfidenceSignals {
  /** Erros observados na janela (5xx e/ou exception dominante). */
  errorEvidence: boolean;
  /** p99 da janela ≥ 2× o baseline anterior. */
  latencyJump: boolean;
  /** Deploy dentro da janela estendida `[from−15min, to)`. */
  deployInWindow: boolean;
  /** Runbook encontrado corrobora a linha de investigação. */
  runbookCorroborates: boolean;
}

/**
 * Classificação determinística de confiança (RF17): `alta` = 3+ classes
 * independentes de evidência convergentes (erros + latência + deploy) **e**
 * runbook corrobora; `media` = 2 classes convergentes; `baixa` = 0–1 classe
 * ou dados ausentes. Função pura — mesmo input, mesmo output.
 */
export function classifyConfidence(signals: ConfidenceSignals): Confidence {
  const evidenceClasses = [signals.errorEvidence, signals.latencyJump, signals.deployInWindow].filter(
    (present) => present,
  ).length;
  if (evidenceClasses >= 3 && signals.runbookCorroborates) {
    return 'alta';
  }
  if (evidenceClasses >= 2) {
    return 'media';
  }
  return 'baixa';
}
