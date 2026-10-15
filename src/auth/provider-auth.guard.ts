import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";
import { type AuthenticatedRequest, attachIdentity } from "./current-provider.decorator";
import { IS_PUBLIC } from "./public.decorator";
import { PROVIDER_IDENTITY_PORT, type ProviderIdentityPort } from "./provider-identity.port";

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY_PORT) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const identity = await this.identity.resolve(request.headers);
    if (!identity) {
      http.getResponse<Response>().setHeader("WWW-Authenticate", 'Bearer realm="wagering-processor"');
      throw new UnauthorizedException("a valid bearer token is required");
    }
    attachIdentity(request, identity);
    return true;
  }
}
