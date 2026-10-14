import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { ReadinessService, type ReadinessReport } from "./readiness.service";

@Public() // health fica aberto (seção 2 do desafio)
@Controller("health")
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Processo vivo. Não toca em dependências: se travar aqui, reinicie o pod. */
  @Get("live")
  @HttpCode(HttpStatus.OK)
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** PostgreSQL e SQS alcançáveis. 503 tira a instância do balanceamento. */
  @Get("ready")
  async ready(): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    if (report.status !== "ok") throw new ServiceUnavailableException(report);
    return report;
  }
}
