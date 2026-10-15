import { ValidationError } from "./domain-error";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Guard = {
  object(value: unknown, field = "payload"): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidationError(`${field} must be a JSON object`, field === "payload" ? undefined : field);
    }
    return value as Record<string, unknown>;
  },

  knownFields(value: Record<string, unknown>, allowed: readonly string[], scope?: string): Record<string, unknown> {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown !== undefined) {
      const field = scope === undefined ? unknown : `${scope}.${unknown}`;
      throw new ValidationError(`unknown field "${field}"; accepted fields: ${allowed.join(", ")}`, field);
    }
    return value;
  },

  text(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
      throw new ValidationError(`${field} must be a non-empty string up to ${maxLength} characters`, field);
    }
    return value;
  },

  optionalText(value: unknown, field: string, maxLength: number): string | undefined {
    return value === undefined || value === null ? undefined : Guard.text(value, field, maxLength);
  },

  uuid(value: unknown, field: string): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new ValidationError(`${field} must be a UUID`, field);
    }
    return value.toLowerCase();
  },

  oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      throw new ValidationError(`${field} must be one of ${allowed.join(", ")}`, field);
    }
    return value as T;
  },
};
