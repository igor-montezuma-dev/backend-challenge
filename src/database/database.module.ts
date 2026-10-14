import { MikroOrmModule } from "@mikro-orm/nestjs";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { buildMikroOrmConfig } from "./mikro-orm.config";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      // Com useFactory + inject, o @mikro-orm/nestjs precisa saber o driver
      // para registrar os tipos específicos (EntityManager do PostgreSQL).
      driver: PostgreSqlDriver,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...buildMikroOrmConfig(config.database.url, config.database.poolMax),
        // Sem RequestContext global: cada caso de uso abre seu próprio
        // em.transactional() com um EntityManager isolado (fork). Isso vale
        // igual para HTTP, consumidor SQS e workers.
        registerRequestContext: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
