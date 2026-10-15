import type { WagerTransaction } from "./wager-transaction";

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
  add(transaction: WagerTransaction): Promise<void>;
  save(transaction: WagerTransaction): Promise<void>;
  expediteAwaitingReference(providerId: string, externalTransactionId: string): Promise<void>;
}
