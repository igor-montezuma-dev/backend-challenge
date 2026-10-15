import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { uuidv7 } from "../uuid-v7.generator";

export const CORRELATION_HEADER = "x-correlation-id";
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CORRELATION = Symbol("correlationId");

type CorrelatedRequest = Request & { [CORRELATION]?: string };

export function correlationIdOf(request: Request): string {
  const correlated = request as CorrelatedRequest;
  if (correlated[CORRELATION]) return correlated[CORRELATION];
  const incoming = request.header(CORRELATION_HEADER);
  correlated[CORRELATION] = incoming && SAFE_ID.test(incoming) ? incoming : uuidv7();
  return correlated[CORRELATION];
}

export const CorrelationId = createParamDecorator((_: unknown, ctx: ExecutionContext): string =>
  correlationIdOf(ctx.switchToHttp().getRequest<Request>()),
);
