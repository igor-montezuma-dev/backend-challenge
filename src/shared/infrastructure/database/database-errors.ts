import {
  ConnectionException,
  DeadlockException,
  DriverException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";

const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03", "57P01", "57P02", "57P03", "53300"]);
const TRANSIENT_NODE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

interface PgLikeError {
  code?: string;
  sqlState?: string;
  constraint?: string;
  message?: string;
}

export function sqlStateOf(error: unknown): string | undefined {
  const e = error as PgLikeError | undefined;
  const code = e?.sqlState ?? e?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof ConnectionException || error instanceof DeadlockException || error instanceof LockWaitTimeoutException) {
    return true;
  }
  const state = sqlStateOf(error);
  if (state && (TRANSIENT_SQLSTATES.has(state) || state.startsWith("08"))) return true;
  const code = (error as PgLikeError | undefined)?.code;
  if (code && TRANSIENT_NODE_CODES.has(code)) return true;
  const message = (error as PgLikeError | undefined)?.message ?? "";
  return /Connection terminated|connection timeout|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(message);
}

export function isLockTimeout(error: unknown): boolean {
  return error instanceof LockWaitTimeoutException || sqlStateOf(error) === "55P03";
}

export function uniqueViolationConstraint(error: unknown): string | undefined {
  const isUnique = error instanceof UniqueConstraintViolationException || sqlStateOf(error) === "23505";
  if (!isUnique) return undefined;
  const e = error as PgLikeError;
  if (e.constraint) return e.constraint;
  return /constraint "([^"]+)"/.exec(e.message ?? "")?.[1];
}

export { DriverException };
