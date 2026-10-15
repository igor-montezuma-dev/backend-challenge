import type { Money } from "../../../../shared/domain/money";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextAfterVersion: number | undefined;
}

export interface ReconciliationSnapshot {
  wallet: Wallet;
  ledgerTotal: Money;
  entryCount: number;
  lastEntryVersion: number | undefined;
}

export interface WalletReadModel {
  findWallet(walletId: string): Promise<Wallet | undefined>;
  ledgerPage(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage>;
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}
export const WALLET_READ_MODEL = Symbol("WALLET_READ_MODEL");
