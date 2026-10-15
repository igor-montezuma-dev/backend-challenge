import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Server } from "bun";
import { type JWK, type KeyLike, SignJWT, exportJWK, generateKeyPair } from "jose";
import { AppModule } from "../../src/app.module";
import { setupOpenApi } from "../../src/shared/infrastructure/http/openapi/setup-openapi";
import { createTestDatabase, migrateUp } from "../support/database";
import { uniq } from "../support/harness";
import { type TestQueues, createTestQueues } from "../support/sqs";

const ISSUER = "http://issuer.test/realms/wagering";
const AUDIENCE = "wagering-processor";
const AUTH_ENV_KEYS = ["AUTH_MODE", "AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_JWKS_URL"] as const;

let app: INestApplication;
let base: string;
let drop: () => Promise<void>;
let queues: TestQueues;
let jwks: Server<undefined>;
let signingKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });

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
    PENDING_REFERENCE_WORKER_ENABLED: "false",
    AUTH_MODE: "jwt",
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: AUDIENCE,
    AUTH_JWKS_URL: `http://127.0.0.1:${jwks.port}/certs`,
  });
  app = await NestFactory.create(AppModule, { logger: false });
  setupOpenApi(app);
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  jwks.stop(true);
  for (const key of AUTH_ENV_KEYS) delete process.env[key];
  await queues.destroy();
  await drop();
});

function tokenFor(providerId: string, overrides: { audience?: string; expiresAt?: number } = {}): Promise<string> {
  return new SignJWT({ azp: providerId })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresAt ?? "5m")
    .sign(signingKey);
}

async function call(method: string, path: string, options: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

async function walletFor(token: string) {
  const playerId = crypto.randomUUID();
  const res = await call("POST", "/wallets", { token, body: { playerId, initialBalance: { amount: "100.00", currency: "BRL" } } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

function bet(wallet: { walletId: string; playerId: string }, providerId: string) {
  const externalTransactionId = uniq("tx");
  return {
    key: `${providerId}:${externalTransactionId}`,
    externalTransactionId,
    body: {
      providerId,
      externalTransactionId,
      ...wallet,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    },
  };
}

describe("autenticação JWT (AUTH_MODE=jwt)", () => {
  test("health, métricas e documentação continuam públicos", async () => {
    expect((await call("GET", "/health/live")).status).toBe(200);
    expect((await call("GET", "/metrics")).status).toBe(200);
    expect((await call("GET", "/docs/openapi.json")).status).toBe(200);
  });

  test("sem token: 401 com WWW-Authenticate e envelope de erro padrão", async () => {
    const res = await call("POST", "/wallets", { body: { playerId: crypto.randomUUID(), initialBalance: { amount: "1.00", currency: "BRL" } } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(res.body).toEqual({ error: expect.objectContaining({ code: "UNAUTHORIZED", retryable: false }) });
  });

  test("token expirado ou para outra audiência: 401", async () => {
    const expired = await tokenFor("provider-a", { expiresAt: Math.floor(Date.now() / 1000) - 60 });
    const wrongAudience = await tokenFor("provider-a", { audience: "another-service" });
    expect((await call("GET", `/wallets/${crypto.randomUUID()}`, { token: expired })).status).toBe(401);
    expect((await call("GET", `/wallets/${crypto.randomUUID()}`, { token: wrongAudience })).status).toBe(401);
  });

  test("provedor autenticado opera em nome próprio: 201", async () => {
    const token = await tokenFor("provider-a");
    const wallet = await walletFor(token);
    const op = bet(wallet, "provider-a");
    const res = await call("POST", "/wagering/transactions", { token, body: op.body, headers: { "Idempotency-Key": op.key } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "PROCESSED", balance: { amount: "90.00" } });
  });

  test("provedor tentando operar em nome de outro: 403 PROVIDER_MISMATCH e nada é gravado", async () => {
    const tokenA = await tokenFor("provider-a");
    const tokenB = await tokenFor("provider-b");
    const wallet = await walletFor(tokenA);
    const op = bet(wallet, "provider-a");

    const res = await call("POST", "/wagering/transactions", { token: tokenB, body: op.body, headers: { "Idempotency-Key": op.key } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "PROVIDER_MISMATCH", retryable: false });

    const lookup = await call("GET", `/providers/provider-a/wagering/transactions/${op.externalTransactionId}`, { token: tokenA });
    expect(lookup.status).toBe(404);
    expect((await call("GET", `/wallets/${wallet.walletId}`, { token: tokenA })).body.balance.amount).toBe("100.00");
  });

  test("consultas de transação ficam restritas ao provedor dono", async () => {
    const tokenA = await tokenFor("provider-a");
    const tokenB = await tokenFor("provider-b");
    const wallet = await walletFor(tokenA);
    const op = bet(wallet, "provider-a");
    const created = await call("POST", "/wagering/transactions", { token: tokenA, body: op.body, headers: { "Idempotency-Key": op.key } });
    const id = created.body.transactionId as string;

    expect((await call("GET", `/wagering/transactions/${id}`, { token: tokenA })).status).toBe(200);
    expect((await call("GET", `/wagering/transactions/${id}`, { token: tokenB })).status).toBe(404);

    const external = `/providers/provider-a/wagering/transactions/${op.externalTransactionId}`;
    expect((await call("GET", external, { token: tokenA })).status).toBe(200);
    const foreign = await call("GET", external, { token: tokenB });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe("PROVIDER_MISMATCH");
  });

  test("OpenAPI declara apenas o fluxo OAuth2 client credentials do Keycloak para o Authorize do Swagger", async () => {
    const doc = (await call("GET", "/docs/openapi.json")).body;
    expect(Object.keys(doc.components.securitySchemes)).toEqual(["keycloak"]);
    expect(doc.components.securitySchemes.keycloak).toMatchObject({
      type: "oauth2",
      flows: { clientCredentials: { tokenUrl: `${ISSUER}/protocol/openid-connect/token` } },
    });
    expect(doc.paths["/wagering/transactions"].post.security).toEqual([{ keycloak: [] }]);
  });
});
