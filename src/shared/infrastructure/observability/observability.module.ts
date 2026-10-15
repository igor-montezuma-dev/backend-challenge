import { Global, type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../../config/app.config";
import { DIAGNOSTIC_CONTEXT } from "../../application/diagnostic-context";
import { AsyncDiagnosticContext } from "./async-diagnostic-context";
import { MetricsController } from "./metrics.controller";
import { METRICS_REGISTRY, createMetricsRegistry } from "./metrics-registry";
import { RequestLoggingMiddleware } from "./request-logging.middleware";

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: DIAGNOSTIC_CONTEXT, useClass: AsyncDiagnosticContext },
    {
      provide: METRICS_REGISTRY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createMetricsRegistry({ instance: config.instanceId }),
    },
    RequestLoggingMiddleware,
  ],
  exports: [DIAGNOSTIC_CONTEXT, METRICS_REGISTRY],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggingMiddleware).forRoutes("*");
  }
}
