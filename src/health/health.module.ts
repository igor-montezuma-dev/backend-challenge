import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/app.config";
import { SQS_CLIENT, pingQueue } from "../modules/messaging/infrastructure/sqs/sqs-client.factory";
import { HealthController } from "./health.controller";
import { ReadinessService } from "./readiness.service";

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: ReadinessService,
      inject: [MikroORM, SQS_CLIENT, APP_CONFIG],
      useFactory: (orm: MikroORM, sqs: SQSClient, config: AppConfig) =>
        new ReadinessService([
          { name: "postgres", ping: async () => void (await orm.em.getConnection().execute("select 1")) },
          { name: "sqs", ping: () => pingQueue(sqs, config.sqs.wagerQueueUrl) },
        ]),
    },
  ],
})
export class HealthModule {}
