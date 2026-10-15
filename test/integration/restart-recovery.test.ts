import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { type Harness, createHarness, expectConsistent, newWallet, uniq, wagerPayload } from "../support/harness";
import { SQS_TEST_ENDPOINT, type TestQueues, createTestQueues, drain, eventually, sendWagerMessage } from "../support/sqs";

const WALLETS = 6;
const INITIAL_BALANCE = "1000.00";
const EXPECTED_BALANCE = "995.00";
const ROOT = new URL("../..", import.meta.url).pathname;

let h: Harness;
let queues: TestQueues;
const children: Subprocess[] = [];

beforeAll(async () => {
  h = await createHarness();
  queues = await createTestQueues({ visibilityTimeoutSeconds: 2 });
});

afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await queues.destroy();
  await h.close();
});

function startInstance(name: string, logLevel = "warn"): Subprocess<"ignore", "pipe", "inherit"> {
  const child = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
      INSTANCE_ID: name,
      DATABASE_URL: h.url,
      DATABASE_POOL_MAX: "10",
      SQS_ENDPOINT: SQS_TEST_ENDPOINT,
      SQS_WAGER_QUEUE_URL: queues.wagerQueueUrl,
      SQS_WAGER_DLQ_URL: queues.deadLetterQueueUrl,
      SQS_EVENTS_QUEUE_URL: queues.eventsQueueUrl,
      WAGER_CONSUMER_ENABLED: "true",
      WAGER_CONSUMER_MAX_MESSAGES: "2",
      WAGER_CONSUMER_WAIT_SECONDS: "1",
      WAGER_CONSUMER_VISIBILITY_SECONDS: "2",
      OUTBOX_PUBLISHER_ENABLED: "true",
      OUTBOX_POLL_INTERVAL_MS: "100",
      OUTBOX_LEASE_MS: "2000",
      PENDING_REFERENCE_WORKER_ENABLED: "true",
      PENDING_REFERENCE_POLL_INTERVAL_MS: "100",
      PENDING_REFERENCE_LEASE_MS: "2000",
      LOG_LEVEL: logLevel,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  children.push(child);
  return child;
}

async function enqueueWorkload(): Promise<{ walletIds: string[]; messages: number }> {
  const walletIds: string[] = [];
  let messages = 0;
  for (let i = 0; i < WALLETS; i++) {
    const w = await newWallet(h, INITIAL_BALANCE);
    walletIds.push(w.walletId);
    const bets = Array.from({ length: 6 }, () => uniq("bet"));
    const send = async (payload: Record<string, unknown>) => {
      messages++;
      await sendWagerMessage(queues.client, queues.wagerQueueUrl, { messageId: uniq("msg"), data: payload });
    };
    for (const ext of bets.slice(0, 5)) await send(wagerPayload({ ...w, kind: "BET", amount: "10.00", externalTransactionId: ext }));
    for (const ext of bets.slice(0, 3)) await send(wagerPayload({ ...w, kind: "WIN", amount: "15.00", referenceExternalTransactionId: ext }));
    await send(wagerPayload({ ...w, kind: "REFUND", amount: "20.00", referenceExternalTransactionId: bets[5]! }));
    await send(wagerPayload({ ...w, kind: "BET", amount: "20.00", externalTransactionId: bets[5]! }));
  }
  return { walletIds, messages };
}

const scalar = async (query: Promise<unknown>) => ((await query) as { n: number }[])[0]!.n;
const wagerCount = () => scalar(h.sql`SELECT count(*)::int AS n FROM wager_transactions WHERE kind <> 'OPENING'`);
const settledCount = () =>
  scalar(h.sql`SELECT count(*)::int AS n FROM wager_transactions WHERE kind <> 'OPENING' AND status IN ('PROCESSED', 'REJECTED')`);
const unpublishedCount = () => scalar(h.sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);

describe("reinício do serviço no meio da carga", () => {
  test("SIGKILL durante o processamento: outra instância conclui sem perda, sem duplicidade e com saldo consistente", async () => {
    const { walletIds, messages } = await enqueueWorkload();

    const crashed = startInstance("instance-crashed");
    await eventually(wagerCount, (n) => n >= messages / 4, 30_000);
    crashed.kill("SIGKILL");
    await crashed.exited;
    const processedBeforeCrash = await wagerCount();
    expect(processedBeforeCrash).toBeLessThan(messages);

    const survivor = startInstance("instance-survivor", "info");
    const survivorLogs = new Response(survivor.stdout).text();
    const done = async () => ({ settled: await settledCount(), unpublished: await unpublishedCount() });
    const final = await eventually(done, (s) => s.settled === messages && s.unpublished === 0, 60_000);
    expect(final).toEqual({ settled: messages, unpublished: 0 });

    survivor.kill("SIGTERM");
    await survivor.exited;
    const logs = (await survivorLogs)
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { level: string; msg: string; context?: string });
    for (const worker of ["WagerQueueConsumer", "OutboxRelay", "PendingReferenceSweeper"]) {
      expect(logs.some((l) => l.context === worker && l.msg === `${worker} stopped`)).toBe(true);
    }

    expect(await wagerCount()).toBe(messages);
    expect(await scalar(h.sql`SELECT count(*)::int AS n FROM inbox_messages`)).toBe(messages);
    expect(await scalar(h.sql`SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`)).toBe(0);
    expect(await scalar(h.sql`SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'REJECTED'`)).toBe(0);

    for (const walletId of walletIds) {
      expect(await expectConsistent(h.sql, walletId)).toMatchObject({ balance: EXPECTED_BALANCE, debits: 6, credits: 5 });
      const [chain] = (await h.sql`
        SELECT bool_and(wallet_version = expected) AS contiguous FROM (
          SELECT wallet_version, row_number() OVER (ORDER BY wallet_version) AS expected
            FROM wallet_ledger_entries WHERE wallet_id = ${walletId}) v`) as { contiguous: boolean }[];
      expect(chain!.contiguous).toBe(true);
    }

    const outboxIds = new Set(((await h.sql`SELECT id FROM outbox_messages`) as { id: string }[]).map((r) => r.id));
    const delivered = new Set((await drain(queues.client, queues.eventsQueueUrl)).map((m) => m.MessageAttributes?.eventId?.StringValue));
    expect([...outboxIds].filter((id) => !delivered.has(id))).toEqual([]);
    expect(await drain(queues.client, queues.deadLetterQueueUrl, 0)).toEqual([]);
  }, 120_000);
});
