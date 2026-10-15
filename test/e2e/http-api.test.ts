import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { setupOpenApi } from "../../src/shared/infrastructure/http/openapi/setup-openapi";
import { createTestDatabase, migrateUp } from "../support/database";
import { uniq } from "../support/harness";
import { type TestQueues, createTestQueues } from "../support/sqs";

let app: INestApplication;
let base: string;
let drop: () => Promise<void>;
let queues: TestQueues;

beforeAll(async () => {
  const db = await createTestDatabase();
  await migrateUp(db.sql);
  drop = db.drop;
  queues = await createTestQueues();
  Object.assign(process.env, {
    DATABASE_URL: db.url,
    SQS_ENDPOINT: process.env.TEST_SQS_ENDPOINT ?? process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    SQS_WAGER_QUEUE_URL: queues.wagerQueueUrl,
    SQS_WAGER_DLQ_URL: queues.deadLetterQueueUrl,
    SQS_EVENTS_QUEUE_URL: queues.eventsQueueUrl,
    WAGER_CONSUMER_ENABLED: "false",
    OUTBOX_PUBLISHER_ENABLED: "false",
    AUTH_MODE: "disabled",
  });
  app = await NestFactory.create(AppModule, { logger: false });
  setupOpenApi(app);
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await queues.destroy();
  await drop();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? (JSON.parse(text) as any) : undefined };
}

async function createWallet(amount = "1000.00") {
  const playerId = crypto.randomUUID();
  const res = await call("POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

function wager(w: { walletId: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = (extra.externalTransactionId as string) ?? uniq("tx");
  const body = {
    providerId: "provider-a",
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...extra,
  };
  return { body, key: `provider-a:${externalTransactionId}` };
}

const submit = (w: ReturnType<typeof wager>, key = w.key) =>
  call("POST", "/wagering/transactions", w.body, { "Idempotency-Key": key });

describe("documentação OpenAPI", () => {
  test("/docs/openapi.json descreve todos os endpoints e status de submissão", async () => {
    const res = await call("GET", "/docs/openapi.json");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths).sort()).toEqual([
      "/health/live",
      "/health/ready",
      "/providers/{providerId}/wagering/transactions/{externalTransactionId}",
      "/wagering/transactions",
      "/wagering/transactions/{transactionId}",
      "/wallets",
      "/wallets/{walletId}",
      "/wallets/{walletId}/ledger",
      "/wallets/{walletId}/reconciliation",
    ]);
    const submit = res.body.paths["/wagering/transactions"].post;
    expect(Object.keys(submit.responses).sort()).toEqual(["200", "201", "202", "400", "401", "403", "404", "409", "422", "503"]);
    const idem = submit.parameters.filter((p: { name: string; in: string }) => p.in === "header" && p.name.toLowerCase() === "idempotency-key");
    expect(idem).toEqual([expect.objectContaining({ name: "Idempotency-Key", required: true })]);
  });

  test("/docs serve a interface do Swagger", async () => {
    const res = await fetch(`${base}/docs`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("swagger-ui");
  });
});

describe("health", () => {
  test("live e ready abertos; ready checa PostgreSQL e SQS", async () => {
    expect((await call("GET", "/health/live")).body).toEqual({ status: "ok" });
    const ready = await call("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: { status: "up" }, sqs: { status: "up" } });
  });
});

describe("POST /wallets", () => {
  test("201 com o formato do contrato", async () => {
    const playerId = crypto.randomUUID();
    const res = await call("POST", "/wallets", { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      playerId,
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
  });

  test("409 para wallet duplicada (player + moeda)", async () => {
    const playerId = crypto.randomUUID();
    const body = { playerId, initialBalance: { amount: "1.00", currency: "BRL" } };
    expect((await call("POST", "/wallets", body)).status).toBe(201);
    const dup = await call("POST", "/wallets", body);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: "WALLET_ALREADY_EXISTS", retryable: false });
  });

  test.each([
    ["amount number", { amount: 10, currency: "BRL" }],
    ["três casas", { amount: "1.001", currency: "BRL" }],
    ["notação científica", { amount: "1e3", currency: "BRL" }],
    ["negativo", { amount: "-1.00", currency: "BRL" }],
    ["moeda inválida", { amount: "1.00", currency: "real" }],
  ])("400 para initialBalance inválido (%s)", async (_label, initialBalance) => {
    const res = await call("POST", "/wallets", { playerId: crypto.randomUUID(), initialBalance });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", field: "money", retryable: false });
  });

  test("400 para JSON malformado", async () => {
    const res = await call("POST", "/wallets", "{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MALFORMED_REQUEST");
  });

  test("corpo grande demais ou com encoding não suportado é erro do cliente (4xx), não 500", async () => {
    const tooLarge = await fetch(`${base}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(2_000_000) }),
    });
    expect(tooLarge.status).toBe(413);
    expect(((await tooLarge.json()) as { error: unknown }).error).toMatchObject({ code: "PAYLOAD_TOO_LARGE", retryable: false });

    const encoding = await fetch(`${base}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "unknown" },
      body: "{}",
    });
    expect(encoding.status).toBe(415);
    expect(((await encoding.json()) as { error: { retryable: boolean } }).error.retryable).toBe(false);
  });
});

describe("POST /wagering/transactions — mapeamento de status", () => {
  test("201 processada → 200 no replay, mesmo corpo exceto idempotentReplay", async () => {
    const w = await createWallet("1000.00");
    const op = wager(w, "BET", "25.00");
    const first = await submit(op);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
    expect(first.headers.get("location")).toBe(`/wagering/transactions/${first.body.transactionId}`);

    const replay = await submit(op);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test("422 rejeição de negócio, com failureCode e providerAction — e 422 também no replay", async () => {
    const w = await createWallet("10.00");
    const op = wager(w, "BET", "80.00");
    const res = await submit(op);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      providerAction: "do-not-retry",
      balance: { amount: "10.00", currency: "BRL" },
      idempotentReplay: false,
    });
    const replay = await submit(op);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("202 aceita com referência pendente", async () => {
    const w = await createWallet("100.00");
    const res = await submit(wager(w, "REFUND", "10.00", { referenceExternalTransactionId: uniq("future-bet") }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "PENDING_REFERENCE", balance: null });
  });

  test("409 mesma key com payload diferente", async () => {
    const w = await createWallet("100.00");
    const op = wager(w, "BET", "10.00");
    await submit(op);
    const res = await call("POST", "/wagering/transactions", { ...op.body, money: { amount: "11.00", currency: "BRL" } }, { "Idempotency-Key": op.key });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", retryable: false });
  });

  test("400 sem Idempotency-Key; o header é a fonte da verdade", async () => {
    const w = await createWallet("100.00");
    const op = wager(w, "BET", "10.00");
    const missing = await call("POST", "/wagering/transactions", op.body);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: "VALIDATION_ERROR", field: "Idempotency-Key" });

    const inBody = await call("POST", "/wagering/transactions", { ...op.body, idempotencyKey: "body-key" }, { "Idempotency-Key": op.key });
    expect(inBody.status).toBe(400);
    expect(inBody.body.error).toMatchObject({ code: "VALIDATION_ERROR", field: "idempotencyKey" });
    expect((await submit(op)).status).toBe(201);
  });

  test("400 para campos fora do contrato, no corpo e dentro de money; nada é gravado", async () => {
    const w = await createWallet("100.00");
    const extraField = wager(w, "BET", "10.00", { bonus: "999.00" });
    const top = await submit(extraField);
    expect(top.status).toBe(400);
    expect(top.body.error).toMatchObject({ code: "VALIDATION_ERROR", field: "bonus", retryable: false });

    const nested = wager(w, "BET", "10.00");
    const res = await call("POST", "/wagering/transactions", { ...nested.body, money: { amount: "10.00", currency: "BRL", fee: "1.00" } }, { "Idempotency-Key": nested.key });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", field: "money.fee" });

    const wallet = await call("POST", "/wallets", { playerId: crypto.randomUUID(), initialBalance: { amount: "1.00", currency: "BRL" }, vip: true });
    expect(wallet.status).toBe(400);
    expect(wallet.body.error.field).toBe("vip");

    expect((await call("GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("100.00");
    expect((await call("GET", `/wallets/${w.walletId}/ledger`)).body.items).toHaveLength(1);
  });

  test("400 para amount fora da escala fixa de 2 casas", async () => {
    const w = await createWallet("100.00");
    for (const amount of ["10", "10.5", "10.000"]) {
      const res = await submit(wager(w, "BET", amount));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", field: "money" });
    }
    const wallet = await call("POST", "/wallets", { playerId: crypto.randomUUID(), initialBalance: { amount: "100", currency: "BRL" } });
    expect(wallet.status).toBe(400);
  });

  test("400 payload inválido (kind OPENING, amount number, uuid inválido)", async () => {
    const w = await createWallet("100.00");
    const opening = wager(w, "OPENING", "10.00");
    expect((await submit(opening)).status).toBe(400);

    const numeric = wager(w, "BET", "10.00");
    const res = await call("POST", "/wagering/transactions", { ...numeric.body, money: { amount: 10, currency: "BRL" } }, { "Idempotency-Key": numeric.key });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe("money");

    const badWallet = wager({ walletId: "not-a-uuid", playerId: w.playerId }, "BET", "1.00");
    expect((await submit(badWallet)).body.error).toMatchObject({ code: "VALIDATION_ERROR", field: "walletId" });
  });

  test("404 wallet inexistente", async () => {
    const res = await submit(wager({ walletId: crypto.randomUUID(), playerId: crypto.randomUUID() }, "BET", "1.00"));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("WALLET_NOT_FOUND");
  });

  test("cenário da seção 8 via HTTP: 100.00, duas apostas de 80.00 simultâneas", async () => {
    const w = await createWallet("100.00");
    const [a, b] = await Promise.all([submit(wager(w, "BET", "80.00")), submit(wager(w, "BET", "80.00"))]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const wallet = await call("GET", `/wallets/${w.walletId}`);
    expect(wallet.body.balance).toEqual({ amount: "20.00", currency: "BRL" });
  });

  test("mesma aposta 50x em paralelo via HTTP: um 201 e 49 replays 200", async () => {
    const w = await createWallet("100.00");
    const op = wager(w, "BET", "1.00");
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(op)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect((await call("GET", `/wallets/${w.walletId}`)).body.balance.amount).toBe("99.00");
  });
});

describe("consultas", () => {
  test("GET /wagering/transactions/:id e por id externo devolvem a mesma transação", async () => {
    const w = await createWallet("100.00");
    const op = wager(w, "BET", "10.00");
    const created = await submit(op);
    const byId = await call("GET", `/wagering/transactions/${created.body.transactionId}`);
    const byExternal = await call("GET", `/providers/provider-a/wagering/transactions/${op.body.externalTransactionId}`);
    expect(byId.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({
      kind: "BET",
      status: "PROCESSED",
      money: { amount: "10.00", currency: "BRL" },
      balanceAfter: { amount: "90.00", currency: "BRL" },
      failureCode: null,
    });
  });

  test("404 transação inexistente e 400 id malformado", async () => {
    expect((await call("GET", `/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("GET", "/wagering/transactions/xyz")).status).toBe(400);
    expect((await call("GET", "/providers/provider-a/wagering/transactions/nope")).body.error.code).toBe("TRANSACTION_NOT_FOUND");
    expect((await call("GET", `/wallets/${crypto.randomUUID()}`)).body.error.code).toBe("WALLET_NOT_FOUND");
  });

  test("ledger paginado por cursor estável, sem buracos nem repetições", async () => {
    const w = await createWallet("100.00");
    for (let i = 0; i < 6; i++) await submit(wager(w, "BET", "1.00"));

    const page1 = await call("GET", `/wallets/${w.walletId}/ledger?limit=3`);
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([1, 2, 3]);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    await submit(wager(w, "WIN", "5.00"));

    const page2 = await call("GET", `/wallets/${w.walletId}/ledger?limit=3&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([4, 5, 6]);
    const page3 = await call("GET", `/wallets/${w.walletId}/ledger?limit=3&cursor=${page2.body.nextCursor}`);
    expect(page3.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([7, 8]);
    expect(page3.body.nextCursor).toBeNull();

    expect(page1.body.items[0]).toMatchObject({
      direction: "CREDIT",
      money: { amount: "100.00", currency: "BRL" },
      balanceBefore: { amount: "0.00", currency: "BRL" },
      balanceAfter: { amount: "100.00", currency: "BRL" },
    });
  });

  test("ledger: cursor e limit inválidos → 400", async () => {
    const w = await createWallet("1.00");
    expect((await call("GET", `/wallets/${w.walletId}/ledger?cursor=garbage`)).body.error.field).toBe("cursor");
    expect((await call("GET", `/wallets/${w.walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await call("GET", `/wallets/${w.walletId}/ledger?limit=500`)).status).toBe(400);
  });
});

describe("POST /wallets/:id/reconciliation", () => {
  test("consistente após uma série de operações", async () => {
    const w = await createWallet("975.00");
    await submit(wager(w, "BET", "100.00"));
    await submit(wager(w, "WIN", "100.00"));
    const res = await call("POST", `/wallets/${w.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      walletId: w.walletId,
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test("wallet aberta com saldo zero é consistente com zero lançamentos", async () => {
    const w = await createWallet("0.00");
    const res = await call("POST", `/wallets/${w.walletId}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: true, checkedEntries: 0 });
  });

  test("404 para wallet inexistente", async () => {
    expect((await call("POST", `/wallets/${crypto.randomUUID()}/reconciliation`)).status).toBe(404);
  });
});

describe("observabilidade", () => {
  const scrape = async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    return res.text();
  };
  const sample = (text: string, metric: string, labels: string) => {
    const line = text.split("\n").find((l) => l.startsWith(`${metric}{`) && labels.split(",").every((p) => l.includes(p)));
    return line ? Number(line.split(" ").at(-1)) : 0;
  };

  test("/metrics expõe métricas de negócio, outbox, fila e pendências no formato Prometheus", async () => {
    const w = await createWallet();
    const bet = wager(w, "BET", "10.00");
    const before = await scrape();
    expect((await submit(bet)).status).toBe(201);
    expect((await submit(bet)).status).toBe(200);
    const after = await scrape();

    for (const metric of [
      "wagering_transactions_total",
      "wagering_duplicates_detected_total",
      "wagering_transaction_duration_seconds_bucket",
      "wagering_outbox_pending_events",
      "wagering_outbox_lag_seconds",
      "wagering_pending_references",
      "wagering_db_retries_total",
      "wagering_lock_conflicts_total",
      "wagering_queue_messages_total",
      "wagering_dead_letter_queue_messages",
      "wagering_process_cpu_seconds_total",
    ]) {
      expect(after).toContain(`# TYPE ${metric.replace(/_bucket$/, "")}`);
    }
    const processed = 'kind="BET",status="PROCESSED",channel="http"';
    expect(sample(after, "wagering_transactions_total", processed)).toBe(sample(before, "wagering_transactions_total", processed) + 1);
    expect(sample(after, "wagering_duplicates_detected_total", 'channel="http"')).toBe(
      sample(before, "wagering_duplicates_detected_total", 'channel="http"') + 1,
    );
    expect(sample(after, "wagering_outbox_pending_events", "instance=")).toBeGreaterThan(0);
  });

  test("correlation id: devolvido no header, gerado quando ausente e rejeitado quando inseguro", async () => {
    const given = await fetch(`${base}/health/live`, { headers: { "x-correlation-id": "trace-123" } });
    expect(given.headers.get("x-correlation-id")).toBe("trace-123");

    const generated = await fetch(`${base}/health/live`);
    expect(generated.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);

    const unsafe = await fetch(`${base}/health/live`, { headers: { "x-correlation-id": "<script>" } });
    expect(unsafe.headers.get("x-correlation-id")).not.toBe("<script>");
  });
});
