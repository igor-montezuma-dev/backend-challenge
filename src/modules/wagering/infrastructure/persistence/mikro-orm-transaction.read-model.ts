import type { MikroORM } from "@mikro-orm/postgresql";
import type { TransactionReadModel } from "../../application/ports/transaction-read-model.port";
import type { WagerTransaction } from "../../domain/transaction/wager-transaction";
import { WagerTransactionMapper } from "./wager-transaction.mapper";
import { WagerTransactionRecord } from "./wager-transaction.record";

export class MikroOrmTransactionReadModel implements TransactionReadModel {
  constructor(private readonly orm: MikroORM) {}

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  private async findOne(
    where: Partial<Pick<WagerTransactionRecord, "id" | "providerId" | "externalTransactionId">>,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.orm.em.fork().findOne(WagerTransactionRecord, where);
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }
}
