import { Global, Module } from "@nestjs/common";
import { AllowAllProviderIdentityAdapter } from "./allow-all-provider-identity.adapter";
import { PROVIDER_IDENTITY_PORT } from "./provider-identity.port";

@Global()
@Module({
  providers: [{ provide: PROVIDER_IDENTITY_PORT, useClass: AllowAllProviderIdentityAdapter }],
  exports: [PROVIDER_IDENTITY_PORT],
})
export class AuthModule {}
