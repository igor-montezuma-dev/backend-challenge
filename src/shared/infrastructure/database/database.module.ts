import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../../config/app.config";
import { buildMikroOrmConfig } from "./mikro-orm.config";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...buildMikroOrmConfig(config.database),
        autoLoadEntities: true,
        registerRequestContext: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
