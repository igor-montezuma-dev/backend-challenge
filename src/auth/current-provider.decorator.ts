import { type ExecutionContext, createParamDecorator } from "@nestjs/common";
import type { Request } from "express";
import type { ProviderIdentity } from "./provider-identity.port";

const IDENTITY = Symbol("providerIdentity");

export type AuthenticatedRequest = Request & { [IDENTITY]?: ProviderIdentity };

export function attachIdentity(request: AuthenticatedRequest, identity: ProviderIdentity): void {
  request[IDENTITY] = identity;
}

export function authenticatedProviderOf(request: AuthenticatedRequest): string | undefined {
  const identity = request[IDENTITY];
  return identity?.kind === "provider" ? identity.providerId : undefined;
}

export const CurrentProvider = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined =>
  authenticatedProviderOf(ctx.switchToHttp().getRequest<AuthenticatedRequest>()),
);
