import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletRepository } from "../../domain/wallet/wallet.repository";
import { WalletMapper } from "./wallet.mapper";
import { WalletRecord } from "./wallet.record";

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async add(wallet: Wallet): Promise<void> {
    this.em.persist(WalletMapper.toRecord(wallet));
    this.persistPendingEntries(wallet);
  }

  async save(wallet: Wallet): Promise<void> {
    const record = this.em.getUnitOfWork().getById<WalletRecord>(WalletRecord.name, wallet.id);
    if (!record) throw new Error(`wallet ${wallet.id} must be locked before being saved`);
    WalletMapper.toRecord(wallet, record);
    this.persistPendingEntries(wallet);
  }

  private persistPendingEntries(wallet: Wallet): void {
    for (const entry of wallet.pullPendingEntries()) this.em.persist(WalletMapper.entryToRecord(entry));
  }
}
