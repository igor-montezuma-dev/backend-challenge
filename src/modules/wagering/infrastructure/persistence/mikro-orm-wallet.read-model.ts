import { IsolationLevel, type MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../../../shared/domain/money";
import type { LedgerPage, ReconciliationSnapshot, WalletReadModel } from "../../application/ports/wallet-read-model.port";
import type { Wallet } from "../../domain/wallet/wallet";
import { LedgerEntryRecord } from "./ledger-entry.record";
import { WalletMapper } from "./wallet.mapper";
import { WalletRecord } from "./wallet.record";

interface LedgerAggregate {
  total: string;
  count: string;
  last: number | null;
}

const LEDGER_AGGREGATE_SQL = `
  SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(19,2)::text AS total,
         COUNT(*)::text AS count,
         MAX(wallet_version) AS last
    FROM wallet_ledger_entries
   WHERE wallet_id = ?`;

export class MikroOrmWalletReadModel implements WalletReadModel {
  constructor(private readonly orm: MikroORM) {}

  async findWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id: walletId });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async ledgerPage(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    const rows = await this.orm.em.fork().find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: "asc" }, limit: limit + 1 },
    );
    const page = rows.slice(0, limit);
    return {
      entries: page.map(WalletMapper.entryToDomain),
      nextAfterVersion: rows.length > limit ? page.at(-1)?.walletVersion : undefined,
    };
  }

  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    return this.orm.em.fork().transactional(
      async (em) => {
        const wallet = await em.findOne(WalletRecord, { id: walletId });
        if (!wallet) return undefined;
        const [aggregate] = await em.execute<LedgerAggregate[]>(LEDGER_AGGREGATE_SQL, [walletId]);
        return {
          wallet: WalletMapper.toDomain(wallet),
          ledgerTotal: signedMoney(aggregate!.total, wallet.currency),
          entryCount: Number.parseInt(aggregate!.count, 10),
          lastEntryVersion: aggregate!.last ?? undefined,
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }
}

function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith("-")
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
