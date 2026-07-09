/**
 * Percentil com interpolação linear entre os dois pontos mais próximos
 * (método "linear", o default do NumPy). Escolha documentada conforme o risco
 * "Percentis com poucos pontos" da techspec: com ~30 pontos por janela o erro
 * do estimador é irrelevante frente ao sinal (450ms → 3200ms).
 * Retorna `null` para lista vazia — chamador decide como representar ausência.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  if (p < 0 || p > 100) {
    throw new RangeError(`percentil deve estar entre 0 e 100 (recebido: ${p})`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  return lowerValue + (upperValue - lowerValue) * (rank - lower);
}

/** Mediana — usada para agregar percentis por minuto em um "overall" da janela. */
export function median(values: readonly number[]): number | null {
  return percentile(values, 50);
}
