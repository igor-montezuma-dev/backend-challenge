import { type JsonLogLevel, parseLogLevel } from "../shared/infrastructure/observability/json-logger";

export interface AppConfig {
  readonly port: number;
  readonly instanceId: string;
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
  };
  readonly wagering: {
    readonly lockTimeoutMs: number;
    readonly maxTransactionAttempts: number;
  };
  readonly sqs: {
    readonly region: string;
    readonly endpoint: string | undefined;
    readonly wagerQueueUrl: string;
    readonly wagerDeadLetterQueueUrl: string;
    readonly eventsQueueUrl: string;
  };
  readonly consumer: {
    readonly enabled: boolean;
    readonly name: string;
    readonly maxMessages: number;
    readonly waitTimeSeconds: number;
    readonly visibilityTimeoutSeconds: number;
    readonly maxRetryDelaySeconds: number;
    readonly shutdownGraceMs: number;
  };
  readonly outbox: {
    readonly enabled: boolean;
    readonly batchSize: number;
    readonly pollIntervalMs: number;
    readonly leaseMs: number;
  };
  readonly pendingReferences: {
    readonly enabled: boolean;
    readonly batchSize: number;
    readonly pollIntervalMs: number;
    readonly leaseMs: number;
  };
  readonly logLevel: JsonLogLevel;
  readonly auth: AuthConfig;
}

export type AuthConfig =
  | { readonly mode: "disabled" }
  | {
      readonly mode: "jwt";
      readonly issuer: string;
      readonly audience: string;
      readonly jwksUrl: string;
      readonly providerClaim: string;
    };

export const APP_CONFIG = Symbol("APP_CONFIG");

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function positiveInteger(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    throw new Error(`Environment variable ${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function flag(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Environment variable ${key} must be "true" or "false", got "${env[key]}"`);
}

function authConfig(env: Env): AuthConfig {
  const mode = (env.AUTH_MODE ?? "disabled").trim().toLowerCase();
  if (mode === "disabled") return { mode };
  if (mode !== "jwt") throw new Error(`AUTH_MODE must be "disabled" or "jwt", got "${env.AUTH_MODE}"`);
  const issuer = required(env, "AUTH_ISSUER");
  return {
    mode,
    issuer,
    audience: required(env, "AUTH_AUDIENCE"),
    jwksUrl: env.AUTH_JWKS_URL ?? `${issuer}/protocol/openid-connect/certs`,
    providerClaim: env.AUTH_PROVIDER_CLAIM ?? "azp",
  };
}

export function loadAppConfig(env: Env = process.env): AppConfig {
  return {
    port: positiveInteger(env, "PORT", 3000),
    instanceId: env.INSTANCE_ID ?? `${env.HOSTNAME ?? "local"}-${process.pid}`,
    database: {
      url: required(env, "DATABASE_URL"),
      poolMax: positiveInteger(env, "DATABASE_POOL_MAX", 20),
    },
    wagering: {
      lockTimeoutMs: positiveInteger(env, "WALLET_LOCK_TIMEOUT_MS", 5_000),
      maxTransactionAttempts: positiveInteger(env, "TRANSACTION_MAX_ATTEMPTS", 4),
    },
    sqs: {
      region: env.AWS_REGION ?? "us-east-1",
      endpoint: env.SQS_ENDPOINT,
      wagerQueueUrl: required(env, "SQS_WAGER_QUEUE_URL"),
      wagerDeadLetterQueueUrl: required(env, "SQS_WAGER_DLQ_URL"),
      eventsQueueUrl: required(env, "SQS_EVENTS_QUEUE_URL"),
    },
    consumer: {
      enabled: flag(env, "WAGER_CONSUMER_ENABLED", true),
      name: env.WAGER_CONSUMER_NAME ?? "wager-transactions",
      maxMessages: positiveInteger(env, "WAGER_CONSUMER_MAX_MESSAGES", 10),
      waitTimeSeconds: positiveInteger(env, "WAGER_CONSUMER_WAIT_SECONDS", 10),
      visibilityTimeoutSeconds: positiveInteger(env, "WAGER_CONSUMER_VISIBILITY_SECONDS", 30),
      maxRetryDelaySeconds: positiveInteger(env, "WAGER_CONSUMER_MAX_RETRY_DELAY_SECONDS", 300),
      shutdownGraceMs: positiveInteger(env, "WAGER_CONSUMER_SHUTDOWN_GRACE_MS", 20_000),
    },
    outbox: {
      enabled: flag(env, "OUTBOX_PUBLISHER_ENABLED", true),
      batchSize: positiveInteger(env, "OUTBOX_BATCH_SIZE", 50),
      pollIntervalMs: positiveInteger(env, "OUTBOX_POLL_INTERVAL_MS", 500),
      leaseMs: positiveInteger(env, "OUTBOX_LEASE_MS", 30_000),
    },
    pendingReferences: {
      enabled: flag(env, "PENDING_REFERENCE_WORKER_ENABLED", true),
      batchSize: positiveInteger(env, "PENDING_REFERENCE_BATCH_SIZE", 20),
      pollIntervalMs: positiveInteger(env, "PENDING_REFERENCE_POLL_INTERVAL_MS", 1_000),
      leaseMs: positiveInteger(env, "PENDING_REFERENCE_LEASE_MS", 30_000),
    },
    logLevel: parseLogLevel(env.LOG_LEVEL),
    auth: authConfig(env),
  };
}
