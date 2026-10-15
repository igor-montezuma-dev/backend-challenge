import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { BackgroundWorker } from "../application/background-worker";

export type { BackgroundWorker };

export class ManagedWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger: Logger;

  constructor(
    private readonly name: string,
    private readonly worker: BackgroundWorker,
    private readonly enabled: boolean,
  ) {
    this.logger = new Logger(name);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log(`${this.name} disabled`);
      return;
    }
    this.worker.start();
    this.logger.log(`${this.name} started`);
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (!this.enabled) return;
    this.logger.log(`${this.name} stopping (${signal ?? "shutdown"})`);
    await this.worker.stop();
    this.logger.log(`${this.name} stopped`);
  }
}
