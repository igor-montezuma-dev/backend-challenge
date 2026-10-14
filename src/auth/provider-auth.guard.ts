import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC } from "./public.decorator";
import { PROVIDER_IDENTITY_PORT, type ProviderIdentityPort } from "./provider-identity.port";

/**
 * Guard global. Hoje delega para o adapter no-op; trocar o adapter liga a
 * autenticação sem mexer em controllers nem em casos de uso.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY_PORT) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      providerIdentity?: unknown;
    }>();
    const identity = await this.identity.resolve(request.headers);
    if (!identity) throw new UnauthorizedException();
    request.providerIdentity = identity;
    return true;
  }
}
