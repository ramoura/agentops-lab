import type { EvalCase, EvalCaseResult, EvalCriterionResult, EvalScorer, FindingSpec, InvestigationReport } from '@agentops/types';

/**
 * Scorer 100% determinístico (RF26): matching de termos case/acento-insensível
 * sobre o texto renderizado + critérios estruturais sobre o `InvestigationReport`
 * — sem LLM, mesma entrada → mesmo resultado. O resultado lista critério a
 * critério o que passou e o que falhou (RF27), na ordem: findings esperados,
 * termos proibidos, `cita_evidencias`, `separa_fato_de_hipotese`,
 * `proximos_passos_seguros`.
 */
export class DeterministicEvalScorer implements EvalScorer {
  score(evalCase: EvalCase, report: InvestigationReport, renderedText: string): EvalCaseResult {
    const text = normalize(renderedText);
    const criteria: EvalCriterionResult[] = [
      ...evalCase.expected_findings.map((finding) => scoreFinding(finding, text)),
      ...evalCase.must_not_include.map((term) => scoreForbidden(term, text)),
      scoreCitesEvidences(report),
      scoreSeparatesFactFromHypothesis(report, text),
      scoreSafeNextSteps(report),
    ];

    const approved = criteria.filter((criterion) => criterion.passed).length;
    const score = Math.round((approved / criteria.length) * 100) / 100;
    return {
      caseId: evalCase.id,
      criteria,
      score,
      passed: approved === criteria.length,
    };
  }
}

/** Normalização do matching: sem acentos, sem caixa (RF26 / teste 52). */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Rótulo canônico de um FindingSpec — 1ª variante; nome estável do critério (RF27). */
export function primaryVariant(spec: FindingSpec): string {
  return Array.isArray(spec) ? spec[0]! : spec;
}

/** Candidatos de matching any-of — string única vira lista de 1 elemento. */
export function variants(spec: FindingSpec): string[] {
  return Array.isArray(spec) ? spec : [spec];
}

/**
 * V1 não ganha tolerância de fraseado (V2.1): o motor determinístico gera
 * texto por template fixo, sem variação de fraseado — compara sempre a
 * variante primária, mesmo quando `spec` traz aliases.
 */
function scoreFinding(spec: FindingSpec, normalizedText: string): EvalCriterionResult {
  const label = primaryVariant(spec);
  const passed = normalizedText.includes(normalize(label));
  return {
    name: `finding:${label}`,
    passed,
    details: passed ? 'encontrado no relatório' : `"${label}" não aparece no relatório`,
  };
}

function scoreForbidden(spec: FindingSpec, normalizedText: string): EvalCriterionResult {
  const label = primaryVariant(spec);
  const passed = !normalizedText.includes(normalize(label));
  return {
    name: `proibido:${label}`,
    passed,
    details: passed ? 'ausente' : `termo proibido "${label}" presente no relatório`,
  };
}

/** Toda evidência precisa citar a tool e a referência que a sustentam (RF5). */
function scoreCitesEvidences(report: InvestigationReport): EvalCriterionResult {
  const cited = report.evidences.filter(
    (evidence) => evidence.source.tool.trim() !== '' && evidence.source.reference.trim() !== '',
  ).length;
  const total = report.evidences.length;
  const passed = cited === total;
  return {
    name: 'cita_evidencias',
    passed,
    details: passed ? `${cited}/${total} evidências com source` : `${total - cited} evidência(s) sem citação de source`,
  };
}

/**
 * Fato e hipótese em seções distintas e não vazias. No cenário de dados
 * ausentes (US9), hipótese/evidências vazias com `missingData` preenchido
 * também passam — declarar a ausência é a separação correta (teste 56).
 */
function scoreSeparatesFactFromHypothesis(report: InvestigationReport, normalizedText: string): EvalCriterionResult {
  const hasEvidenceSection = normalizedText.includes('evidencias encontradas');
  const hasHypothesisSection = normalizedText.includes('hipotese principal');
  const declaresMissingData = report.missingData.length > 0;
  const factsOk = report.evidences.length > 0 || declaresMissingData;
  const hypothesisOk = report.primaryHypothesis !== null || declaresMissingData;

  const problems: string[] = [];
  if (!hasEvidenceSection) problems.push('seção "Evidências encontradas" ausente');
  if (!hasHypothesisSection) problems.push('seção "Hipótese principal" ausente');
  if (!factsOk) problems.push('sem evidências e sem dados faltantes declarados');
  if (!hypothesisOk) problems.push('sem hipótese e sem dados faltantes declarados');

  const passed = problems.length === 0;
  return {
    name: 'separa_fato_de_hipotese',
    passed,
    details: passed ? 'seções Evidências e Hipótese presentes e distintas' : problems.join('; '),
  };
}

/**
 * Termos destrutivos definidos pelo próprio eval (juiz independente do
 * validador do engine, de propósito): se o core regredir, o eval acusa.
 */
const DESTRUCTIVE_TERMS = [
  'rollback',
  'reiniciar',
  'restart',
  'reboot',
  'apagar',
  'deletar',
  'delete',
  'excluir',
  'remover',
  'drop',
  'truncate',
  'kill',
  'desligar',
  'derrubar',
  'shutdown',
  'rm -rf',
];

function isDestructive(step: string): boolean {
  const normalized = normalize(step);
  return DESTRUCTIVE_TERMS.some((term) => normalized.includes(term));
}

/** Lista não vazia e 1º passo nunca destrutivo (RF17 / teste 57). */
function scoreSafeNextSteps(report: InvestigationReport): EvalCriterionResult {
  const steps = report.safeNextSteps;
  if (steps.length === 0) {
    return { name: 'proximos_passos_seguros', passed: false, details: 'lista de próximos passos vazia' };
  }
  const first = steps[0] as string;
  if (isDestructive(first)) {
    return {
      name: 'proximos_passos_seguros',
      passed: false,
      details: `1º passo é destrutivo: "${first}"`,
    };
  }
  return {
    name: 'proximos_passos_seguros',
    passed: true,
    details: `${steps.length} passo(s); nenhum destrutivo em 1ª posição`,
  };
}
