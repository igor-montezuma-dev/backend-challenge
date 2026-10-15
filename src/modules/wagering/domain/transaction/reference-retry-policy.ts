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

export function referenceRetryDelayMs(policy: ReferenceRetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * 2 ** Math.min(attempt, 30);
  return Math.min(exponential, policy.maxDelayMs);
}
