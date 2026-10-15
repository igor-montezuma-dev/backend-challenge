import { describe, expect, test } from "bun:test";
import { ReferencePolicy } from "../../src/modules/wagering/domain/settlement/reference-policy";
import { FailureCode } from "../../src/modules/wagering/domain/transaction/failure-code";
import type { WagerTransaction } from "../../src/modules/wagering/domain/transaction/wager-transaction";
import { Kind, T0, brl, wager } from "./support/builders";

const processed = (tx: WagerTransaction): WagerTransaction => {
  tx.markProcessed(undefined, brl("100.00"), T0);
  return tx;
};

const evaluate = (tx: WagerTransaction, reference?: WagerTransaction, referenceAlreadyReversed = false) =>
  ReferencePolicy.evaluate(tx, { reference, referenceAlreadyReversed });

describe("ReferencePolicy", () => {
  test("transação sem referência: não se aplica", () => {
    expect(evaluate(wager(Kind.Bet, "1.00"))).toEqual({ kind: "not_applicable" });
  });

  test("referência ausente ou ainda não liquidada: aguardar", () => {
    const refund = wager(Kind.Refund, "1.00", { referenceExternalTransactionId: "bet" });
    expect(evaluate(refund)).toEqual({ kind: "await" });
    expect(evaluate(refund, wager(Kind.Bet, "1.00", { externalTransactionId: "bet" }))).toEqual({ kind: "await" });
  });

  test("referência elegível", () => {
    const bet = processed(wager(Kind.Bet, "1.00", { externalTransactionId: "bet" }));
    const refund = wager(Kind.Refund, "1.00", { referenceExternalTransactionId: "bet" });
    expect(evaluate(refund, bet)).toEqual({ kind: "eligible", reference: bet });
  });

  test.each([
    ["rejeitada", FailureCode.ReferenceNotProcessed, () => {
      const bet = wager(Kind.Bet, "1.00", { externalTransactionId: "bet" });
      bet.reject(FailureCode.InsufficientFunds, undefined);
      return { tx: wager(Kind.Refund, "1.00", { referenceExternalTransactionId: "bet" }), reference: bet, reversed: false };
    }],
    ["outra rodada", FailureCode.ReferenceMismatch, () => ({
      tx: wager(Kind.Refund, "1.00", { referenceExternalTransactionId: "bet", roundId: "other" }),
      reference: processed(wager(Kind.Bet, "1.00", { externalTransactionId: "bet" })),
      reversed: false,
    })],
    ["tipo inválido", FailureCode.InvalidReferenceKind, () => ({
      tx: wager(Kind.Refund, "1.00", { referenceExternalTransactionId: "win" }),
      reference: processed(wager(Kind.Win, "1.00", { externalTransactionId: "win" })),
      reversed: false,
    })],
    ["valor diferente", FailureCode.ReversalAmountMismatch, () => ({
      tx: wager(Kind.Rollback, "0.99", { referenceExternalTransactionId: "bet" }),
      reference: processed(wager(Kind.Bet, "1.00", { externalTransactionId: "bet" })),
      reversed: false,
    })],
    ["já revertida", FailureCode.AlreadyReversed, () => ({
      tx: wager(Kind.Rollback, "1.00", { referenceExternalTransactionId: "bet" }),
      reference: processed(wager(Kind.Bet, "1.00", { externalTransactionId: "bet" })),
      reversed: true,
    })],
  ])("inelegível: %s → %s", (_label, code, scenario) => {
    const { tx, reference, reversed } = scenario();
    expect(evaluate(tx, reference, reversed)).toEqual({ kind: "ineligible", code });
  });

  test("WIN referenciando BET não exige reversão única", () => {
    const bet = processed(wager(Kind.Bet, "1.00", { externalTransactionId: "bet" }));
    const win = wager(Kind.Win, "5.00", { referenceExternalTransactionId: "bet" });
    expect(evaluate(win, bet, true).kind).toBe("eligible");
  });
});
