import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { WagerResult } from "../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case";
import { type Harness, createHarness, expectConsistent, http, newWallet, uniq, wagerPayload } from "../support/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ poolMax: 30 });
});
afterAll(async () => {
  await h.close();
});

type Settled = PromiseSettledResult<WagerResult>;
const fulfilled = (rs: Settled[]) => rs.filter((r): r is PromiseFulfilledResult<WagerResult> => r.status === "fulfilled").map((r) => r.value);

describe("cenário obrigatório da seção 8", () => {
  test("saldo 100.00, duas apostas de 80.00 simultâneas", async () => {
    const w = await newWallet(h, "100.00");
    const results = fulfilled(
      await Promise.allSettled([
        h.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "80.00" }), http()),
        h.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "80.00" }), http()),
      ]),
    );

    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.transaction.status === "PROCESSED")).toHaveLength(1);
    const rejected = results.filter((r) => r.transaction.status === "REJECTED");
    expect(rejected).toHaveLength(1);
    expect<string | undefined>(rejected[0]!.transaction.failureCode).toBe("INSUFFICIENT_FUNDS");

    const s = await expectConsistent(h.sql, w.walletId);
    expect(s).toMatchObject({ balance: "20.00", debits: 1, version: 2 });
  });

  test("nenhum retry duplica o débito: as duas apostas reenviadas 10x cada, em paralelo", async () => {
    const w = await newWallet(h, "100.00");
    const a = wagerPayload({ ...w, kind: "BET", amount: "80.00" });
    const b = wagerPayload({ ...w, kind: "BET", amount: "80.00" });
    const all = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => h.processWager.execute(i % 2 ? a : b, http())));
    const results = fulfilled(all);

    expect(results).toHaveLength(20);
    const distinct = new Set(results.map((r) => r.transaction.id));
    expect(distinct.size).toBe(2);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(2);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "20.00", debits: 1 });
  });
});

describe("idempotência sob concorrência", () => {
  test("a mesma aposta enviada 50 vezes em paralelo → um único débito", async () => {
    const w = await newWallet(h, "1000.00");
    const payload = wagerPayload({ ...w, kind: "BET", amount: "10.00" });
    const results = fulfilled(await Promise.allSettled(Array.from({ length: 50 }, () => h.processWager.execute(payload, http()))));

    expect(results).toHaveLength(50);
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "990.00", debits: 1 });
  });

  test("a mesma mensagem SQS entregue 30 vezes em paralelo → um efeito e uma linha de inbox", async () => {
    const w = await newWallet(h, "100.00");
    const payload = wagerPayload({ ...w, kind: "BET", amount: "1.00" });
    const messageId = uniq("msg");
    const origin = { correlationId: messageId, inbox: { consumerName: "wager-transactions", messageId, payloadHash: "b".repeat(64) } };
    const results = fulfilled(await Promise.allSettled(Array.from({ length: 30 }, () => h.processWager.execute(payload, origin))));

    expect(results).toHaveLength(30);
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    const [{ n }] = await h.sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ${messageId}`;
    expect(n).toBe(1);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ debits: 1 });
  });

  test("mesma key com payloads diferentes em wallets diferentes, ao mesmo tempo → um vence, o outro é 409", async () => {
    const w1 = await newWallet(h, "100.00");
    const w2 = await newWallet(h, "100.00");
    const key = uniq("shared-key");
    const ext = uniq("ext");
    const all = await Promise.allSettled([
      h.processWager.execute(wagerPayload({ ...w1, kind: "BET", amount: "10.00", idempotencyKey: key, externalTransactionId: ext }), http()),
      h.processWager.execute(wagerPayload({ ...w2, kind: "BET", amount: "10.00", idempotencyKey: key, externalTransactionId: ext }), http()),
    ]);

    expect(all.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = all.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect((failed.reason as { code: string }).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    const s1 = await expectConsistent(h.sql, w1.walletId);
    const s2 = await expectConsistent(h.sql, w2.walletId);
    expect(s1.debits + s2.debits).toBe(1);
  });
});

describe("hot wallet", () => {
  test("200 apostas de 1.00 simultâneas numa wallet com 150.00 → exatamente 150 débitos", async () => {
    const w = await newWallet(h, "150.00");
    const results = fulfilled(
      await Promise.allSettled(Array.from({ length: 200 }, () => h.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "1.00" }), http()))),
    );

    expect(results).toHaveLength(200);
    expect(results.filter((r) => r.transaction.status === "PROCESSED")).toHaveLength(150);
    expect(results.filter((r) => r.transaction.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(50);
    const s = await expectConsistent(h.sql, w.walletId);
    expect(s).toMatchObject({ balance: "0.00", debits: 150, version: 151 });
  });

  test("créditos e débitos misturados em paralelo não perdem atualização", async () => {
    const w = await newWallet(h, "500.00");
    const ops = Array.from({ length: 100 }, (_, i) =>
      h.processWager.execute(wagerPayload({ ...w, kind: i % 2 ? "WIN" : "BET", amount: "3.33" }), http()),
    );
    const results = fulfilled(await Promise.allSettled(ops));
    expect(results.every((r) => r.transaction.status === "PROCESSED")).toBe(true);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "500.00", version: 101 });
  });
});

describe("wallets distintas em paralelo", () => {
  test("lock é por wallet: com a wallet A travada, a wallet B processa normalmente", async () => {
    const a = await newWallet(h, "100.00");
    const b = await newWallet(h, "100.00");

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = h.sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${a.walletId} FOR UPDATE`;
      locked();
      await released;
    });
    await isLocked;

    const onB = await h.processWager.execute(wagerPayload({ ...b, kind: "BET", amount: "10.00" }), http());
    expect<string | undefined>(onB.transaction.status).toBe("PROCESSED");

    let finishedA = false;
    const onA = h.processWager.execute(wagerPayload({ ...a, kind: "BET", amount: "10.00" }), http()).then((r) => {
      finishedA = true;
      return r;
    });
    await Bun.sleep(200);
    expect(finishedA).toBe(false);
    release();
    await holder;
    expect<string>((await onA).transaction.status).toBe("PROCESSED");

    await expectConsistent(h.sql, a.walletId);
    await expectConsistent(h.sql, b.walletId);
  });

  test("20 wallets × 10 apostas, tudo ao mesmo tempo", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => newWallet(h, "100.00")));
    const ops = wallets.flatMap((w) => Array.from({ length: 10 }, () => h.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "7.50" }), http())));
    const results = fulfilled(await Promise.allSettled(ops));
    expect(results).toHaveLength(200);
    for (const w of wallets) {
      expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "25.00", debits: 10 });
    }
  });

  test("lock timeout vira erro transitório (503), sem efeito parcial", async () => {
    const quick = await createHarness({ settings: { lockTimeoutMs: 200, maxTransactionAttempts: 1 } });
    try {
      const w = await newWallet(quick, "100.00");
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const holder = quick.sql.begin(async (tx) => {
        await tx`SELECT id FROM wallets WHERE id = ${w.walletId} FOR UPDATE`;
        locked();
        await released;
      });
      await isLocked;

      const err = await quick.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "1.00" }), http()).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("TRANSIENT_INFRASTRUCTURE_ERROR");
      release();
      await holder;
      expect(await expectConsistent(quick.sql, w.walletId)).toMatchObject({ balance: "100.00", debits: 0 });
    } finally {
      await quick.close();
    }
  });
});

describe("múltiplas instâncias (processos independentes)", () => {
  test("3 processos disputando a mesma wallet, com operações duplicadas entre eles", async () => {
    const w = await newWallet(h, "100.00");
    const operations = Array.from({ length: 30 }, () => wagerPayload({ ...w, kind: "BET", amount: "5.00" }));
    const startAt = Date.now() + 1_500;

    const procs = ["i1", "i2", "i3"].map((instance) =>
      Bun.spawn(["bun", join(import.meta.dir, "../support/instance-process.ts")], {
        env: { ...process.env, JOB: JSON.stringify({ url: h.url, instance, operations, startAt }) },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outputs = await Promise.all(
      procs.map(async (p) => {
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        if (code !== 0) throw new Error(`instance exited ${code}: ${err}`);
        return JSON.parse(out.trim().split("\n").at(-1)!) as {
          pid: number;
          results: { ok: boolean; id?: string; status?: string; replay?: boolean; error?: string }[];
        };
      }),
    );

    expect(new Set(outputs.map((o) => o.pid)).size).toBe(3);
    const all = outputs.flatMap((o) => o.results);
    expect(all).toHaveLength(90);
    expect(all.every((r) => r.ok)).toBe(true);

    const byId = new Map<string, Set<string>>();
    for (const r of all) byId.set(r.id!, (byId.get(r.id!) ?? new Set()).add(r.status!));
    expect(byId.size).toBe(30);
    for (const statuses of byId.values()) expect(statuses.size).toBe(1);
    expect(all.filter((r) => !r.replay)).toHaveLength(30);

    const statuses = [...byId.values()].map((s) => [...s][0]);
    expect(statuses.filter((s) => s === "PROCESSED")).toHaveLength(20);
    expect(statuses.filter((s) => s === "REJECTED")).toHaveLength(10);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "0.00", debits: 20, version: 21 });
  }, 60_000);
});
