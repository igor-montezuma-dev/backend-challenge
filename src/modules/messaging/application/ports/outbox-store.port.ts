import type { OutboxMessage } from "../../domain/outbox-message";

export interface ClaimedOutboxMessage {
  message: OutboxMessage;
  position: bigint;
}

export interface OutboxStore {
  claimDue(owner: string, limit: number, leaseMs: number): Promise<ClaimedOutboxMessage[]>;
  hasEarlierUnpublished(partitionKey: string, position: bigint): Promise<boolean>;
  markPublished(messages: readonly OutboxMessage[]): Promise<number>;
  reschedule(message: OutboxMessage, retryInMs: number): Promise<void>;
  release(messages: readonly OutboxMessage[], owner: string): Promise<void>;
  pendingStats(): Promise<{ pending: number; oldestPendingAgeMs: number }>;
}
