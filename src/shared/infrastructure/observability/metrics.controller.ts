import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Registry } from "prom-client";
import { Public } from "../../../auth/public.decorator";
import { METRICS_REGISTRY } from "./metrics-registry";

@ApiExcludeController()
@Public()
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @Header("Cache-Control", "no-store")
  async scrape(@Res() response: Response): Promise<void> {
    const body = await this.registry.metrics();
    response.type(this.registry.contentType).send(body);
  }
}
