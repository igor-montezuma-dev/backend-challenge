import type { EntityManager } from "@mikro-orm/postgresql";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/transaction/wager-transaction";
import type { WagerTransactionRepository } from "../../domain/transaction/wager-transaction.repository";
import { WagerTransactionMapper } from "./wager-transaction.mapper";
import { WagerTransactionRecord } from "./wager-transaction.record";

const REVERSAL_KINDS = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

const EXPEDITE_AWAITING_REFERENCE_SQL = `
  UPDATE wager_transactions
     SET next_reference_check_at = now()
   WHERE provider_id = ?
     AND reference_external_transaction_id = ?
     AND status = 'PENDING_REFERENCE'
     AND next_reference_check_at > now()`;

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id }, true);
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: REVERSAL_KINDS },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async add(transaction: WagerTransaction): Promise<void> {
    this.em.persist(WagerTransactionMapper.toNewRecord(transaction));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const record =
      this.em.getUnitOfWork().getById<WagerTransactionRecord>(WagerTransactionRecord.name, transaction.id) ??
      (await this.em.findOneOrFail(WagerTransactionRecord, { id: transaction.id }));
    WagerTransactionMapper.applyState(transaction, record);
  }

  async expediteAwaitingReference(providerId: string, externalTransactionId: string): Promise<void> {
    await this.em.execute(EXPEDITE_AWAITING_REFERENCE_SQL, [providerId, externalTransactionId]);
  }

  private async findOne(
    where: Partial<Pick<WagerTransactionRecord, "id" | "idempotencyKey" | "providerId" | "externalTransactionId">>,
    refresh = false,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { refresh });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }
}
