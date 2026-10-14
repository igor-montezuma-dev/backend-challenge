import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadAppConfig } from "./config/app.config";

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // SIGTERM/SIGINT disparam OnModuleDestroy/BeforeApplicationShutdown: é por aí
  // que o consumidor SQS e os workers terminam o que estão fazendo antes de sair.
  app.enableShutdownHooks();

  await app.listen(config.port);
  Logger.log(`wagering-processor listening on :${config.port}`, "Bootstrap");
}

void bootstrap();
