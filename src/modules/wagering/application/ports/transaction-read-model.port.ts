import type { WagerTransaction } from "../../domain/transaction/wager-transaction";

export interface TransactionReadModel {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
}
export const TRANSACTION_READ_MODEL = Symbol("TRANSACTION_READ_MODEL");
