import { Inject, Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { DIAGNOSTIC_CONTEXT } from "../../application/diagnostic-context";
import { CORRELATION_HEADER, correlationIdOf } from "../http/request-context";
import { AsyncDiagnosticContext, currentDiagnosticFields } from "./async-diagnostic-context";

const QUIET_PATHS = new Set(["/health/live", "/health/ready", "/metrics"]);

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger("Http");

  constructor(@Inject(DIAGNOSTIC_CONTEXT) private readonly diagnostics: AsyncDiagnosticContext) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const correlationId = correlationIdOf(request);
    response.setHeader(CORRELATION_HEADER, correlationId);
    const startedAt = performance.now();

    this.diagnostics.runSync({ correlationId }, () => {
      const fields = currentDiagnosticFields();
      response.on("finish", () => {
        if (QUIET_PATHS.has(request.path)) return;
        this.logger.log({
          msg: "http request completed",
          ...fields,
          method: request.method,
          path: request.route?.path ?? request.path,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
      next();
    });
  }
}
