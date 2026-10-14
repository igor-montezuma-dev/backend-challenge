import { InvalidStateTransitionError } from "../../../shared/domain/domain-error";
import type { IntegrationEvent, IntegrationEventEnvelope } from "../../../shared/domain/integration-event";

export interface OutboxRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * Sem limite de tentativas de propósito: o evento já foi confirmado junto com
 * a transação financeira e não pode ser perdido. Falhas persistentes aparecem
 * na métrica de outbox lag/attempts, não em descarte silencioso.
 */
export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = Object.freeze({
  baseDelayMs: 500,
  maxDelayMs: 60_000,
});

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  partitionKey: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
  lastError?: string | undefined;
}

export class OutboxMessage {
  private constructor(
    /** = eventId: o consumidor deduplica por ele. */
    readonly id: string,
    readonly aggregateId: string,
    readonly partitionKey: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  static enqueue<T>(event: IntegrationEvent<T>): OutboxMessage {
    const envelope: IntegrationEventEnvelope<T> = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.partitionKey,
      event.eventType,
      Object.freeze(envelope as unknown as Record<string, unknown>),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.partitionKey,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidStateTransitionError(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._attempts += 1;
  }

  /** Incrementa attempts e agenda a próxima tentativa com backoff exponencial. */
  scheduleRetry(now: Date, error: string, policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY): void {
    if (!this.isPending()) {
      throw new InvalidStateTransitionError(`outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    const delay = Math.min(policy.baseDelayMs * 2 ** Math.min(this._attempts - 1, 30), policy.maxDelayMs);
    this._nextAttemptAt = new Date(now.getTime() + delay);
    this._lastError = error.slice(0, 1_000);
  }
}
