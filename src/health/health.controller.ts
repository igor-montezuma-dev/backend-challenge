import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../auth/public.decorator";
import { ReadinessService, type ReadinessReport } from "./readiness.service";

@ApiTags("health")
@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get("live")
  @ApiOperation({ summary: "Liveness: processo vivo (não toca dependências)" })
  @HttpCode(HttpStatus.OK)
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOperation({ summary: "Readiness: PostgreSQL e SQS alcançáveis (503 se não)" })
  async ready(): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    if (report.status !== "ok") throw new ServiceUnavailableException(report);
    return report;
  }
}
