import { AsyncLocalStorage } from "node:async_hooks";
import type { DiagnosticContext, DiagnosticFields } from "../../application/diagnostic-context";

type MutableFields = Record<string, string | number | undefined>;

const storage = new AsyncLocalStorage<MutableFields>();

export const currentDiagnosticFields = (): DiagnosticFields => storage.getStore() ?? {};

export class AsyncDiagnosticContext implements DiagnosticContext {
  run<T>(fields: DiagnosticFields, work: () => Promise<T>): Promise<T> {
    return storage.run({ ...storage.getStore(), ...definedOnly(fields) }, work);
  }

  runSync<T>(fields: DiagnosticFields, work: () => T): T {
    return storage.run({ ...storage.getStore(), ...definedOnly(fields) }, work);
  }

  annotate(fields: DiagnosticFields): void {
    const store = storage.getStore();
    if (store) Object.assign(store, definedOnly(fields));
  }
}

function definedOnly(fields: DiagnosticFields): MutableFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
