import type { ReconciliationReport } from "../../application/use-cases/reconcile-wallet.use-case";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export const WalletPresenter = {
  created: (wallet: Wallet) => ({
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  }),

  detail: (wallet: Wallet) => ({
    ...WalletPresenter.created(wallet),
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  }),

  ledgerEntry: (entry: WalletLedgerEntry) => ({
    id: entry.id,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  }),

  reconciliation: (report: ReconciliationReport) => ({
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
    walletVersion: report.walletVersion,
    lastEntryVersion: report.lastEntryVersion ?? null,
    checkedAt: report.checkedAt.toISOString(),
  }),
};
