import type { Clock } from "../../../../shared/application/clock";
import type { Money } from "../../../../shared/domain/money";
import type { WalletReadModel } from "../ports/wallet-read-model.port";
import { WalletNotFoundError } from "../errors";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  walletVersion: number;
  lastEntryVersion: number | undefined;
  checkedAt: Date;
}

export interface ReconciliationObserver {
  onDivergence(report: ReconciliationReport): void;
}

export class ReconcileWallet {
  constructor(
    private readonly readModel: WalletReadModel,
    private readonly clock: Clock,
    private readonly observer: ReconciliationObserver,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.readModel.reconciliationSnapshot(walletId);
    if (!snapshot) throw new WalletNotFoundError(walletId);

    const { wallet, ledgerTotal } = snapshot;
    const difference = wallet.balance.subtract(ledgerTotal);
    const expectedLastVersion = wallet.version === 1 && wallet.balance.isZero() ? undefined : wallet.version;
    const consistent = difference.isZero() && snapshot.lastEntryVersion === expectedLastVersion;

    const report: ReconciliationReport = {
      walletId: wallet.id,
      storedBalance: wallet.balance,
      calculatedBalance: ledgerTotal,
      difference,
      consistent,
      checkedEntries: snapshot.entryCount,
      walletVersion: wallet.version,
      lastEntryVersion: snapshot.lastEntryVersion,
      checkedAt: this.clock.now(),
    };
    if (!consistent) this.observer.onDivergence(report);
    return report;
  }
}
