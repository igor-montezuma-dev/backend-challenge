import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { ProviderAuthGuard } from "./auth/provider-auth.guard";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";

/**
 * Módulos de negócio entram nas próximas etapas:
 *   - WalletsModule   (POST /wallets, consultas, ledger, reconciliação)
 *   - WageringModule  (POST /wagering/transactions e consultas)
 *   - MessagingModule (consumidor SQS + inbox, publisher da outbox)
 */
@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule, HealthModule],
  providers: [{ provide: APP_GUARD, useClass: ProviderAuthGuard }],
})
export class AppModule {}
