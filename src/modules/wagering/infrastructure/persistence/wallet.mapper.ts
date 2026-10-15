import { Money } from "../../../../shared/domain/money";
import { Wallet } from "../../domain/wallet/wallet";
import { type LedgerDirection, WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { LedgerEntryRecord } from "./ledger-entry.record";
import { WalletRecord } from "./wallet.record";

export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.from({ amount: record.balance, currency: record.currency }),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toRecord(wallet: Wallet, target: WalletRecord = new WalletRecord()): WalletRecord {
    return Object.assign(target, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  },

  entryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      walletVersion: record.walletVersion,
      direction: record.direction as LedgerDirection,
      money: money(record.amount),
      balanceBefore: money(record.balanceBefore),
      balanceAfter: money(record.balanceAfter),
      createdAt: record.createdAt,
    });
  },

  entryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return Object.assign(new LedgerEntryRecord(), {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      walletVersion: entry.walletVersion,
      direction: entry.direction,
      amount: entry.money.amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      createdAt: entry.createdAt,
    });
  },
};
