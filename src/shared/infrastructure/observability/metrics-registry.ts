import { Registry, collectDefaultMetrics } from "prom-client";

export const METRICS_REGISTRY = Symbol("METRICS_REGISTRY");

export function createMetricsRegistry(labels: Record<string, string>): Registry {
  const registry = new Registry();
  registry.setDefaultLabels(labels);
  collectDefaultMetrics({ register: registry, prefix: "wagering_" });
  return registry;
}
