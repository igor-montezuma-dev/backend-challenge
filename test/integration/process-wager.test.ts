import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ConflictError } from "../../src/shared/application/errors";
import { ValidationError } from "../../src/shared/domain/domain-error";
import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from "../../src/modules/wagering/application/errors";
import type { WageringUnitOfWork } from "../../src/modules/wagering/application/ports/wagering-repositories";
import {
  type Harness,
  createHarness,
  expectConsistent,
  http,
  newWallet,
  outboxTypes,
  snapshot,
  transactionRow,
  uniq,
  wagerPayload,
} from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe("abertura de wallet", () => {
  test("gera OPENING + CREDIT + evento na mesma transação", async () => {
    const { walletId } = await newWallet(h, "1000.00");
    const s = await expectConsistent(h.sql, walletId);
    expect(s).toMatchObject({ balance: "1000.00", version: 1, ledgerEntries: 1, credits: 1 });
    const [opening] = await h.sql`SELECT kind, status FROM wager_transactions WHERE wallet_id = ${walletId}`;
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED" });
    expect(await outboxTypes(h.sql, walletId)).toEqual(["WalletBalanceChanged"]);
  });

  test("saldo zero: nenhum lançamento nem evento", async () => {
    const { walletId } = await newWallet(h, "0.00");
    expect(await snapshot(h.sql, walletId)).toMatchObject({ balance: "0.00", version: 1, ledgerEntries: 0 });
  });

  test("wallet duplicada para player + moeda é conflito", async () => {
    const playerId = crypto.randomUUID();
    await h.openWallet.execute({ playerId, initialBalance: { amount: "1.00", currency: "BRL" } }, { correlationId: "t" });
    const err = await h.openWallet
      .execute({ playerId, initialBalance: { amount: "1.00", currency: "BRL" } }, { correlationId: "t" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).code).toBe("WALLET_ALREADY_EXISTS");
    await h.openWallet.execute({ playerId, initialBalance: { amount: "1.00", currency: "USD" } }, { correlationId: "t" });
  });

  test("entrada inválida não toca o banco", async () => {
    await expect(
      h.openWallet.execute({ playerId: crypto.randomUUID(), initialBalance: { amount: "1.001", currency: "BRL" } }, { correlationId: "t" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("BET / WIN / LOSS", () => {
  test("BET processada: saldo, lançamento, eventos", async () => {
    const w = await newWallet(h, "1000.00");
    const result = await h.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "25.00" }), http());

    expect(result.idempotentReplay).toBe(false);
    expect<string | undefined>(result.transaction.status).toBe("PROCESSED");
    expect(result.transaction.balanceAfter?.amount).toBe("975.00");
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "975.00", version: 2, debits: 1 });
    expect(await outboxTypes(h.sql, w.walletId)).toEqual([
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("LOSS processada sem lançamento e com evento Processed", async () => {
    const w = await newWallet(h, "10.00");
    const r = await h.processWager.execute(wagerPayload({ ...w, kind: "LOSS", amount: "0.00" }), http());
    expect<string | undefined>(r.transaction.status).toBe("PROCESSED");
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "10.00", version: 1 });
    expect(await outboxTypes(h.sql, w.walletId)).toEqual(["WalletBalanceChanged", "WagerTransactionProcessed"]);
  });

  test("saldo insuficiente: REJECTED auditável, sem lançamento", async () => {
    const w = await newWallet(h, "10.00");
    const r = await h.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "10.01" }), http());
    expect<string | undefined>(r.transaction.status).toBe("REJECTED");
    expect<string | undefined>(r.transaction.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(await transactionRow(h.sql, r.transaction.id)).toMatchObject({ status: "REJECTED", balance_after: "10.00" });
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "10.00", version: 1 });
    expect(await outboxTypes(h.sql, w.walletId)).toEqual(["WalletBalanceChanged", "WagerTransactionRejected"]);
  });

  test("moeda diferente da wallet: CURRENCY_MISMATCH", async () => {
    const w = await newWallet(h, "10.00", "BRL");
    const r = await h.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "1.00", currency: "USD" }), http());
    expect<string | undefined>(r.transaction.failureCode).toBe("CURRENCY_MISMATCH");
    await expectConsistent(h.sql, w.walletId);
  });

  test("wallet inexistente: 404 e nada gravado", async () => {
    const payload = wagerPayload({ walletId: crypto.randomUUID(), playerId: crypto.randomUUID(), kind: "BET", amount: "1.00" });
    await expect(h.processWager.execute(payload, http())).rejects.toBeInstanceOf(WalletNotFoundError);
    const [{ n }] = await h.sql`SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key = ${payload.idempotencyKey as string}`;
    expect(n).toBe(0);
  });

  test("OPENING não pode ser submetido", async () => {
    const w = await newWallet(h, "10.00");
    const payload = { ...wagerPayload({ ...w, kind: "BET", amount: "1.00" }), kind: "OPENING" };
    await expect(h.processWager.execute(payload, http())).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("idempotência persistente", () => {
  test("replay devolve o resultado original, inclusive o saldo daquele momento", async () => {
    const w = await newWallet(h, "100.00");
    const payload = wagerPayload({ ...w, kind: "BET", amount: "30.00" });
    const first = await h.processWager.execute(payload, http());
    await h.processWager.execute(wagerPayload({ ...w, kind: "WIN", amount: "500.00" }), http());

    const replay = await h.processWager.execute(payload, http());
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.transaction.balanceAfter?.amount).toBe("70.00");
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ debits: 1, balance: "570.00" });
  });

  test("replay de rejeição também é estável", async () => {
    const w = await newWallet(h, "5.00");
    const payload = wagerPayload({ ...w, kind: "BET", amount: "50.00" });
    const first = await h.processWager.execute(payload, http());
    await h.processWager.execute(wagerPayload({ ...w, kind: "WIN", amount: "100.00" }), http());
    const replay = await h.processWager.execute(payload, http());
    expect(replay).toMatchObject({ idempotentReplay: true });
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect<string | undefined>(replay.transaction.status).toBe("REJECTED");
  });

  test("mesma key com payload diferente é conflito, não replay", async () => {
    const w = await newWallet(h, "100.00");
    const payload = wagerPayload({ ...w, kind: "BET", amount: "30.00" });
    await h.processWager.execute(payload, http());
    const divergent = { ...payload, money: { amount: "31.00", currency: "BRL" } };
    await expect(h.processWager.execute(divergent, http())).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ debits: 1 });
  });

  test("mesmo id externo com outra key é conflito", async () => {
    const w = await newWallet(h, "100.00");
    const payload = wagerPayload({ ...w, kind: "BET", amount: "30.00" });
    await h.processWager.execute(payload, http());
    await expect(h.processWager.execute({ ...payload, idempotencyKey: uniq("other-key") }, http())).rejects.toBeInstanceOf(
      ExternalIdConflictError,
    );
  });

  test("hash ignora a forma do amount: \"30\" é replay de \"30.00\"", async () => {
    const w = await newWallet(h, "100.00");
    const payload = wagerPayload({ ...w, kind: "BET", amount: "30.00" });
    await h.processWager.execute(payload, http());
    const r = await h.processWager.execute({ ...payload, money: { amount: "30", currency: "BRL" } }, http());
    expect(r.idempotentReplay).toBe(true);
  });
});

describe("inbox (entrada pela fila)", () => {
  const inbox = (messageId: string, consumerName = "wager-transactions") => ({
    correlationId: messageId,
    causationId: messageId,
    inbox: { consumerName, messageId, payloadHash: "a".repeat(64) },
  });

  test("redelivery da mesma mensagem não duplica efeito nem inbox", async () => {
    const w = await newWallet(h, "100.00");
    const payload = wagerPayload({ ...w, kind: "BET", amount: "10.00" });
    const messageId = uniq("msg");
    const first = await h.processWager.execute(payload, inbox(messageId));
    const again = await h.processWager.execute(payload, inbox(messageId));

    expect(again.idempotentReplay).toBe(true);
    expect(again.transaction.id).toBe(first.transaction.id);
    const [{ n }] = await h.sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ${messageId}`;
    expect(n).toBe(1);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ debits: 1 });
  });

  test("mesma operação em outra mensagem: replay e inbox registrada", async () => {
    const w = await newWallet(h, "100.00");
    const payload = wagerPayload({ ...w, kind: "BET", amount: "10.00" });
    await h.processWager.execute(payload, inbox(uniq("msg")));
    const second = uniq("msg");
    const r = await h.processWager.execute(payload, inbox(second));
    expect(r.idempotentReplay).toBe(true);
    const [{ n }] = await h.sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ${second} AND processed_at IS NOT NULL`;
    expect(n).toBe(1);
  });

  test("HTTP e fila compartilham a idempotência", async () => {
    const w = await newWallet(h, "100.00");
    const payload = wagerPayload({ ...w, kind: "BET", amount: "10.00" });
    const viaHttp = await h.processWager.execute(payload, http());
    const viaQueue = await h.processWager.execute(payload, inbox(uniq("msg")));
    expect(viaQueue.transaction.id).toBe(viaHttp.transaction.id);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ debits: 1 });
  });
});

describe("reversões", () => {
  test("REFUND de BET e tentativa de segunda reversão", async () => {
    const w = await newWallet(h, "100.00");
    const bet = wagerPayload({ ...w, kind: "BET", amount: "40.00" });
    await h.processWager.execute(bet, http());
    const ref = bet.externalTransactionId as string;

    const refund = await h.processWager.execute(wagerPayload({ ...w, kind: "REFUND", amount: "40.00", referenceExternalTransactionId: ref }), http());
    expect<string | undefined>(refund.transaction.status).toBe("PROCESSED");

    const rollback = await h.processWager.execute(wagerPayload({ ...w, kind: "ROLLBACK", amount: "40.00", referenceExternalTransactionId: ref }), http());
    expect<string | undefined>(rollback.transaction.failureCode).toBe("ALREADY_REVERSED");
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "100.00", credits: 2, debits: 1 });
  });

  test("ROLLBACK de WIN que deixaria saldo negativo: REVERSAL_WOULD_OVERDRAW", async () => {
    const w = await newWallet(h, "0.00");
    const win = wagerPayload({ ...w, kind: "WIN", amount: "50.00" });
    await h.processWager.execute(win, http());
    await h.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "45.00" }), http());
    const r = await h.processWager.execute(
      wagerPayload({ ...w, kind: "ROLLBACK", amount: "50.00", referenceExternalTransactionId: win.externalTransactionId as string }),
      http(),
    );
    expect<string | undefined>(r.transaction.failureCode).toBe("REVERSAL_WOULD_OVERDRAW");
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "5.00" });
  });
});

describe("referência fora de ordem", () => {
  test("REFUND antes da BET: PENDING_REFERENCE → BET chega → worker liquida", async () => {
    const w = await newWallet(h, "100.00");
    const betExt = uniq("bet");
    const refund = await h.processWager.execute(
      wagerPayload({ ...w, kind: "REFUND", amount: "30.00", referenceExternalTransactionId: betExt }),
      http(),
    );
    expect<string | undefined>(refund.transaction.status).toBe("PENDING_REFERENCE");
    expect(await outboxTypes(h.sql, w.walletId)).toContain("WagerTransactionPendingReference");
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "100.00", version: 1 });

    await h.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "30.00", externalTransactionId: betExt }), http());
    const [{ due }] = await h.sql`SELECT next_reference_check_at <= now() AS due FROM wager_transactions WHERE id = ${refund.transaction.id}`;
    expect(due).toBe(true);

    const settled = await h.settlePending.execute(refund.transaction.id);
    expect(settled).toMatchObject({ kind: "settled", outcome: "processed" });
    expect(await transactionRow(h.sql, refund.transaction.id)).toMatchObject({ status: "PROCESSED", balance_after: "100.00" });
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "100.00", debits: 1, credits: 2 });

    expect(await h.settlePending.execute(refund.transaction.id)).toEqual({ kind: "skipped", reason: "not_pending" });
  });

  test("referência nunca chega: REJECTED REFERENCE_NOT_FOUND + evento", async () => {
    const strict = await createHarness({ retryPolicy: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3, maxAgeMs: 60_000 } });
    try {
      const w = await newWallet(strict, "100.00");
      const r = await strict.processWager.execute(
        wagerPayload({ ...w, kind: "ROLLBACK", amount: "10.00", referenceExternalTransactionId: "never" }),
        http(),
      );
      let result = await strict.settlePending.execute(r.transaction.id);
      while (result.kind === "settled") result = await strict.settlePending.execute(r.transaction.id);

      expect(result.kind).toBe("expired");
      expect(await transactionRow(strict.sql, r.transaction.id)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND" });
      expect(await outboxTypes(strict.sql, w.walletId)).toEqual([
        "WalletBalanceChanged",
        "WagerTransactionPendingReference",
        "WagerTransactionRejected",
      ]);
      await expectConsistent(strict.sql, w.walletId);
    } finally {
      await strict.close();
    }
  });
});

describe("atomicidade: wallet, transação, ledger, inbox e outbox", () => {
  test("falha depois de gravar tudo menos o COMMIT: nada persiste", async () => {
    const failing = await createHarness({
      decorateUnitOfWork: (inner: WageringUnitOfWork): WageringUnitOfWork => ({
        run: (work) =>
          inner.run((repositories) =>
            work({
              ...repositories,
              outbox: {
                enqueue: async (events) => {
                  await repositories.outbox.enqueue(events);
                  throw new Error("crash before commit");
                },
              },
            }),
          ),
      }),
    });
    try {
      const playerId = crypto.randomUUID();
      const ok = await createHarnessOn(failing);
      const wallet = await ok.openWallet.execute({ playerId, initialBalance: { amount: "100.00", currency: "BRL" } }, { correlationId: "t" });
      await ok.closeOrm();

      const messageId = uniq("msg");
      const payload = wagerPayload({ walletId: wallet.id, playerId, kind: "BET", amount: "40.00" });
      await expect(
        failing.processWager.execute(payload, {
          correlationId: messageId,
          inbox: { consumerName: "wager-transactions", messageId, payloadHash: "a".repeat(64) },
        }),
      ).rejects.toThrow("crash before commit");

      expect(await expectConsistent(failing.sql, wallet.id)).toMatchObject({ balance: "100.00", version: 1, debits: 0 });
      const [counts] = await failing.sql`
        SELECT (SELECT count(*) FROM wager_transactions WHERE idempotency_key = ${payload.idempotencyKey as string})::int AS tx,
               (SELECT count(*) FROM inbox_messages WHERE message_id = ${messageId})::int AS inbox,
               (SELECT count(*) FROM outbox_messages WHERE partition_key = ${wallet.id} AND event_type <> 'WalletBalanceChanged')::int AS outbox`;
      expect(counts).toEqual({ tx: 0, inbox: 0, outbox: 0 });
    } finally {
      await failing.close();
    }
  });
});

async function createHarnessOn(of: Harness) {
  const { buildHarness } = await import("../support/harness");
  const other = await buildHarness(of.url, of.sql, { poolMax: 2 });
  return { ...other, closeOrm: () => other.orm.close(true) };
}
