import { Gauge, type Registry } from "prom-client";

const SAMPLE_TIMEOUT_MS = 2_000;

export interface SampledGaugeDefinition<Label extends string> {
  name: string;
  help: string;
  labelNames?: readonly Label[];
  sample(): Promise<ReadonlyArray<{ labels?: Partial<Record<Label, string>>; value: number }>>;
}

export function sampledGauge<Label extends string>(registry: Registry, definition: SampledGaugeDefinition<Label>): Gauge<Label> {
  return new Gauge<Label>({
    name: definition.name,
    help: definition.help,
    labelNames: definition.labelNames ?? [],
    registers: [registry],
    async collect() {
      try {
        for (const { labels, value } of await withTimeout(definition.sample(), SAMPLE_TIMEOUT_MS)) {
          if (labels) this.set(labels as Partial<Record<Label, string>>, value);
          else this.set(value);
        }
      } catch {
        this.reset();
      }
    },
  });
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`metric sample exceeded ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export const seconds = (ms: number): number => ms / 1_000;

export const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/.test(code) ? code : "UNEXPECTED";
};
