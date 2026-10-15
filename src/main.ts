import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadAppConfig } from "./config/app.config";
import { setupOpenApi } from "./shared/infrastructure/http/openapi/setup-openapi";
import { JsonLogger } from "./shared/infrastructure/observability/json-logger";

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger(config.logLevel) });

  app.enableShutdownHooks();
  setupOpenApi(app);

  await app.listen(config.port);
  Logger.log(`wagering-processor listening on :${config.port} — docs at /docs`, "Bootstrap");
}

void bootstrap();
