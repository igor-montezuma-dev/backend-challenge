/**
 * Configuração tipada e validada no boot: se faltar algo, a aplicação não sobe
 * (falhar cedo é melhor que falhar no meio de uma transação financeira).
 */
export interface AppConfig {
  readonly port: number;
  readonly instanceId: string;
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
  };
  readonly sqs: {
    readonly region: string;
    readonly endpoint: string | undefined;
    readonly wagerQueueUrl: string;
    readonly eventsQueueUrl: string;
  };
}

export const APP_CONFIG = Symbol("APP_CONFIG");

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${key} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: integer(env, "PORT", 3000),
    // Identifica a instância nos leases da outbox e nos logs.
    instanceId: env.INSTANCE_ID ?? `${env.HOSTNAME ?? "local"}-${process.pid}`,
    database: {
      url: required(env, "DATABASE_URL"),
      poolMax: integer(env, "DATABASE_POOL_MAX", 20),
    },
    sqs: {
      region: env.AWS_REGION ?? "us-east-1",
      endpoint: env.SQS_ENDPOINT,
      wagerQueueUrl: required(env, "SQS_WAGER_QUEUE_URL"),
      eventsQueueUrl: required(env, "SQS_EVENTS_QUEUE_URL"),
    },
  };
}
