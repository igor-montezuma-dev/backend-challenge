import { InvalidStateTransitionError } from "../../../../shared/domain/domain-error";
import { Money } from "../../../../shared/domain/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly walletVersion: number,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.money.isPositive()) {
      throw new InvalidStateTransitionError("ledger entry amount must be positive");
    }
    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new InvalidStateTransitionError("ledger entry cannot produce a negative balance");
    }
    if (!Number.isInteger(entry.walletVersion) || entry.walletVersion < 1) {
      throw new InvalidStateTransitionError("ledger entry wallet version must be >= 1");
    }
    if (!entry.isBalanced()) {
      throw new InvalidStateTransitionError(
        `unbalanced ledger entry: ${entry.balanceBefore} ${entry.direction} ${entry.money} != ${entry.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.walletVersion,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
