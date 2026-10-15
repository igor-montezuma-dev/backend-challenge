import { availableParallelism, cpus, platform, release, totalmem } from "node:os";
import { DeleteMessageBatchCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

type Kind = "BET" | "WIN" | "LOSS" | "REFUND";

interface Settings {
  baseUrls: string[];
  wallets: number;
  requests: number;
  concurrency: number;
  hotWalletRatio: number;
  duplicateRatio: number;
  refundRatio: number;
  eventsQueueUrl: string | undefined;
  sqsEndpoint: string | undefined;
  tokenUrl: string | undefined;
  clientId: string;
  clientSecret: string;
}

interface Operation {
  kind: Kind;
  key: string;
  body: Record<string, unknown>;
}

interface Sample {
  kind: Kind;
  status: number;
  latencyMs: number;
  attempts: number;
  duplicate: boolean;
}

interface WalletRef {
  walletId: string;
  playerId: string;
}

const number = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return value;
};

const settings: Settings = {
  baseUrls: (process.env.LOAD_BASE_URLS ?? "http://localhost:3000,http://localhost:3001,http://localhost:3002")
    .split(",")
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter(Boolean),
  wallets: number("LOAD_WALLETS", 50),
  requests: number("LOAD_REQUESTS", 5_000),
  concurrency: number("LOAD_CONCURRENCY", 64),
  hotWalletRatio: number("LOAD_HOT_WALLET_RATIO", 0.2),
  duplicateRatio: number("LOAD_DUPLICATE_RATIO", 0.1),
  refundRatio: number("LOAD_REFUND_RATIO", 0.05),
  eventsQueueUrl: process.env.LOAD_CONSUME_EVENTS === "false" ? undefined : process.env.SQS_EVENTS_QUEUE_URL,
  sqsEndpoint: process.env.SQS_ENDPOINT,
  tokenUrl:
    process.env.LOAD_AUTH === "false"
      ? undefined
      : (process.env.LOAD_TOKEN_URL ?? "http://localhost:8080/realms/wagering/protocol/openid-connect/token"),
  clientId: process.env.LOAD_CLIENT_ID ?? "load-provider",
  clientSecret: process.env.LOAD_CLIENT_SECRET ?? "load-provider-secret",
};

const SCRAPE_TIMEOUT_MS = 5_000;
const EVENT_CONSUMERS = 4;

const MAX_ATTEMPTS = 4;
const INITIAL_BALANCE = "1000000.00";
const PROVIDER = settings.clientId;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const runId = Date.now().toString(36);
let roundRobin = 0;
const nextBase = () => settings.baseUrls[roundRobin++ % settings.baseUrls.length]!;

let cachedToken: { value: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string | undefined> {
  if (!settings.tokenUrl) return undefined;
  if (cachedToken && cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return cachedToken.value;
  const response = await fetch(settings.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: settings.clientId, client_secret: settings.clientSecret }),
  }).catch((error: unknown) => {
    throw new Error(`could not reach ${settings.tokenUrl} (${String(error)}); set LOAD_AUTH=false if the API runs with AUTH_MODE=disabled`);
  });
  if (!response.ok) throw new Error(`token request failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1_000 };
  return cachedToken.value;
}

async function request(path: string, init: RequestInit = {}, base = nextBase()) {
  const token = await accessToken();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

async function waitUntilReady(): Promise<void> {
  for (const base of settings.baseUrls) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ok = await fetch(`${base}/health/ready`).then((r) => r.ok).catch(() => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error(`${base} is not ready`);
      await Bun.sleep(500);
    }
  }
}

async function createWallets(): Promise<WalletRef[]> {
  return Promise.all(
    Array.from({ length: settings.wallets }, async () => {
      const playerId = crypto.randomUUID();
      const res = await request("/wallets", {
        method: "POST",
        body: JSON.stringify({ playerId, initialBalance: { amount: INITIAL_BALANCE, currency: "BRL" } }),
      });
      if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${JSON.stringify(res.body)}`);
      return { walletId: res.body.id as string, playerId };
    }),
  );
}

const randomAmount = () => `${1 + Math.floor(Math.random() * 9)}.${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`;

function operation(wallet: WalletRef, kind: Kind, extra: Record<string, unknown> = {}): Operation {
  const externalTransactionId = `${runId}-${crypto.randomUUID()}`;
  return {
    kind,
    key: `${PROVIDER}:${externalTransactionId}`,
    body: {
      providerId: PROVIDER,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: `round-${Math.floor(Math.random() * 1_000)}`,
      gameId: "fortune-chimp",
      kind,
      money: { amount: randomAmount(), currency: "BRL" },
      ...extra,
    },
  };
}

function buildWorkload(wallets: WalletRef[]): { operation: Operation; duplicate: boolean }[] {
  const hot = wallets[0]!;
  const workload: { operation: Operation; duplicate: boolean }[] = [];
  for (let i = 0; i < settings.requests; i++) {
    const previous = workload.at(-1 - Math.floor(Math.random() * Math.min(workload.length, 50)));
    if (previous && Math.random() < settings.duplicateRatio) {
      workload.push({ operation: previous.operation, duplicate: true });
      continue;
    }
    const wallet = Math.random() < settings.hotWalletRatio ? hot : wallets[Math.floor(Math.random() * wallets.length)]!;
    const roll = Math.random();
    const kind: Kind = roll < 0.65 ? "BET" : roll < 0.85 ? "WIN" : "LOSS";
    workload.push({ operation: operation(wallet, kind), duplicate: false });
  }
  return workload;
}

async function submit(op: Operation, duplicate: boolean): Promise<Sample> {
  const started = performance.now();
  for (let attempt = 1; ; attempt++) {
    const res = await request("/wagering/transactions", {
      method: "POST",
      headers: { "Idempotency-Key": op.key },
      body: JSON.stringify(op.body),
    }).catch(() => ({ status: 0, headers: new Headers(), body: {} }));
    const retryable = res.status === 503 || res.status === 0;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      return { kind: op.kind, status: res.status, latencyMs: performance.now() - started, attempts: attempt, duplicate };
    }
    await Bun.sleep(Number(res.headers.get("retry-after") ?? "1") * 100 * attempt);
  }
}

async function runPool<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(settings.concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]!);
      }
    }),
  );
  return results;
}

class DownstreamConsumer {
  readonly eventIds = new Set<string>();
  deliveries = 0;
  private running = true;
  private readonly loops: Promise<void>[] = [];

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {
    for (let i = 0; i < EVENT_CONSUMERS; i++) this.loops.push(this.loop());
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const { Messages = [] } = await this.client.send(
          new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ["eventId"] }),
        );
        if (Messages.length === 0) continue;
        for (const message of Messages) {
          this.deliveries++;
          const eventId = message.MessageAttributes?.eventId?.StringValue;
          if (eventId) this.eventIds.add(eventId);
        }
        await this.client.send(
          new DeleteMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
          }),
        );
      } catch {
        await Bun.sleep(200);
      }
    }
  }
}

async function scrape(base: string): Promise<Map<string, number>> {
  const text = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS) })
    .then((r) => r.text())
    .catch(() => "");
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const name = line.slice(0, line.search(/[{ ]/));
    values.set(name, (values.get(name) ?? 0) + Number(line.split(" ").at(-1)));
  }
  return values;
}

async function clusterMetric(name: string): Promise<number> {
  const all = await Promise.all(settings.baseUrls.map(scrape));
  return all.reduce((sum, metrics) => sum + (metrics.get(name) ?? 0), 0);
}

async function outboxSnapshot(): Promise<{ pending: number; lagSeconds: number }> {
  const metrics = await scrape(settings.baseUrls[0]!);
  return { pending: metrics.get("wagering_outbox_pending_events") ?? 0, lagSeconds: metrics.get("wagering_outbox_lag_seconds") ?? 0 };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function latencyRow(samples: readonly Sample[]) {
  const sorted = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const fmt = (v: number) => Number(v.toFixed(1));
  return { n: samples.length, p50: fmt(percentile(sorted, 50)), p95: fmt(percentile(sorted, 95)), p99: fmt(percentile(sorted, 99)), max: fmt(sorted.at(-1) ?? 0) };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const k = key(item);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}

async function main(): Promise<void> {
  console.log("load test settings", { ...settings, clientSecret: "[REDACTED]" });
  await waitUntilReady();
  await accessToken();
  const wallets = await createWallets();
  const workload = buildWorkload(wallets);
  const downstream = settings.eventsQueueUrl
    ? new DownstreamConsumer(
        new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1", ...(settings.sqsEndpoint ? { endpoint: settings.sqsEndpoint } : {}) }),
        settings.eventsQueueUrl,
      )
    : undefined;

  const before = {
    lockConflicts: await clusterMetric("wagering_lock_conflicts_total"),
    dbRetries: await clusterMetric("wagering_db_retries_total"),
  };

  let peakLagSeconds = 0;
  let peakPending = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const snapshot = await outboxSnapshot();
      peakLagSeconds = Math.max(peakLagSeconds, snapshot.lagSeconds);
      peakPending = Math.max(peakPending, snapshot.pending);
      await Bun.sleep(250);
    }
  })();

  const started = performance.now();
  const mainSamples = await runPool(workload, ({ operation, duplicate }) => submit(operation, duplicate));
  const processedBets = workload.filter((w, i) => !w.duplicate && w.operation.kind === "BET" && mainSamples[i]!.status === 201);
  const refunds = processedBets
    .filter(() => Math.random() < settings.refundRatio)
    .map(({ operation: bet }) =>
      operation(
        { walletId: bet.body.walletId as string, playerId: bet.body.playerId as string },
        "REFUND",
        { roundId: bet.body.roundId, money: bet.body.money, referenceExternalTransactionId: bet.body.externalTransactionId },
      ),
    );
  const refundSamples = await runPool(refunds, (op) => submit(op, false));
  const elapsedSeconds = (performance.now() - started) / 1_000;

  const drainStarted = performance.now();
  for (let i = 0; i < 480 && (await outboxSnapshot()).pending > 0; i++) await Bun.sleep(250);
  const drainSeconds = (performance.now() - drainStarted) / 1_000;
  sampling = false;
  await sampler;
  const pendingAfterDrain = (await outboxSnapshot()).pending;
  if (downstream) {
    for (let i = 0; i < 20; i++) {
      const before = downstream.deliveries;
      await Bun.sleep(1_000);
      if (downstream.deliveries === before) break;
    }
    await downstream.stop();
  }

  const reconciliations = await runPool(wallets, async (w) => {
    const res = await request(`/wallets/${w.walletId}/reconciliation`, { method: "POST" });
    return res.body.consistent === true;
  });

  const samples = [...mainSamples, ...refundSamples];
  const failures = samples.filter((s) => s.status === 0 || s.status >= 500);
  const unexpected = samples.filter((s) => ![200, 201, 202, 422].includes(s.status) && s.status !== 0 && s.status < 500);
  const report = {
    environment: {
      bun: Bun.version,
      platform: `${platform()} ${release()}`,
      cpus: `${availableParallelism()} × ${cpus()[0]?.model ?? "unknown"}`,
      memoryGb: Number((totalmem() / 1024 ** 3).toFixed(1)),
      instances: settings.baseUrls.length,
    },
    totals: {
      requests: samples.length,
      durationSeconds: Number(elapsedSeconds.toFixed(2)),
      throughputRps: Number((samples.length / elapsedSeconds).toFixed(1)),
      errorRate: Number((failures.length / samples.length).toFixed(4)),
      clientRetries: samples.reduce((sum, s) => sum + (s.attempts - 1), 0),
    },
    httpStatus: countBy(samples, (s) => String(s.status)),
    latencyMs: {
      all: latencyRow(samples),
      ...Object.fromEntries((["BET", "WIN", "LOSS", "REFUND"] as const).map((k) => [k, latencyRow(samples.filter((s) => s.kind === k))])),
      duplicates: latencyRow(samples.filter((s) => s.duplicate)),
    },
    concurrency: {
      hotWalletShare: settings.hotWalletRatio,
      lockConflicts: (await clusterMetric("wagering_lock_conflicts_total")) - before.lockConflicts,
      dbRetries: (await clusterMetric("wagering_db_retries_total")) - before.dbRetries,
    },
    outbox: {
      peakPendingEvents: peakPending,
      peakLagSeconds: Number(peakLagSeconds.toFixed(3)),
      drainAfterLoadSeconds: Number(drainSeconds.toFixed(2)),
      pendingAfterDrain,
      downstream: downstream
        ? { deliveries: downstream.deliveries, distinctEvents: downstream.eventIds.size, redeliveries: downstream.deliveries - downstream.eventIds.size }
        : "disabled",
    },
    consistency: {
      walletsReconciled: reconciliations.length,
      inconsistent: reconciliations.filter((ok) => !ok).length,
      unexpectedStatuses: unexpected.length,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (report.consistency.inconsistent > 0 || unexpected.length > 0) process.exit(1);
}

await main();
