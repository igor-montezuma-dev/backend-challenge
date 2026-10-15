import { DomainError, ValidationError } from "../../../../shared/domain/domain-error";
import { CurrencyMismatchError, Money } from "../../../../shared/domain/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(
    readonly walletId: string,
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(`wallet ${walletId} has ${balance}, cannot debit ${requested}`);
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementRef {
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  opening: MovementRef;
}

const INITIAL_VERSION = 1;

export class Wallet {
  private readonly uncommittedEntries: WalletLedgerEntry[] = [];

  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new ValidationError("initial balance cannot be negative", "initialBalance");
    }
    const { at } = props.opening;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      INITIAL_VERSION,
      at,
      at,
    );
    if (props.initialBalance.isPositive()) {
      wallet.uncommittedEntries.push(
        WalletLedgerEntry.create({
          id: props.opening.ledgerEntryId,
          walletId: wallet.id,
          transactionId: props.opening.transactionId,
          walletVersion: INITIAL_VERSION,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: props.initialBalance,
          createdAt: at,
        }),
      );
    }
    return wallet;
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get pendingEntries(): readonly WalletLedgerEntry[] {
    return [...this.uncommittedEntries];
  }

  pullPendingEntries(): WalletLedgerEntry[] {
    return this.uncommittedEntries.splice(0);
  }

  belongsTo(playerId: string): boolean {
    return this.playerId === playerId;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, ref: MovementRef): WalletLedgerEntry {
    this.assertMovable(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(this.id, this._balance, money);
    }
    return this.apply(LedgerDirection.Debit, money, ref);
  }

  credit(money: Money, ref: MovementRef): WalletLedgerEntry {
    this.assertMovable(money);
    return this.apply(LedgerDirection.Credit, money, ref);
  }

  move(direction: LedgerDirection, money: Money, ref: MovementRef): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(money, ref) : this.credit(money, ref);
  }

  private apply(direction: LedgerDirection, money: Money, ref: MovementRef): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: ref.ledgerEntryId,
      walletId: this.id,
      transactionId: ref.transactionId,
      walletVersion: this._version + 1,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: ref.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = ref.at;
    this.uncommittedEntries.push(entry);
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new ValidationError("movement amount must be positive", "money");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (!money.hasCurrency(this.currency)) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
