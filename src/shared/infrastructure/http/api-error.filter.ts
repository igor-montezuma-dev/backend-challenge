import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TransientInfrastructureError,
} from "../../application/errors";
import { DomainError, InvalidStateTransitionError, ValidationError } from "../../domain/domain-error";
import { isTransientDatabaseError } from "../database/database-errors";

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("ApiErrorFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body, retryAfter } = this.map(exception);

    if (status >= 500 && status !== HttpStatus.SERVICE_UNAVAILABLE) {
      this.logger.error({ msg: "unhandled error", error: describe(exception) });
    }
    if (retryAfter !== undefined) response.setHeader("Retry-After", String(retryAfter));
    response.status(status).json({ error: body });
  }

  private map(exception: unknown): {
    status: number;
    body: { code: string; message: string; field?: string; retryable: boolean };
    retryAfter?: number;
  } {
    if (exception instanceof ValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          code: exception.code,
          message: exception.message,
          ...(exception.field !== undefined ? { field: exception.field } : {}),
          retryable: false,
        },
      };
    }
    if (exception instanceof NotFoundError) {
      return { status: HttpStatus.NOT_FOUND, body: { code: exception.code, message: exception.message, retryable: false } };
    }
    if (exception instanceof ForbiddenError) {
      return { status: HttpStatus.FORBIDDEN, body: { code: exception.code, message: exception.message, retryable: false } };
    }
    if (exception instanceof ConflictError) {
      return { status: HttpStatus.CONFLICT, body: { code: exception.code, message: exception.message, retryable: false } };
    }
    if (exception instanceof TransientInfrastructureError || isTransientDatabaseError(exception)) {
      const retryAfter = exception instanceof TransientInfrastructureError ? exception.retryAfterSeconds : 1;
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { code: "TRANSIENT_INFRASTRUCTURE_ERROR", message: "temporarily unavailable, retry the same request", retryable: true },
        retryAfter,
      };
    }
    if (exception instanceof InvalidStateTransitionError) {
      return internal();
    }
    if (exception instanceof DomainError) {
      return { status: HttpStatus.BAD_REQUEST, body: { code: exception.code, message: exception.message, retryable: false } };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: {
          code: status === HttpStatus.BAD_REQUEST ? "MALFORMED_REQUEST" : HttpStatus[status] ?? "HTTP_ERROR",
          message: exception.message,
          retryable: status >= 500,
        },
      };
    }
    return internal();
  }
}

function internal() {
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: "INTERNAL_ERROR", message: "unexpected error", retryable: false },
  };
}

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { value: String(error) };
}
