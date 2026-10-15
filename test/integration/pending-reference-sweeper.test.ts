import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  PendingReferenceSweeper,
  type PendingReferenceSweeperOptions,
} from "../../src/modules/wagering/application/workers/pending-reference-sweeper";
import { SqlPendingReferenceQueue } from "../../src/modules/wagering/infrastructure/persistence/sql-pending-reference.queue";
import {
  type Harness,
  createHarness,
  expectConsistent,
  http,
  newWallet,
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

const sweeper = (harness: Harness = h, overrides: Partial<PendingReferenceSweeperOptions> = {}) =>
  new PendingReferenceSweeper(new SqlPendingReferenceQueue(harness.orm), harness.settlePending, {
    batchSize: 50,
    leaseMs: 30_000,
    pollIntervalMs: 20,
    ...overrides,
  });

async function refundBeforeBet(harness: Harness = h) {
  const w = await newWallet(harness, "100.00");
  const betExt = uniq("bet");
  const refund = await harness.processWager.execute(
    wagerPayload({ ...w, kind: "REFUND", amount: "30.00", referenceExternalTransactionId: betExt }),
    http(),
  );
  expect<string | undefined>(refund.transaction.status).toBe("PENDING_REFERENCE");
  const sendBet = () =>
    harness.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "30.00", externalTransactionId: betExt }), http());
  return { w, refundId: refund.transaction.id, sendBet };
}

const pendingCount = async (harness: Harness = h) =>
  ((await harness.sql`SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`)[0] as { n: number }).n;

describe("worker de PENDING_REFERENCE", () => {
  test("não reavalia antes da hora: sem referência e sem vencimento nada é reivindicado", async () => {
    const { refundId } = await refundBeforeBet();
    const report = await sweeper().sweepOnce();
    expect(report.claimed).toBe(0);
    expect(await transactionRow(h.sql, refundId)).toMatchObject({ status: "PENDING_REFERENCE" });
  });

  test("a referência chega: a pendência vence na hora e o worker liquida com saldo consistente", async () => {
    const { w, refundId, sendBet } = await refundBeforeBet();
    await sendBet();

    const report = await sweeper().sweepOnce();
    expect(report.settled).toBeGreaterThanOrEqual(1);
    expect(await transactionRow(h.sql, refundId)).toMatchObject({ status: "PROCESSED", balance_after: "100.00" });
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "100.00", debits: 1, credits: 2 });
  });

  test("dois workers concorrentes: cada pendência é liquidada exatamente uma vez", async () => {
    const cases = await Promise.all(Array.from({ length: 12 }, () => refundBeforeBet()));
    await Promise.all(cases.map((c) => c.sendBet()));

    const a = sweeper(h, { batchSize: 4 });
    const b = sweeper(h, { batchSize: 4 });
    let settled = 0;
    for (;;) {
      const [ra, rb] = await Promise.all([a.sweepOnce(), b.sweepOnce()]);
      settled += ra.settled + rb.settled;
      if (ra.claimed + rb.claimed === 0) break;
    }

    expect(settled).toBe(cases.length);
    for (const c of cases) {
      expect(await transactionRow(h.sql, c.refundId)).toMatchObject({ status: "PROCESSED" });
      expect(await expectConsistent(h.sql, c.w.walletId)).toMatchObject({ balance: "100.00", credits: 2, debits: 1 });
    }
  });

  test("worker morre depois de reivindicar: o lease expira e outro worker conclui", async () => {
    const { w, refundId, sendBet } = await refundBeforeBet();
    await sendBet();

    const claimedByDeadWorker = await new SqlPendingReferenceQueue(h.orm).claimDue(50, 300);
    expect(claimedByDeadWorker).toContain(refundId);
    expect((await sweeper().sweepOnce()).claimed).toBe(0);

    await Bun.sleep(400);
    await sweeper().sweepOnce();
    expect(await transactionRow(h.sql, refundId)).toMatchObject({ status: "PROCESSED" });
    await expectConsistent(h.sql, w.walletId);
  });

  test("referência nunca chega: o worker expira a pendência como REJECTED REFERENCE_NOT_FOUND", async () => {
    const strict = await createHarness({ retryPolicy: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 3, maxAgeMs: 60_000 } });
    try {
      const { w, refundId } = await refundBeforeBet(strict);
      const worker = sweeper(strict, { leaseMs: 10_000 });
      let expired = 0;
      for (let i = 0; i < 20 && (await pendingCount(strict)) > 0; i++) {
        expired += (await worker.sweepOnce()).expired;
        await Bun.sleep(5);
      }
      expect(expired).toBe(1);
      expect(await transactionRow(strict.sql, refundId)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND" });
      expect(await expectConsistent(strict.sql, w.walletId)).toMatchObject({ balance: "100.00" });
    } finally {
      await strict.close();
    }
  });

  test("start/stop: o loop resolve pendências sozinho e para limpo", async () => {
    const { refundId, sendBet } = await refundBeforeBet();
    const worker = sweeper();
    worker.start();
    await sendBet();
    for (let i = 0; i < 100 && (await transactionRow(h.sql, refundId)).status !== "PROCESSED"; i++) await Bun.sleep(20);
    await worker.stop();
    expect(await transactionRow(h.sql, refundId)).toMatchObject({ status: "PROCESSED" });
  });

  test.each([
    ["adiantado 5s", 5_000],
    ["atrasado 5s", -5_000],
  ])("relógio da aplicação %s: a chegada da referência torna a pendência vencida pelo relógio do banco", async (_label, skewMs) => {
    const skewed = await createHarness({ clock: { now: () => new Date(Date.now() + skewMs) } });
    try {
      const { refundId, sendBet } = await refundBeforeBet(skewed);
      await sendBet();
      await sweeper(skewed).sweepOnce();
      expect(await transactionRow(skewed.sql, refundId)).toMatchObject({ status: "PROCESSED" });
    } finally {
      await skewed.close();
    }
  });
});
