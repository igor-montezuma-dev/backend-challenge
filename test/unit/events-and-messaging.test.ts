import { describe, expect, test } from "bun:test";
import type { EventContext } from "../../src/shared/domain/integration-event";
import { uuidv7 } from "../../src/shared/infrastructure/uuid-v7.generator";
import { InvalidStateTransitionError } from "../../src/shared/domain/domain-error";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../src/modules/wagering/domain/events/wagering-events";
import { FailureCode } from "../../src/modules/wagering/domain/transaction/failure-code";
import { DEFAULT_REFERENCE_RETRY_POLICY } from "../../src/modules/wagering/domain/transaction/reference-retry-policy";
import { InboxMessage } from "../../src/modules/messaging/domain/inbox-message";
import { OutboxMessage } from "../../src/modules/messaging/domain/outbox-message";
import { Kind, T0, brl, openWallet, wager } from "./support/builders";

const ctx = (): EventContext => {
  let n = 0;
  return { nextEventId: () => `evt-${++n}`, correlationId: "corr-1", causationId: "msg-1", occurredAt: T0 };
};

describe("eventos de integração", () => {
  test("WalletBalanceChanged: envelope estável, dinheiro como string", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit(brl("25.00"), { transactionId: "tx-1", ledgerEntryId: "le-1", at: T0 });
    const event = WalletBalanceChanged.from(wallet, entry, ctx());

    const wire: unknown = JSON.parse(JSON.stringify(event));
    expect(wire).toEqual({
      eventId: "evt-1",
      eventType: "WalletBalanceChanged",
      aggregateId: wallet.id,
      correlationId: "corr-1",
      causationId: "msg-1",
      occurredAt: "2026-10-13T12:00:00.000Z",
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: "tx-1",
        direction: "DEBIT",
        money: { amount: "25.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "75.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
    expect(wire).toEqual(event.toJSON());
    expect(Object.isFrozen(event.data)).toBe(true);
  });

  test("eventos de transação particionam pela wallet", () => {
    const tx = wager(Kind.Loss, "0.00");
    tx.markProcessed(undefined, brl("100.00"), T0);
    const event = WagerTransactionProcessed.from(tx, ctx());
    expect(event.aggregateId).toBe(tx.id);
    expect(event.partitionKey).toBe(tx.walletId);
    expect(event.toJSON().data).toMatchObject({ kind: "LOSS", status: "PROCESSED", balanceAfter: { amount: "100.00", currency: "BRL" } });
  });

  test("Rejected e PendingReference carregam o que o provedor precisa", () => {
    const rejected = wager(Kind.Bet, "10.00");
    rejected.reject(FailureCode.InsufficientFunds, brl("1.00"));
    expect(WagerTransactionRejected.from(rejected, ctx()).data.failureCode).toBe(FailureCode.InsufficientFunds);

    const pending = wager(Kind.Refund, "10.00", { referenceExternalTransactionId: "bet-x" });
    pending.markPendingReference(T0, DEFAULT_REFERENCE_RETRY_POLICY);
    const event = WagerTransactionPendingReference.from(pending, ctx());
    expect(event.data.referenceExternalTransactionId).toBe("bet-x");
    expect(event.eventType).toBe("WagerTransactionPendingReference");
  });

  test("não é possível emitir evento de estado que não aconteceu", () => {
    const pendingTx = wager(Kind.Bet, "10.00");
    expect(() => WagerTransactionProcessed.from(pendingTx, ctx())).toThrow();
    expect(() => WagerTransactionRejected.from(pendingTx, ctx())).toThrow();
  });
});

describe("OutboxMessage", () => {
  const event = () => {
    const wallet = openWallet("10.00");
    const entry = wallet.credit(brl("1.00"), { transactionId: "tx", ledgerEntryId: "le", at: T0 });
    return WalletBalanceChanged.from(wallet, entry, ctx());
  };

  test("enqueue: id = eventId, payload = envelope, pendente e devida", () => {
    const e = event();
    const msg = OutboxMessage.enqueue(e);
    expect(msg.id).toBe(e.eventId);
    expect(msg.eventType).toBe("WalletBalanceChanged");
    expect(msg.payload).toEqual(e.toJSON() as unknown as Record<string, unknown>);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T0)).toBe(true);
  });

  test("scheduleRetry aplica backoff exponencial com teto", () => {
    const msg = OutboxMessage.enqueue(event());
    msg.scheduleRetry(T0, "SQS unavailable");
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt!.getTime() - T0.getTime()).toBe(500);
    expect(msg.isDue(T0)).toBe(false);
    msg.scheduleRetry(T0, "again");
    expect(msg.nextAttemptAt!.getTime() - T0.getTime()).toBe(1_000);
    for (let i = 0; i < 30; i++) msg.scheduleRetry(T0, "x");
    expect(msg.nextAttemptAt!.getTime() - T0.getTime()).toBe(60_000);
    expect(msg.lastError).toBe("x");
  });

  test("publicação é final", () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(T0);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(T0)).toBe(false);
    expect(() => msg.markPublished(T0)).toThrow(InvalidStateTransitionError);
    expect(() => msg.scheduleRetry(T0, "x")).toThrow(InvalidStateTransitionError);
  });
});

describe("InboxMessage", () => {
  test("receive → markProcessed uma única vez", () => {
    const msg = InboxMessage.receive({ messageId: "m-1", consumerName: "wager", payloadHash: "a".repeat(64), receivedAt: T0 });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(T0);
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(T0)).toThrow(InvalidStateTransitionError);
    expect(msg.matchesPayload("a".repeat(64))).toBe(true);
    expect(msg.matchesPayload("b".repeat(64))).toBe(false);
  });
});

describe("uuidv7", () => {
  test("formato RFC 9562 e ordenação temporal", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
