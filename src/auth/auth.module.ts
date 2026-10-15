import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { AllowAllProviderIdentityAdapter } from "./allow-all-provider-identity.adapter";
import { JwtProviderIdentityAdapter } from "./jwt-provider-identity.adapter";
import { PROVIDER_IDENTITY_PORT, type ProviderIdentityPort } from "./provider-identity.port";

@Global()
@Module({
  providers: [
    {
      provide: PROVIDER_IDENTITY_PORT,
      inject: [APP_CONFIG],
      useFactory: ({ auth }: AppConfig): ProviderIdentityPort =>
        auth.mode === "jwt" ? new JwtProviderIdentityAdapter(auth) : new AllowAllProviderIdentityAdapter(),
    },
  ],
  exports: [PROVIDER_IDENTITY_PORT],
})
export class AuthModule {}
