import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { OutboxRelay, type OutboxRelayOptions } from "../../src/modules/messaging/application/outbox-relay";
import {
  type EventPublisher,
  sequentialPublisher,
} from "../../src/modules/messaging/application/ports/event-publisher.port";
import type { OutboxMessage } from "../../src/modules/messaging/domain/outbox-message";
import { SqlOutboxStore } from "../../src/modules/messaging/infrastructure/outbox/sql-outbox.store";
import { SqsEventPublisher } from "../../src/modules/messaging/infrastructure/sqs/sqs-event-publisher";
import { SystemClock } from "../../src/shared/infrastructure/system-clock";
import { type Harness, createHarness, http, newWallet, wagerPayload } from "../support/harness";
import { type TestQueues, createTestQueues, drain } from "../support/sqs";

let h: Harness;
let queues: TestQueues;

beforeAll(async () => {
  h = await createHarness();
  queues = await createTestQueues();
});

afterAll(async () => {
  await queues.destroy();
  await h.close();
});

afterEach(async () => {
  await relay("cleanup").relayOnce();
  await drain(queues.client, queues.eventsQueueUrl, 0);
});

const options = (owner: string, overrides: Partial<OutboxRelayOptions> = {}): OutboxRelayOptions => ({
  owner,
  batchSize: 100,
  leaseMs: 30_000,
  pollIntervalMs: 50,
  retryPolicy: { baseDelayMs: 200, maxDelayMs: 200 },
  ...overrides,
});

function relay(owner: string, publisher: EventPublisher = sqsPublisher(), overrides: Partial<OutboxRelayOptions> = {}) {
  return new OutboxRelay(new SqlOutboxStore(h.orm), publisher, new SystemClock(), options(owner, overrides));
}

const sqsPublisher = () => new SqsEventPublisher(queues.client, queues.eventsQueueUrl);

async function publishToSqs(message: OutboxMessage): Promise<void> {
  const result = await sqsPublisher().publishInOrder([message]);
  if (result.kind === "partial") throw result.error;
}

function countingPublisher(inner: EventPublisher = sqsPublisher()) {
  const published: string[] = [];
  return {
    published,
    publisher: {
      publishInOrder: async (messages) => {
        const result = await inner.publishInOrder(messages);
        const count = result.kind === "published" ? messages.length : result.publishedCount;
        published.push(...messages.slice(0, count).map((m) => m.id));
        return result;
      },
    } satisfies EventPublisher,
  };
}

const pendingCount = async () =>
  ((await h.sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`)[0] as { n: number }).n;

const outboxIdsInOrder = async (walletId: string) =>
  ((await h.sql`SELECT id FROM outbox_messages WHERE partition_key = ${walletId} ORDER BY position`) as { id: string }[]).map((r) => r.id);

async function walletWithActivity(bets = 3) {
  const w = await newWallet(h, "100.00");
  for (let i = 0; i < bets; i++) await h.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "1.00" }), http());
  return w;
}

describe("Transactional Outbox → SQS", () => {
  test("publica o envelope do evento, na ordem de commit da wallet, e marca como publicado", async () => {
    const w = await walletWithActivity(2);
    const expected = await outboxIdsInOrder(w.walletId);

    const report = await relay("instance-a").relayOnce();
    expect(report.published).toBeGreaterThanOrEqual(expected.length);
    expect(await pendingCount()).toBe(0);

    const delivered = (await drain(queues.client, queues.eventsQueueUrl)).filter((m) => m.Attributes?.MessageGroupId === w.walletId);
    expect(delivered.map((m) => m.MessageAttributes?.eventId?.StringValue)).toEqual(expected);
    const envelope = JSON.parse(delivered.at(-1)!.Body!) as Record<string, unknown>;
    expect(envelope).toMatchObject({ eventType: "WalletBalanceChanged", aggregateId: w.walletId, version: 1 });
    expect(envelope).toHaveProperty("eventId");
    expect(envelope).toHaveProperty("correlationId");

    expect((await relay("instance-a").relayOnce()).published).toBe(0);
  });

  test("wallet com mais de 10 eventos: a publicação em lotes do SQS preserva a ordem da wallet", async () => {
    const w = await walletWithActivity(12);
    const expected = await outboxIdsInOrder(w.walletId);
    expect(expected.length).toBeGreaterThan(20);

    await relay("instance-a").relayOnce();
    expect(await pendingCount()).toBe(0);
    const delivered = (await drain(queues.client, queues.eventsQueueUrl)).filter((m) => m.Attributes?.MessageGroupId === w.walletId);
    expect(delivered.map((m) => m.MessageAttributes?.eventId?.StringValue)).toEqual(expected);
  });

  test("claim respeita a wallet em andamento: outra instância pega outras wallets em vez de esperar", async () => {
    const busy = await walletWithActivity(3);
    const other = await walletWithActivity(3);
    const store = new SqlOutboxStore(h.orm);

    const first = await store.claimDue("instance-a", 2, 30_000);
    expect(first.every((c) => c.message.partitionKey === busy.walletId)).toBe(true);

    const second = await store.claimDue("instance-b", 100, 30_000);
    expect(second.some((c) => c.message.partitionKey === busy.walletId)).toBe(false);
    expect(second.some((c) => c.message.partitionKey === other.walletId)).toBe(true);

    await store.release(first.map((c) => c.message), "instance-a");
    await store.release(second.map((c) => c.message), "instance-b");
  });

  test("dois publishers concorrentes sobre a mesma outbox: tudo publicado, sem duplicar, ordem por wallet preservada", async () => {
    const wallets = await Promise.all([1, 2, 3, 4].map(() => walletWithActivity(3)));
    const a = countingPublisher();
    const b = countingPublisher();

    await Promise.all([
      relay("instance-a", a.publisher, { batchSize: 5 }).relayOnce(),
      relay("instance-b", b.publisher, { batchSize: 5 }).relayOnce(),
    ]);
    while ((await pendingCount()) > 0) {
      await Promise.all([
        relay("instance-a", a.publisher, { batchSize: 5 }).relayOnce(),
        relay("instance-b", b.publisher, { batchSize: 5 }).relayOnce(),
      ]);
    }

    const all = [...a.published, ...b.published];
    expect(new Set(all).size).toBe(all.length);
    expect(a.published.length).toBeGreaterThan(0);
    expect(b.published.length).toBeGreaterThan(0);

    const delivered = await drain(queues.client, queues.eventsQueueUrl);
    for (const w of wallets) {
      const order = delivered
        .filter((m) => m.Attributes?.MessageGroupId === w.walletId)
        .map((m) => m.MessageAttributes?.eventId?.StringValue);
      expect(order).toEqual(await outboxIdsInOrder(w.walletId));
    }
  });

  test("processo morre depois de publicar e antes de marcar: outra instância assume e republica com segurança", async () => {
    const w = await walletWithActivity(1);
    const store = new SqlOutboxStore(h.orm);
    const claimed = await store.claimDue("instance-dead", 100, 300);
    for (const { message } of claimed) await publishToSqs(message);

    await Bun.sleep(400);
    const survivor = countingPublisher();
    await relay("instance-alive", survivor.publisher).relayOnce();

    expect(survivor.published.sort()).toEqual(claimed.map((c) => c.message.id).sort());
    expect(await pendingCount()).toBe(0);
    const delivered = (await drain(queues.client, queues.eventsQueueUrl)).filter((m) => m.Attributes?.MessageGroupId === w.walletId);
    const eventIds = delivered.map((m) => m.MessageAttributes?.eventId?.StringValue);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  test("SQS indisponível: backoff persistido, nada perdido, publicado quando volta", async () => {
    await walletWithActivity(1);
    const down = sequentialPublisher(() => Promise.reject(new Error("sqs unavailable")));

    const report = await relay("instance-a", down).relayOnce();
    expect(report.failed).toBeGreaterThan(0);
    const [row] = (await h.sql`
      SELECT attempts, last_error, next_attempt_at > now() AS deferred
        FROM outbox_messages WHERE published_at IS NULL ORDER BY position LIMIT 1`) as { attempts: number; last_error: string; deferred: boolean }[];
    expect(row).toMatchObject({ attempts: 1, last_error: "sqs unavailable", deferred: true });

    expect((await relay("instance-a").relayOnce()).published).toBe(0);
    await Bun.sleep(250);
    await relay("instance-a").relayOnce();
    expect(await pendingCount()).toBe(0);
  });

  test("falha num evento bloqueia só os seguintes da MESMA wallet", async () => {
    const blocked = await walletWithActivity(1);
    const free = await walletWithActivity(1);
    const [firstBlocked] = await outboxIdsInOrder(blocked.walletId);
    const failOnce = sequentialPublisher(async (m) => {
      if (m.id === firstBlocked) throw new Error("transient");
      await publishToSqs(m);
    });

    await relay("instance-a", failOnce).relayOnce();

    const pending = (await h.sql`
      SELECT partition_key, count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL GROUP BY partition_key`) as {
      partition_key: string;
      n: number;
    }[];
    expect(pending).toEqual([{ partition_key: blocked.walletId, n: (await outboxIdsInOrder(blocked.walletId)).length }]);
    expect(pending.some((p) => p.partition_key === free.walletId)).toBe(false);
  });
});

describe("relógio da aplicação diferente do relógio do banco", () => {
  test.each([
    ["adiantado 5s", 5_000],
    ["atrasado 5s", -5_000],
  ])("relógio %s: o evento é publicado imediatamente e o backoff segue o relógio do banco", async (_label, skewMs) => {
    const skewed = { now: () => new Date(Date.now() + skewMs) };
    const app = await createHarness({ clock: skewed });
    try {
      const w = await newWallet(app, "10.00");
      await app.processWager.execute(wagerPayload({ ...w, kind: "BET", amount: "1.00" }), http());
      const store = new SqlOutboxStore(app.orm);
      const relayWith = (publisher: EventPublisher) =>
        new OutboxRelay(store, publisher, skewed, options("skewed", { retryPolicy: { baseDelayMs: 300, maxDelayMs: 300 } }));

      const down = await relayWith(sequentialPublisher(() => Promise.reject(new Error("sqs unavailable")))).relayOnce();
      expect(down.failed).toBe(1);

      const [row] = (await app.sql`
        SELECT EXTRACT(EPOCH FROM (next_attempt_at - now())) * 1000 AS wait_ms
          FROM outbox_messages WHERE published_at IS NULL ORDER BY position LIMIT 1`) as { wait_ms: string }[];
      expect(Number(row!.wait_ms)).toBeGreaterThan(0);
      expect(Number(row!.wait_ms)).toBeLessThanOrEqual(300);

      await Bun.sleep(350);
      const published: string[] = [];
      const report = await relayWith(sequentialPublisher(async (m) => void published.push(m.id))).relayOnce();
      expect(report.published).toBe(3);
    } finally {
      await app.close();
    }
  });
});
