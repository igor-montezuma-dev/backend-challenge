export interface BackgroundWorker {
  start(): void;
  stop(): Promise<void>;
}

export interface PollingLoopOptions {
  intervalMs: number;
  onError(error: unknown): void;
}

export class PollingLoop implements BackgroundWorker {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly tick: () => Promise<boolean>,
    private readonly options: PollingLoopOptions,
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let didWork = false;
      try {
        didWork = await this.tick();
      } catch (error) {
        this.options.onError(error);
      }
      if (!didWork && !this.stopping) await this.idle();
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.options.intervalMs);
      this.wake = done;
    });
  }
}
