import { NumericStringType } from "./types/numeric-string.type";

export const Columns = {
  timestamptz: { type: "Date", columnType: "timestamptz" },
  nullableTimestamptz: { type: "Date", columnType: "timestamptz", nullable: true },
  money: { type: NumericStringType, columnType: "numeric(19,2)" },
  nullableMoney: { type: NumericStringType, columnType: "numeric(19,2)", nullable: true },
  currency: { type: "string", columnType: "char(3)" },
  sha256: { type: "string", columnType: "char(64)" },
} as const;

export const nullToUndefined = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);
