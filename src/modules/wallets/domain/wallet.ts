import { DomainError, ValidationError } from "../../../shared/domain/domain-error";
import { CurrencyMismatchError, Money } from "../../../shared/domain/money";
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

/** Identificadores do movimento — gerados fora do domínio (IdGenerator). */
export interface MovementRef {
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

/**
 * Aggregate root. O saldo só muda por `debit`/`credit`, e cada mudança devolve
 * o lançamento correspondente — é impossível alterar o saldo sem produzir o
 * lançamento (saldo e ledger andam juntos por construção).
 *
 * Concorrência: a instância não se protege sozinha. O repositório carrega a
 * wallet com SELECT ... FOR UPDATE (lock pessimista por linha), e o schema
 * recusa lost update via UNIQUE(wallet_id, wallet_version) no ledger.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet em version 1. Saldo inicial > 0 gera o lançamento de
   * abertura (CREDIT, wallet_version 1), vinculado à transação interna OPENING.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    opening: MovementRef;
  }): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    if (props.initialBalance.isNegative()) {
      throw new ValidationError("initial balance cannot be negative", "initialBalance");
    }
    const at = props.opening.at;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      at,
      at,
    );
    const openingEntry = props.initialBalance.isZero()
      ? undefined
      : WalletLedgerEntry.create({
          id: props.opening.ledgerEntryId,
          walletId: wallet.id,
          transactionId: props.opening.transactionId,
          walletVersion: 1,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: props.initialBalance,
          createdAt: at,
        });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
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

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** @throws InsufficientFundsError — o saldo nunca fica negativo. */
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

  private apply(direction: LedgerDirection, money: Money, ref: MovementRef): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    // Lançamento primeiro: se a aritmética falhar, o estado da wallet não muda.
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
    this._version += 1; // só incrementa quando o saldo muda
    this._updatedAt = ref.at;
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
