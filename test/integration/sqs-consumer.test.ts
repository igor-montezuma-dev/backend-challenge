import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { TransientInfrastructureError } from "../../src/shared/application/errors";
import type { QueueConsumer, QueueConsumerOptions } from "../../src/modules/messaging/application/queue-consumer";
import type { MessageQueue } from "../../src/modules/messaging/application/ports/message-queue.port";
import type { WageringUnitOfWork } from "../../src/modules/wagering/application/ports/wagering-repositories";
import { createWagerQueueConsumer } from "../../src/modules/wagering/infrastructure/wager-queue-consumer.factory";
import { type Harness, createHarness, expectConsistent, newWallet, transactionRow, uniq, wagerPayload } from "../support/harness";
import { type TestQueues, createTestQueues, drain, eventually, sendWagerMessage, visibleCount } from "../support/sqs";

const CONSUMER = "wager-transactions";
const FAST: QueueConsumerOptions = {
  maxMessages: 10,
  waitTimeSeconds: 1,
  visibilityTimeoutSeconds: 1,
  maxRetryDelaySeconds: 1,
  shutdownGraceMs: 5_000,
  errorBackoffMs: 50,
};

let h: Harness;
let queues: TestQueues;
const extraQueues: TestQueues[] = [];

beforeAll(async () => {
  h = await createHarness();
  queues = await createTestQueues({ maxReceiveCount: 3 });
});

afterAll(async () => {
  for (const q of [queues, ...extraQueues]) await q.destroy();
  await h.close();
});

afterEach(async () => {
  await drain(queues.client, queues.wagerQueueUrl, 0);
  await drain(queues.client, queues.deadLetterQueueUrl, 0);
});

function consumerFor(
  harness: Harness,
  q: TestQueues = queues,
  overrides: { options?: Partial<QueueConsumerOptions>; decorateQueue?: (queue: MessageQueue) => MessageQueue } = {},
): QueueConsumer {
  return createWagerQueueConsumer({
    processWager: harness.processWager,
    sqs: q.client,
    queueUrl: q.wagerQueueUrl,
    deadLetterQueueUrl: q.deadLetterQueueUrl,
    consumerName: CONSUMER,
    options: { ...FAST, ...overrides.options },
    ...(overrides.decorateQueue ? { decorateQueue: overrides.decorateQueue } : {}),
  });
}

const inboxCount = async (messageId: string) =>
  ((await h.sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id = ${messageId}`)[0] as { n: number }).n;

const transactionByKey = async (key: string) =>
  (await h.sql`SELECT id, status, failure_code FROM wager_transactions WHERE idempotency_key = ${key}`) as {
    id: string;
    status: string;
    failure_code: string | null;
  }[];

describe("consumidor SQS → mesmo caso de uso do HTTP", () => {
  test("mensagem válida: processa, grava inbox na mesma transação e faz ack depois do commit", async () => {
    const w = await newWallet(h, "100.00");
    const data = wagerPayload({ ...w, kind: "BET", amount: "25.00" });
    const messageId = uniq("msg");
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId, data });

    expect(await consumerFor(h).pollOnce()).toBe(1);

    const [tx] = await transactionByKey(data.idempotencyKey as string);
    expect(tx?.status).toBe("PROCESSED");
    expect(await inboxCount(messageId)).toBe(1);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "75.00", debits: 1 });
    expect(await visibleCount(queues.client, queues.wagerQueueUrl)).toBe(0);
  });

  test("redelivery do mesmo messageId: um único efeito, as duas entregas recebem ack", async () => {
    const w = await newWallet(h, "100.00");
    const data = wagerPayload({ ...w, kind: "BET", amount: "10.00" });
    const messageId = uniq("msg");
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId, data });
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId, data });

    const consumer = consumerFor(h);
    await eventually(() => consumer.pollOnce(), () => false, 2_500);

    expect(await transactionByKey(data.idempotencyKey as string)).toHaveLength(1);
    expect(await inboxCount(messageId)).toBe(1);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ debits: 1 });
    expect(await visibleCount(queues.client, queues.wagerQueueUrl)).toBe(0);
  });

  test("rejeição de negócio é terminal: ack e transação REJECTED auditável", async () => {
    const w = await newWallet(h, "5.00");
    const data = wagerPayload({ ...w, kind: "BET", amount: "50.00" });
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId: uniq("msg"), data });

    await consumerFor(h).pollOnce();

    expect(await transactionByKey(data.idempotencyKey as string)).toEqual([
      expect.objectContaining({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" }),
    ]);
    expect(await visibleCount(queues.client, queues.deadLetterQueueUrl)).toBe(0);
  });

  test("conflito de idempotência é terminal: ack sem novo efeito", async () => {
    const w = await newWallet(h, "100.00");
    const data = wagerPayload({ ...w, kind: "BET", amount: "10.00" });
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId: uniq("msg"), data });
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, {
      messageId: uniq("msg"),
      data: { ...data, money: { amount: "99.00", currency: "BRL" } },
    });

    const consumer = consumerFor(h);
    await eventually(() => consumer.pollOnce(), () => false, 2_500);

    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "90.00", debits: 1 });
    expect(await visibleCount(queues.client, queues.deadLetterQueueUrl)).toBe(0);
  });

  test.each([
    ["JSON inválido", "{not json"],
    ["tipo desconhecido", JSON.stringify({ messageId: "m", type: "Other", data: {} })],
    ["payload inválido (amount number)", JSON.stringify({ messageId: "m-bad", type: "WagerTransactionRequested", data: { money: { amount: 10 } } })],
  ])("erro permanente vai direto para a DLQ: %s", async (_label, rawBody) => {
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId: uniq("bad"), data: {} }, { rawBody, groupId: "bad" });

    await consumerFor(h).pollOnce();

    const dead = await drain(queues.client, queues.deadLetterQueueUrl);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.Body).toBe(rawBody);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toEqual(expect.any(String));
    expect(await visibleCount(queues.client, queues.wagerQueueUrl)).toBe(0);
  });

  test("ordem FIFO por wallet: REFUND enviado depois da BET é aplicado depois dela", async () => {
    const w = await newWallet(h, "100.00");
    const bet = wagerPayload({ ...w, kind: "BET", amount: "30.00" });
    const refund = wagerPayload({ ...w, kind: "REFUND", amount: "30.00", referenceExternalTransactionId: bet.externalTransactionId as string });
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId: uniq("msg"), data: bet });
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId: uniq("msg"), data: refund });

    const consumer = consumerFor(h);
    await eventually(() => consumer.pollOnce(), () => false, 2_500);

    expect((await transactionByKey(refund.idempotencyKey as string))[0]?.status).toBe("PROCESSED");
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "100.00" });
  });
});

describe("falhas e recuperação", () => {
  test("falha transitória: retry com backoff e sucesso na redelivery", async () => {
    let failuresLeft = 0;
    const flaky = await createHarness({
      decorateUnitOfWork: (inner: WageringUnitOfWork): WageringUnitOfWork => ({
        run: (work) => {
          if (failuresLeft-- > 0) throw new TransientInfrastructureError("database unavailable");
          return inner.run(work);
        },
      }),
    });
    try {
      const w = await newWallet(flaky, "100.00");
      failuresLeft = 1;
      const data = wagerPayload({ ...w, kind: "BET", amount: "10.00" });
      await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId: uniq("msg"), data });

      const consumer = consumerFor(flaky);
      await consumer.pollOnce();
      expect(await flaky.sql`SELECT 1 FROM wager_transactions WHERE idempotency_key = ${data.idempotencyKey as string}`).toHaveLength(0);

      await eventually(() => consumer.pollOnce(), (n) => n > 0, 5_000);
      expect(await expectConsistent(flaky.sql, w.walletId)).toMatchObject({ balance: "90.00", debits: 1 });
      expect(await visibleCount(queues.client, queues.wagerQueueUrl)).toBe(0);
    } finally {
      await flaky.close();
    }
  });

  test("falha transitória persistente: respeita maxReceiveCount e termina na DLQ", async () => {
    const broken = await createHarness({
      decorateUnitOfWork: (): WageringUnitOfWork => ({
        run: () => Promise.reject(new TransientInfrastructureError("database unavailable")),
      }),
    });
    try {
      await sendWagerMessage(queues.client, queues.wagerQueueUrl, {
        messageId: uniq("msg"),
        data: wagerPayload({ walletId: crypto.randomUUID(), playerId: crypto.randomUUID(), kind: "BET", amount: "1.00" }),
      });

      const consumer = consumerFor(broken);
      const dead = await eventually(
        async () => {
          await consumer.pollOnce();
          return visibleCount(queues.client, queues.deadLetterQueueUrl);
        },
        (n) => n === 1,
        20_000,
      );
      expect(dead).toBe(1);
      expect(await visibleCount(queues.client, queues.wagerQueueUrl)).toBe(0);
    } finally {
      await broken.close();
    }
  }, 30_000);

  test("worker morre depois do commit e antes do ack: a redelivery é deduplicada pela inbox", async () => {
    const w = await newWallet(h, "100.00");
    const data = wagerPayload({ ...w, kind: "BET", amount: "40.00" });
    const messageId = uniq("msg");
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId, data });

    let crashes = 1;
    const crashingBeforeAck = consumerFor(h, queues, {
      decorateQueue: (queue) => ({
        ...bind(queue),
        acknowledge: async (message) => {
          if (crashes-- > 0) throw new Error("process killed before ack");
          return queue.acknowledge(message);
        },
      }),
    });

    await expect(crashingBeforeAck.pollOnce()).rejects.toThrow("process killed before ack");
    expect(await inboxCount(messageId)).toBe(1);

    const restarted = consumerFor(h);
    await eventually(() => restarted.pollOnce(), (n) => n > 0, 5_000);

    expect(await inboxCount(messageId)).toBe(1);
    expect(await transactionByKey(data.idempotencyKey as string)).toHaveLength(1);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "60.00", debits: 1 });
    expect(await visibleCount(queues.client, queues.wagerQueueUrl)).toBe(0);
  });

  test("SIGTERM: conclui a mensagem em andamento e devolve a visibilidade das demais", async () => {
    const slowQueues = await createTestQueues({ visibilityTimeoutSeconds: 30 });
    extraQueues.push(slowQueues);
    const w = await newWallet(h, "100.00");
    const ops = [1, 2, 3].map(() => wagerPayload({ ...w, kind: "BET", amount: "1.00" }));
    for (const data of ops) await sendWagerMessage(slowQueues.client, slowQueues.wagerQueueUrl, { messageId: uniq("msg"), data });

    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstStarted = resolve));
    const consumer = consumerFor(h, slowQueues, {
      options: { visibilityTimeoutSeconds: 30 },
      decorateQueue: (queue) => ({
        ...bind(queue),
        acknowledge: async (message) => {
          firstStarted();
          await Bun.sleep(300);
          return queue.acknowledge(message);
        },
      }),
    });

    consumer.start();
    await started;
    await consumer.stop();

    const processed = (await h.sql`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ${w.walletId} AND kind = 'BET'`)[0] as { n: number };
    expect(processed.n).toBe(1);
    expect(await visibleCount(slowQueues.client, slowQueues.wagerQueueUrl)).toBe(2);

    const afterRestart = consumerFor(h, slowQueues);
    await eventually(() => afterRestart.pollOnce(), () => false, 2_500);
    expect(await expectConsistent(h.sql, w.walletId)).toMatchObject({ balance: "97.00", debits: 3 });
  }, 20_000);
});

describe("referência pendente via fila", () => {
  test("ROLLBACK chega antes da BET: fica PENDING_REFERENCE e a mensagem recebe ack", async () => {
    const w = await newWallet(h, "100.00");
    const betExternalId = uniq("bet");
    const rollback = wagerPayload({ ...w, kind: "ROLLBACK", amount: "10.00", referenceExternalTransactionId: betExternalId });
    await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId: uniq("msg"), data: rollback }, { groupId: "g-rollback" });

    await consumerFor(h).pollOnce();

    const [tx] = await transactionByKey(rollback.idempotencyKey as string);
    expect((await transactionRow(h.sql, tx!.id)).status).toBe("PENDING_REFERENCE");
    expect(await visibleCount(queues.client, queues.wagerQueueUrl)).toBe(0);
  });
});

function bind(queue: MessageQueue): MessageQueue {
  return {
    receive: queue.receive.bind(queue),
    acknowledge: queue.acknowledge.bind(queue),
    retryLater: queue.retryLater.bind(queue),
    release: queue.release.bind(queue),
    deadLetter: queue.deadLetter.bind(queue),
  };
}
