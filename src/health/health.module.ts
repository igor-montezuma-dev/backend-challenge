import { MikroORM } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { ReadinessService } from "./readiness.service";

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: ReadinessService,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new ReadinessService(orm),
    },
  ],
})
export class HealthModule {}
