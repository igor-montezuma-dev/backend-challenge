import type { LoggerService, LogLevel } from "@nestjs/common";
import { currentDiagnosticFields } from "./async-diagnostic-context";

export type JsonLogLevel = "debug" | "info" | "warn" | "error";

const SEVERITY: Readonly<Record<JsonLogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /authorization|password|passwd|secret|token|api[-_]?key|cookie|credential/i;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 5;

export function parseLogLevel(raw: string | undefined): JsonLogLevel {
  const value = (raw ?? "info").trim().toLowerCase();
  if (value in SEVERITY) return value as JsonLogLevel;
  throw new Error(`LOG_LEVEL must be one of ${Object.keys(SEVERITY).join(", ")}, got "${raw}"`);
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, depth + 1),
    ]),
  );
}

export class JsonLogger implements LoggerService {
  constructor(
    private readonly minimum: JsonLogLevel = "info",
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit("info", message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit("warn", message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    const [stack, ...rest] = params.length > 1 ? params : [undefined, ...params];
    this.emit("error", message, rest, typeof stack === "string" ? stack : undefined);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit("debug", message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emit("debug", message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.emit("error", message, params);
  }

  setLogLevels(_levels: LogLevel[]): void {}

  private emit(level: JsonLogLevel, message: unknown, params: unknown[], stack?: string): void {
    if (SEVERITY[level] < SEVERITY[this.minimum]) return;
    const context = typeof params.at(-1) === "string" ? (params.at(-1) as string) : undefined;
    const body = typeof message === "object" && message !== null && !(message instanceof Error)
      ? (redact(message) as Record<string, unknown>)
      : { msg: message instanceof Error ? message.message : String(message) };

    this.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        ...(context ? { context } : {}),
        ...currentDiagnosticFields(),
        ...body,
        ...(stack ? { stack } : {}),
      }),
    );
  }
}
