import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../src/shared/domain/domain-error";
import { Money } from "../../src/shared/domain/money";
import { FailureCode } from "../../src/modules/wagering/domain/transaction/failure-code";
import { wagerPayloadHash } from "../../src/modules/wagering/domain/transaction/wager-payload";
import { DEFAULT_REFERENCE_RETRY_POLICY as POLICY } from "../../src/modules/wagering/domain/transaction/reference-retry-policy";
import {
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionStatus as Status,
} from "../../src/modules/wagering/domain/transaction/wager-transaction";
import { LedgerDirection } from "../../src/modules/wagering/domain/wallet/wallet-ledger-entry";
import { Kind, T0, brl, wager, wagerProps } from "./support/builders";

describe("WagerTransaction.create — validação por tipo", () => {
  test("nasce em PENDING", () => {
    const tx = wager(Kind.Bet, "10.00");
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  test("OPENING não pode ser submetido", () => {
    expect(() => wager(Kind.Opening, "10.00")).toThrow(ValidationError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s exige referência", (kind) => {
    expect(() => wager(kind, "10.00")).toThrow(ValidationError);
    expect(wager(kind, "10.00", { referenceExternalTransactionId: "bet-1" }).requiresReference()).toBe(true);
  });

  test("BET não pode referenciar outra transação", () => {
    expect(() => wager(Kind.Bet, "10.00", { referenceExternalTransactionId: "x" })).toThrow(ValidationError);
  });

  test("WIN e LOSS aceitam referência opcional", () => {
    expect(wager(Kind.Win, "10.00").hasReference()).toBe(false);
    expect(wager(Kind.Win, "10.00", { referenceExternalTransactionId: "bet-1" }).hasReference()).toBe(true);
    expect(wager(Kind.Loss, "0.00", { referenceExternalTransactionId: "bet-1" }).hasReference()).toBe(true);
  });

  test("valor zero só é aceito em LOSS", () => {
    expect(wager(Kind.Loss, "0.00").affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(() => wager(kind, "0.00")).toThrow(ValidationError);
    }
  });

  test("auto-referência e campos vazios são rejeitados", () => {
    expect(() => wager(Kind.Refund, "1.00", { externalTransactionId: "x", referenceExternalTransactionId: "x" })).toThrow(ValidationError);
    expect(() => wager(Kind.Bet, "1.00", { roundId: "" })).toThrow(ValidationError);
    expect(() => wager(Kind.Bet, "1.00", { providerId: "p".repeat(129) })).toThrow(ValidationError);
  });

  test("opening é interno e já nasce PROCESSED", () => {
    const tx = WagerTransaction.opening({
      id: "o-1", providerId: "internal", externalTransactionId: "opening:w-1", idempotencyKey: "internal:opening:w-1",
      payloadHash: "0".repeat(64), walletId: "w-1", playerId: "p-1", roundId: "opening", gameId: "internal",
      money: brl("100.00"), createdAt: T0,
    });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe("WagerTransaction — máquina de estados", () => {
  test("PENDING → PROCESSED guarda referência, saldo e instante", () => {
    const tx = wager(Kind.Win, "10.00");
    tx.markProcessed("bet-id", brl("110.00"), T0);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe("bet-id");
    expect(tx.balanceAfter?.amount).toBe("110.00");
    expect(tx.processedAt).toEqual(T0);
  });

  test("PENDING → REJECTED guarda failureCode", () => {
    const tx = wager(Kind.Bet, "10.00");
    tx.reject(FailureCode.InsufficientFunds, brl("5.00"));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test("estados terminais não mudam mais (erro de programação)", () => {
    const processed = wager(Kind.Bet, "1.00");
    processed.markProcessed(undefined, brl("0.00"), T0);
    const rejected = wager(Kind.Bet, "1.00");
    rejected.reject(FailureCode.InsufficientFunds, undefined);
    const failed = wager(Kind.Bet, "1.00");
    failed.fail(FailureCode.ProcessingFailed);

    for (const tx of [processed, rejected, failed]) {
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, brl("1.00"), T0)).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientFunds, undefined)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.ProcessingFailed)).toThrow(InvalidTransactionStateError);
    }
  });

  test("PENDING_REFERENCE agenda checagens com backoff exponencial", () => {
    const tx = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-x" });
    tx.markPendingReference(T0, POLICY);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceCheckAt!.getTime() - T0.getTime()).toBe(1_000);

    tx.markPendingReference(T0, POLICY);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceCheckAt!.getTime() - T0.getTime()).toBe(2_000);

    for (let i = 0; i < 20; i++) tx.markPendingReference(T0, POLICY);
    expect(tx.nextReferenceCheckAt!.getTime() - T0.getTime()).toBe(POLICY.maxDelayMs);
  });

  test("espera esgota por número de tentativas ou por idade", () => {
    const byAttempts = wager(Kind.Refund, "1.00", { referenceExternalTransactionId: "b" });
    byAttempts.markPendingReference(T0, POLICY);
    for (let i = 0; i < POLICY.maxAttempts - 2; i++) byAttempts.markPendingReference(T0, POLICY);
    expect(byAttempts.isReferenceWaitExhausted(T0, POLICY)).toBe(false);
    byAttempts.markPendingReference(T0, POLICY);
    expect(byAttempts.isReferenceWaitExhausted(T0, POLICY)).toBe(true);

    const byAge = wager(Kind.Refund, "1.00", { referenceExternalTransactionId: "b" });
    byAge.markPendingReference(T0, POLICY);
    expect(byAge.isReferenceWaitExhausted(new Date(T0.getTime() + POLICY.maxAgeMs), POLICY)).toBe(true);
  });

  test("PENDING_REFERENCE pode terminar em PROCESSED ou REJECTED", () => {
    const a = wager(Kind.Refund, "1.00", { referenceExternalTransactionId: "b" });
    a.markPendingReference(T0, POLICY);
    a.markProcessed("bet", brl("1.00"), T0);
    expect(a.status).toBe(Status.Processed);
    expect(a.nextReferenceCheckAt).toBeUndefined();

    const b = wager(Kind.Refund, "1.00", { referenceExternalTransactionId: "b" });
    b.markPendingReference(T0, POLICY);
    b.reject(FailureCode.ReferenceNotFound, brl("0.00"));
    expect(b.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test("transação sem referência não pode aguardar referência", () => {
    expect(() => wager(Kind.Bet, "1.00").markPendingReference(T0, POLICY)).toThrow(InvalidTransactionStateError);
  });
});

describe("WagerTransaction — direção do lançamento", () => {
  const bet = wager(Kind.Bet, "10.00");
  const win = wager(Kind.Win, "10.00");
  const refund = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "b" });
  const rollback = wager(Kind.Rollback, "10.00", { referenceExternalTransactionId: "b" });

  test("BET debita; WIN e REFUND creditam", () => {
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverte a direção da referência", () => {
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test("tipos de referência permitidos", () => {
    expect(refund.canReference(bet)).toBe(true);
    expect(refund.canReference(win)).toBe(false);
    expect(rollback.canReference(bet)).toBe(true);
    expect(rollback.canReference(win)).toBe(true);
    expect(rollback.canReference(refund)).toBe(true);
    expect(rollback.canReference(rollback)).toBe(false);
    expect(win.canReference(bet)).toBe(true);
    expect(win.canReference(win)).toBe(false);
  });
});

describe("idempotência — hash do payload", () => {
  test("mesmo payload → mesmo hash, independente da ordem das chaves", () => {
    const a = wagerProps(Kind.Bet, "25.00", { externalTransactionId: "t-1" });
    const b = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(wagerPayloadHash(a)).toBe(wagerPayloadHash(b));
    expect(wagerPayloadHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("qualquer campo de negócio diferente → hash diferente", () => {
    const base = wagerProps(Kind.Bet, "25.00", { externalTransactionId: "t-1" });
    const variants = [
      { ...base, money: brl("25.01") },
      { ...base, money: Money.from({ amount: "25.00", currency: "USD" }) },
      { ...base, roundId: "round-2" },
      { ...base, gameId: "other" },
      { ...base, playerId: "player-2" },
      { ...base, kind: Kind.Win },
      { ...base, referenceExternalTransactionId: "x" },
    ];
    for (const v of variants) expect(wagerPayloadHash(v)).not.toBe(wagerPayloadHash(base));
  });

  test("mesma idempotency key com payload divergente não é replay", () => {
    const original = wager(Kind.Bet, "25.00", { externalTransactionId: "t-1" });
    const divergent = wagerProps(Kind.Bet, "30.00", { externalTransactionId: "t-1" });
    expect(divergent.idempotencyKey).toBe(original.idempotencyKey);
    expect(original.matchesPayload(wagerPayloadHash(divergent))).toBe(false);
    expect(original.matchesPayload(original.payloadHash)).toBe(true);
  });
});
