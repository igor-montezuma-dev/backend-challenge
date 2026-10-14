import { MikroORM } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";

export type DependencyStatus = { status: "up" } | { status: "down"; error: string };

export interface ReadinessReport {
  status: "ok" | "unavailable";
  checks: Record<string, DependencyStatus>;
}

/**
 * Porta para checagens de dependências externas. O SQS registra a sua
 * implementação quando o MessagingModule entrar (Etapa 5).
 */
export interface DependencyProbe {
  readonly name: string;
  ping(): Promise<void>;
}

export const DEPENDENCY_PROBES = Symbol("DEPENDENCY_PROBES");

const TIMEOUT_MS = 2_000;

@Injectable()
export class ReadinessService {
  private readonly probes: DependencyProbe[];

  constructor(orm: MikroORM, extraProbes: DependencyProbe[] = []) {
    this.probes = [
      {
        name: "postgres",
        ping: async () => {
          await orm.em.getConnection().execute("select 1");
        },
      },
      ...extraProbes,
    ];
  }

  async check(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      this.probes.map(async (probe): Promise<[string, DependencyStatus]> => {
        try {
          await withTimeout(probe.ping(), TIMEOUT_MS);
          return [probe.name, { status: "up" }];
        } catch (error) {
          return [probe.name, { status: "down", error: (error as Error).message }];
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    const allUp = entries.every(([, s]) => s.status === "up");
    return { status: allUp ? "ok" : "unavailable", checks };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}
