import { describe, expect, test } from "bun:test";
import { Money } from "../../src/shared/domain/money";
import { FailureCode } from "../../src/modules/wagering/domain/transaction/failure-code";
import { DEFAULT_REFERENCE_RETRY_POLICY } from "../../src/modules/wagering/domain/transaction/reference-retry-policy";
import { type SettlementOutcome, WagerSettlementService } from "../../src/modules/wagering/domain/settlement/wager-settlement.service";
import { type WagerTransaction, WagerTransactionStatus as Status } from "../../src/modules/wagering/domain/transaction/wager-transaction";
import type { Wallet } from "../../src/modules/wagering/domain/wallet/wallet";
import { LedgerDirection } from "../../src/modules/wagering/domain/wallet/wallet-ledger-entry";
import { Kind, T0, nextId, openWallet, wager } from "./support/builders";

const settlement = new WagerSettlementService(DEFAULT_REFERENCE_RETRY_POLICY);

function settle(
  tx: WagerTransaction,
  wallet: Wallet,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
): SettlementOutcome {
  return settlement.settle({
    transaction: tx,
    wallet,
    reference,
    referenceAlreadyReversed,
    ledgerEntryId: nextId("le"),
    now: T0,
  });
}

function processedBet(wallet: Wallet, amount: string, ext = nextId("bet")): WagerTransaction {
  const bet = wager(Kind.Bet, amount, { externalTransactionId: ext });
  expect(settle(bet, wallet).kind).toBe("processed");
  return bet;
}

function processedWin(wallet: Wallet, amount: string, ext = nextId("win")): WagerTransaction {
  const win = wager(Kind.Win, amount, { externalTransactionId: ext });
  expect(settle(win, wallet).kind).toBe("processed");
  return win;
}

describe("BET", () => {
  test("debita e gera 1 lançamento DEBIT", () => {
    const wallet = openWallet("100.00");
    const bet = wager(Kind.Bet, "25.00");
    const outcome = settle(bet, wallet);

    expect(outcome.kind).toBe("processed");
    if (outcome.kind !== "processed") return;
    expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(outcome.balanceBefore.amount).toBe("100.00");
    expect(wallet.balance.amount).toBe("75.00");
    expect(bet.status).toBe(Status.Processed);
    expect(bet.balanceAfter?.amount).toBe("75.00");
  });

  test("cenário da seção 8: saldo 100, duas apostas de 80 → uma processada, outra rejeitada", () => {
    const wallet = openWallet("100.00");
    const first = wager(Kind.Bet, "80.00");
    const second = wager(Kind.Bet, "80.00");

    expect(settle(first, wallet).kind).toBe("processed");
    expect(settle(second, wallet)).toEqual({ kind: "rejected", code: FailureCode.InsufficientFunds });

    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(second.status).toBe(Status.Rejected);
    expect(second.balanceAfter?.amount).toBe("20.00");
  });
});

describe("WIN", () => {
  test("credita sem referência", () => {
    const wallet = openWallet("10.00");
    const outcome = settle(wager(Kind.Win, "50.00"), wallet);
    expect(outcome.kind).toBe("processed");
    expect(wallet.balance.amount).toBe("60.00");
  });

  test("credita referenciando a BET da mesma rodada", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00", "bet-1");
    const win = wager(Kind.Win, "30.00", { referenceExternalTransactionId: "bet-1" });
    expect(settle(win, wallet, bet).kind).toBe("processed");
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe("120.00");
  });

  test("referência a outra rodada é REFERENCE_MISMATCH", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00", "bet-1");
    const win = wager(Kind.Win, "30.00", { referenceExternalTransactionId: "bet-1", roundId: "round-2" });
    expect(settle(win, wallet, bet)).toEqual({ kind: "rejected", code: FailureCode.ReferenceMismatch });
  });
});

describe("LOSS", () => {
  test("processada sem mover saldo e sem lançamento", () => {
    const wallet = openWallet("100.00");
    const loss = wager(Kind.Loss, "0.00");
    const outcome = settle(loss, wallet);
    expect(outcome).toMatchObject({ kind: "processed", entry: undefined });
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(loss.status).toBe(Status.Processed);
    expect(loss.balanceAfter?.amount).toBe("100.00");
  });

  test("pode referenciar a BET da rodada: processada sem lançamento e com a referência resolvida", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00", "bet-1");
    const loss = wager(Kind.Loss, "0.00", { referenceExternalTransactionId: "bet-1" });
    expect(settle(loss, wallet, bet)).toMatchObject({ kind: "processed", entry: undefined });
    expect(loss.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe("90.00");
  });

  test("referência que não é BET é rejeitada", () => {
    const wallet = openWallet("100.00");
    const win = processedWin(wallet, "10.00", "win-1");
    const loss = wager(Kind.Loss, "0.00", { referenceExternalTransactionId: "win-1" });
    expect(settle(loss, wallet, win)).toEqual({ kind: "rejected", code: FailureCode.InvalidReferenceKind });
  });
});

describe("REFUND", () => {
  test("credita o valor da BET referenciada", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "40.00", "bet-1");
    const refund = wager(Kind.Refund, "40.00", { referenceExternalTransactionId: "bet-1" });
    const outcome = settle(refund, wallet, bet);
    expect(outcome.kind).toBe("processed");
    if (outcome.kind === "processed") expect(outcome.entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("só referencia BET", () => {
    const wallet = openWallet("100.00");
    const win = processedWin(wallet, "10.00", "win-1");
    const refund = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "win-1" });
    expect(settle(refund, wallet, win)).toEqual({ kind: "rejected", code: FailureCode.InvalidReferenceKind });
  });

  test("valor diferente da referência é rejeitado (sem reversão parcial)", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "40.00", "bet-1");
    const refund = wager(Kind.Refund, "39.99", { referenceExternalTransactionId: "bet-1" });
    expect(settle(refund, wallet, bet)).toEqual({ kind: "rejected", code: FailureCode.ReversalAmountMismatch });
  });

  test("referência já revertida é rejeitada", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "40.00", "bet-1");
    const refund = wager(Kind.Refund, "40.00", { referenceExternalTransactionId: "bet-1" });
    expect(settle(refund, wallet, bet, true)).toEqual({ kind: "rejected", code: FailureCode.AlreadyReversed });
    expect(wallet.balance.amount).toBe("60.00");
  });

  test("referência ausente → PENDING_REFERENCE, sem mexer no saldo", () => {
    const wallet = openWallet("100.00");
    const refund = wager(Kind.Refund, "40.00", { referenceExternalTransactionId: "bet-future" });
    expect(settle(refund, wallet, undefined)).toEqual({ kind: "pending_reference" });
    expect(refund.status).toBe(Status.PendingReference);
    expect(wallet.version).toBe(1);
  });

  test("referência ainda pendente → continua aguardando", () => {
    const wallet = openWallet("100.00");
    const waitingRefund = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-x" });
    settle(waitingRefund, wallet, undefined);
    const rollbackOfRefund = wager(Kind.Rollback, "10.00", { referenceExternalTransactionId: waitingRefund.externalTransactionId });
    expect(settle(rollbackOfRefund, wallet, waitingRefund)).toEqual({ kind: "pending_reference" });
  });

  test("referência REJECTED → REFERENCE_NOT_PROCESSED", () => {
    const wallet = openWallet("10.00");
    const bet = wager(Kind.Bet, "50.00", { externalTransactionId: "bet-1" });
    expect(settle(bet, wallet).kind).toBe("rejected");
    const refund = wager(Kind.Refund, "50.00", { referenceExternalTransactionId: "bet-1" });
    expect(settle(refund, wallet, bet)).toEqual({ kind: "rejected", code: FailureCode.ReferenceNotProcessed });
  });
});

describe("ROLLBACK", () => {
  test("de BET credita", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "30.00", "bet-1");
    const rollback = wager(Kind.Rollback, "30.00", { referenceExternalTransactionId: "bet-1" });
    expect(settle(rollback, wallet, bet).kind).toBe("processed");
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("de WIN debita", () => {
    const wallet = openWallet("100.00");
    const win = processedWin(wallet, "50.00", "win-1");
    const rollback = wager(Kind.Rollback, "50.00", { referenceExternalTransactionId: "win-1" });
    const outcome = settle(rollback, wallet, win);
    expect(outcome.kind).toBe("processed");
    if (outcome.kind === "processed") expect(outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("de REFUND debita", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "30.00", "bet-1");
    const refund = wager(Kind.Refund, "30.00", { referenceExternalTransactionId: "bet-1", externalTransactionId: "refund-1" });
    settle(refund, wallet, bet);
    const rollback = wager(Kind.Rollback, "30.00", { referenceExternalTransactionId: "refund-1" });
    expect(settle(rollback, wallet, refund).kind).toBe("processed");
    expect(wallet.balance.amount).toBe("70.00");
  });

  test("que deixaria saldo negativo → REVERSAL_WOULD_OVERDRAW (código distinto de INSUFFICIENT_FUNDS)", () => {
    const wallet = openWallet("0.00");
    const win = processedWin(wallet, "50.00", "win-1");
    processedBet(wallet, "45.00");
    const rollback = wager(Kind.Rollback, "50.00", { referenceExternalTransactionId: "win-1" });

    expect(settle(rollback, wallet, win)).toEqual({ kind: "rejected", code: FailureCode.ReversalWouldOverdraw });
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.amount).toBe("5.00");
    expect(rollback.status).toBe(Status.Rejected);
  });

  test("de ROLLBACK não é permitido", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00", "bet-1");
    const rb1 = wager(Kind.Rollback, "10.00", { referenceExternalTransactionId: "bet-1", externalTransactionId: "rb-1" });
    settle(rb1, wallet, bet);
    const rb2 = wager(Kind.Rollback, "10.00", { referenceExternalTransactionId: "rb-1" });
    expect(settle(rb2, wallet, rb1)).toEqual({ kind: "rejected", code: FailureCode.InvalidReferenceKind });
  });
});

describe("consistência da operação com a wallet", () => {
  test("moeda diferente da wallet → CURRENCY_MISMATCH, sem saldo no replay", () => {
    const wallet = openWallet("100.00");
    const usdBet = wager(Kind.Bet, "10.00", { money: Money.from({ amount: "10.00", currency: "USD" }) });
    expect(settle(usdBet, wallet)).toEqual({ kind: "rejected", code: FailureCode.CurrencyMismatch });
    expect(usdBet.balanceAfter).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test("wallet de outro player → WALLET_PLAYER_MISMATCH", () => {
    const wallet = openWallet("100.00", { playerId: "someone-else" });
    expect(settle(wager(Kind.Bet, "10.00"), wallet)).toEqual({
      kind: "rejected",
      code: FailureCode.WalletPlayerMismatch,
    });
  });

  test("referência de outro provider/player é REFERENCE_MISMATCH", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet(wallet, "10.00", "bet-1");
    const refund = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-1", providerId: "provider-b" });
    expect(settle(refund, wallet, bet)).toEqual({ kind: "rejected", code: FailureCode.ReferenceMismatch });
  });
});

describe("invariante: saldo == soma do ledger ao longo de uma rodada completa", () => {
  test("sequência mista", () => {
    const wallet = openWallet("100.00");
    const entries: Money[] = [Money.from({ amount: "100.00", currency: "BRL" })];
    const track = (o: SettlementOutcome) => {
      if (o.kind === "processed" && o.entry) entries.push(o.entry.signedAmount());
    };

    const bet = wager(Kind.Bet, "20.00", { externalTransactionId: "b1" });
    track(settle(bet, wallet));
    track(settle(wager(Kind.Win, "55.50", { referenceExternalTransactionId: "b1" }), wallet, bet));
    const bet2 = wager(Kind.Bet, "70.00", { externalTransactionId: "b2" });
    track(settle(bet2, wallet));
    track(settle(wager(Kind.Refund, "70.00", { referenceExternalTransactionId: "b2" }), wallet, bet2));
    track(settle(wager(Kind.Loss, "0.00"), wallet));
    track(settle(wager(Kind.Bet, "1000.00"), wallet));

    const ledgerTotal = entries.reduce((a, b) => a.add(b));
    expect(ledgerTotal.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe("135.50");
    expect(wallet.version).toBe(entries.length);
  });
});
