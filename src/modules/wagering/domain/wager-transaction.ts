import { InvalidStateTransitionError, ValidationError } from "../../../shared/domain/domain-error";
import { Money } from "../../../shared/domain/money";
import { LedgerDirection } from "../../wallets/domain/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import { type ReferenceRetryPolicy, referenceRetryDelayMs } from "./reference-retry-policy";

export enum WagerTransactionKind {
  Opening = "OPENING", // interno: crédito de abertura da wallet
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // aceita, ainda não aplicada
  PendingReference = "PENDING_REFERENCE", // aguardando a transação referenciada
  Processed = "PROCESSED", // aplicada (terminal)
  Rejected = "REJECTED", // violação de regra de negócio (terminal)
  Failed = "FAILED", // erro permanente de infraestrutura (terminal, auditável)
}

/** Tipos que podem chegar pela API ou pela fila (OPENING é interno). */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/**
 * Máquina de estados:
 *
 *   PENDING ──────────┬──> PROCESSED
 *      │              ├──> REJECTED
 *      v              └──> FAILED
 *   PENDING_REFERENCE ─┬─> (si mesma: nova tentativa agendada)
 *                      ├──> PROCESSED
 *                      ├──> REJECTED (inclusive REFERENCE_NOT_FOUND ao esgotar)
 *                      └──> FAILED
 *
 * PROCESSED, REJECTED e FAILED são terminais.
 */
const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Tipos aceitos como referência, por tipo de operação. */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  balanceAfter?: Money | undefined;
  processedAt?: Date | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date | undefined;
}

export class InvalidTransactionStateError extends InvalidStateTransitionError {}

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** id no provedor — não o id interno */
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _balanceAfter: Money | undefined,
    private _processedAt: Date | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
  ) {}

  /**
   * Operação submetida por provedor (API ou fila). Nasce em PENDING.
   * Valida forma e exigência de referência por tipo; regras que dependem do
   * estado (saldo, referência existente) ficam no WagerSettlement.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!SUBMITTABLE_KINDS.includes(props.kind)) {
      throw new ValidationError(`kind ${String(props.kind)} cannot be submitted`, "kind");
    }
    WagerTransaction.validateCommon(props);
    return WagerTransaction.fresh(props);
  }

  /** Transação interna de abertura da wallet — nasce e é aplicada no mesmo passo. */
  static opening(props: Omit<CreateWagerTransactionProps, "kind" | "referenceExternalTransactionId">): WagerTransaction {
    const tx = WagerTransaction.fresh({ ...props, kind: WagerTransactionKind.Opening, referenceExternalTransactionId: undefined });
    if (!props.money.isPositive()) {
      throw new ValidationError("opening amount must be positive", "money");
    }
    tx.markProcessed(undefined, props.money, props.createdAt);
    return tx;
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.balanceAfter,
      state.processedAt,
      state.referenceAttempts,
      state.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  /** Saldo observado quando a transação foi finalizada — devolvido no replay. */
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transições -----------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this._nextReferenceCheckAt = undefined;
  }

  /**
   * Entra (ou permanece) em PENDING_REFERENCE e agenda a próxima checagem com
   * backoff exponencial. Cada chamada conta como uma tentativa.
   */
  markPendingReference(now: Date, policy: ReferenceRetryPolicy): void {
    this.assertNotTerminal("markPendingReference");
    if (!this.hasReference()) {
      throw new InvalidTransactionStateError(`transaction ${this.id} has no reference to wait for`);
    }
    const attempt = this._status === WagerTransactionStatus.PendingReference ? this._referenceAttempts + 1 : 0;
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts = attempt;
    this._nextReferenceCheckAt = new Date(now.getTime() + referenceRetryDelayMs(policy, attempt));
  }

  /** Esgotou tentativas ou o TTL de espera pela referência? */
  isReferenceWaitExhausted(now: Date, policy: ReferenceRetryPolicy): boolean {
    if (this._status !== WagerTransactionStatus.PendingReference) return false;
    return (
      this._referenceAttempts + 1 >= policy.maxAttempts ||
      now.getTime() - this.createdAt.getTime() >= policy.maxAgeMs
    );
  }

  reject(code: FailureCode, balanceAtRejection: Money | undefined): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAtRejection;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
  }

  // ---- consultas de domínio ---------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** LOSS registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  /** Comparação do hash do payload canônico (idempotência). */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  canReference(reference: WagerTransaction): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind]?.includes(reference.kind) ?? false;
  }

  /**
   * Direção do lançamento que esta transação produz.
   * ROLLBACK inverte a direção da referência (BET → crédito; WIN/REFUND → débito).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError("ROLLBACK needs its reference to know the ledger direction");
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError("LOSS does not produce a ledger entry");
    }
  }

  // ---- internos -------------------------------------------------------------

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `cannot ${operation}: transaction ${this.id} is already ${this._status}`,
      );
    }
  }

  private static fresh(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  private static validateCommon(props: CreateWagerTransactionProps): void {
    const text = (value: unknown, field: string, max: number): void => {
      if (typeof value !== "string" || value.length === 0 || value.length > max) {
        throw new ValidationError(`${field} must be a non-empty string up to ${max} chars`, field);
      }
    };
    text(props.providerId, "providerId", 128);
    text(props.externalTransactionId, "externalTransactionId", 256);
    text(props.idempotencyKey, "idempotencyKey", 512);
    text(props.roundId, "roundId", 256);
    text(props.gameId, "gameId", 256);

    const isLoss = props.kind === WagerTransactionKind.Loss;
    if (props.money.isNegative() || (!isLoss && props.money.isZero())) {
      throw new ValidationError(
        isLoss ? "money cannot be negative" : `money must be positive for ${props.kind}`,
        "money",
      );
    }

    const ref = props.referenceExternalTransactionId;
    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && ref === undefined) {
      throw new ValidationError(`${props.kind} requires referenceExternalTransactionId`, "referenceExternalTransactionId");
    }
    if (props.kind === WagerTransactionKind.Bet && ref !== undefined) {
      throw new ValidationError("BET cannot reference another transaction", "referenceExternalTransactionId");
    }
    if (ref !== undefined) {
      text(ref, "referenceExternalTransactionId", 256);
      if (ref === props.externalTransactionId) {
        throw new ValidationError("a transaction cannot reference itself", "referenceExternalTransactionId");
      }
    }
  }
}
