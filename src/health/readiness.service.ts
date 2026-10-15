export type DependencyStatus = { status: "up" } | { status: "down"; error: string };

export interface ReadinessReport {
  status: "ok" | "unavailable";
  checks: Record<string, DependencyStatus>;
}

export interface DependencyProbe {
  readonly name: string;
  ping(): Promise<void>;
}

const PROBE_TIMEOUT_MS = 2_000;

export class ReadinessService {
  constructor(private readonly probes: readonly DependencyProbe[]) {}

  async check(): Promise<ReadinessReport> {
    const entries = await Promise.all(this.probes.map((probe) => this.probe(probe)));
    return {
      status: entries.every(([, result]) => result.status === "up") ? "ok" : "unavailable",
      checks: Object.fromEntries(entries),
    };
  }

  private async probe(probe: DependencyProbe): Promise<[string, DependencyStatus]> {
    try {
      await withTimeout(probe.ping(), PROBE_TIMEOUT_MS);
      return [probe.name, { status: "up" }];
    } catch (error) {
      return [probe.name, { status: "down", error: error instanceof Error ? error.message : String(error) }];
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
