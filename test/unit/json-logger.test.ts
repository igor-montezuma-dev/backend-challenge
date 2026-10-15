import { describe, expect, test } from "bun:test";
import { AsyncDiagnosticContext } from "../../src/shared/infrastructure/observability/async-diagnostic-context";
import { JsonLogger, parseLogLevel, redact } from "../../src/shared/infrastructure/observability/json-logger";

function capture(level: Parameters<typeof parseLogLevel>[0] = "debug") {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger(parseLogLevel(level), (line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  return { logger, lines };
}

describe("logs estruturados", () => {
  test("uma linha JSON por evento, com nível, contexto e campos", () => {
    const { logger, lines } = capture();
    logger.log({ msg: "wager processed", walletId: "w-1" }, "Wagering");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", context: "Wagering", msg: "wager processed", walletId: "w-1" });
    expect(typeof lines[0]!.time).toBe("string");
  });

  test("mensagens em texto viram o campo msg", () => {
    const { logger, lines } = capture();
    logger.warn("lock timeout", "UnitOfWork");
    expect(lines[0]).toMatchObject({ level: "warn", context: "UnitOfWork", msg: "lock timeout" });
  });

  test("error aceita stack e contexto no formato do Nest", () => {
    const { logger, lines } = capture();
    logger.error("boom", "Error: boom\n    at x", "Bootstrap");
    expect(lines[0]).toMatchObject({ level: "error", context: "Bootstrap", msg: "boom", stack: "Error: boom\n    at x" });
  });

  test("respeita o nível mínimo", () => {
    const { logger, lines } = capture("warn");
    logger.debug("noise");
    logger.log("info");
    logger.warn("kept");
    expect(lines.map((l) => l.msg)).toEqual(["kept"]);
  });

  test("dados sensíveis são mascarados em qualquer profundidade", () => {
    expect(
      redact({
        authorization: "Bearer abc",
        headers: { "x-api-key": "k", cookie: "c" },
        nested: [{ password: "p", accessToken: "t", walletId: "w" }],
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      headers: { "x-api-key": "[REDACTED]", cookie: "[REDACTED]" },
      nested: [{ password: "[REDACTED]", accessToken: "[REDACTED]", walletId: "w" }],
    });
  });

  test("campos de correlação do contexto assíncrono entram em todos os logs da operação", async () => {
    const { logger, lines } = capture();
    const context = new AsyncDiagnosticContext();
    await context.run({ correlationId: "corr-1", messageId: "m-1" }, async () => {
      await Bun.sleep(1);
      context.annotate({ transactionId: "tx-1" });
      logger.log("inside", "Test");
    });
    logger.log("outside", "Test");

    expect(lines[0]).toMatchObject({ correlationId: "corr-1", messageId: "m-1", transactionId: "tx-1", msg: "inside" });
    expect(lines[1]).not.toHaveProperty("correlationId");
  });

  test("operações concorrentes não misturam contexto", async () => {
    const { logger, lines } = capture();
    const context = new AsyncDiagnosticContext();
    await Promise.all(
      ["a", "b", "c"].map((id, i) =>
        context.run({ correlationId: id }, async () => {
          await Bun.sleep(10 - i * 3);
          logger.log(id, "Test");
        }),
      ),
    );
    for (const line of lines) expect(line.correlationId).toBe(line.msg);
  });

  test("LOG_LEVEL inválido falha na inicialização", () => {
    expect(() => parseLogLevel("loud")).toThrow(/LOG_LEVEL/);
  });
});
