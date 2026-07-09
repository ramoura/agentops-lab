import type { InvestigationAssistant, InvestigationOutcome, ToolInvoker } from '@agentops/types';
import { DeterministicInvestigationEngine } from './engine.js';
import { PtBrQuestionParser } from './question-parser.js';

/** O motor determinístico nunca produz a variante `markdown` (exclusiva do motor LLM). */
export type DeterministicOutcome = Extract<InvestigationOutcome, { kind: 'report' | 'clarification' }>;

/**
 * Adapter de composição da V1 atrás da interface `InvestigationAssistant`
 * (V2): encadeia `PtBrQuestionParser` + `DeterministicInvestigationEngine`
 * sem nenhuma mudança de comportamento. Pergunta ambígua vira `clarification`
 * sem invocar tool alguma (RF3/US10); pergunta válida produz o mesmo
 * `InvestigationReport` da V1 (RF4–RF7 preservados por construção).
 */
export class DeterministicInvestigationAssistant implements InvestigationAssistant {
  private readonly parser = new PtBrQuestionParser();
  private readonly engine = new DeterministicInvestigationEngine();

  async investigate(question: string, tools: ToolInvoker): Promise<DeterministicOutcome> {
    const parsed = this.parser.parse(question);
    if (!parsed.ok) {
      return { kind: 'clarification', missing: parsed.missing };
    }
    const report = await this.engine.investigate(parsed.context, tools);
    return { kind: 'report', report };
  }
}
