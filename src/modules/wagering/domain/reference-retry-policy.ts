/**
 * Política de espera por referências fora de ordem (seção 7.1).
 *
 * Backoff exponencial: base * 2^tentativa, limitado a maxDelay. Com os
 * padrões (1s base, teto de 5min, 12 tentativas) a espera total é de ~25min:
 *   1+2+4+8+16+32+64+128+256+300+300+300 s ≈ 1411 s.
 *
 * Justificativa: reordenação em filas/retries de provedor acontece em segundos
 * ou poucos minutos; esperar ~25min cobre redeliveries do SQS (visibility
 * timeout × maxReceiveCount) e reenvios do provedor com folga, sem deixar uma
 * operação "pendurada" por horas. O prazo também é limitado por TTL absoluto
 * (maxAge), que vale mesmo se o worker ficar parado por um tempo.
 */
export interface ReferenceRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
  readonly maxAgeMs: number;
}

export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicy = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  maxAttempts: 12,
  maxAgeMs: 60 * 60_000,
});

/** Atraso antes da tentativa `attempt` (0 = primeira reavaliação). */
export function referenceRetryDelayMs(policy: ReferenceRetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * 2 ** Math.min(attempt, 30);
  return Math.min(exponential, policy.maxDelayMs);
}
