import type { ProviderIdentity, ProviderIdentityPort } from "./provider-identity.port";

const ANONYMOUS: ProviderIdentity = Object.freeze({ kind: "anonymous" });

export class AllowAllProviderIdentityAdapter implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity> {
    return ANONYMOUS;
  }
}
