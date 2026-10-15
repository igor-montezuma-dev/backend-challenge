import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { ProviderAuthGuard } from "./auth/provider-auth.guard";
import { ConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { MessagingModule } from "./modules/messaging/messaging.module";
import { WageringModule } from "./modules/wagering/wagering.module";
import { DatabaseModule } from "./shared/infrastructure/database/database.module";
import { ApiErrorFilter } from "./shared/infrastructure/http/api-error.filter";
import { ObservabilityModule } from "./shared/infrastructure/observability/observability.module";
import { SharedModule } from "./shared/infrastructure/shared.module";

@Module({
  imports: [ConfigModule, SharedModule, ObservabilityModule, DatabaseModule, AuthModule, MessagingModule, HealthModule, WageringModule],
  providers: [
    { provide: APP_GUARD, useClass: ProviderAuthGuard },
    { provide: APP_FILTER, useClass: ApiErrorFilter },
  ],
})
export class AppModule {}
