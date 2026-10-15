export type DiagnosticFields = Readonly<Record<string, string | number | undefined>>;

export interface DiagnosticContext {
  run<T>(fields: DiagnosticFields, work: () => Promise<T>): Promise<T>;
  annotate(fields: DiagnosticFields): void;
}

export const DIAGNOSTIC_CONTEXT = Symbol("DIAGNOSTIC_CONTEXT");

export const NO_DIAGNOSTIC_CONTEXT: DiagnosticContext = {
  run: (_fields, work) => work(),
  annotate: () => {},
};
