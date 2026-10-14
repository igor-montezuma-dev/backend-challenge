import { Injectable } from "@nestjs/common";
import type { ProviderIdentity, ProviderIdentityPort } from "./provider-identity.port";

/**
 * Adapter no-op: aceita qualquer requisição como "anônima".
 *
 * Com autenticação real, o use case passaria a exigir que o providerId do
 * payload seja igual ao providerId do token. Hoje essa checagem não existe —
 * limitação documentada no ARCHITECTURE.md.
 */
@Injectable()
export class AllowAllProviderIdentityAdapter implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity | undefined> {
    return { providerId: "anonymous" };
  }
}
