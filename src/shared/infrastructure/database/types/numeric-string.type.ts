import { type EntityProperty, type Platform, Type } from "@mikro-orm/core";

export class NumericStringType extends Type<string, string> {
  private static readonly PATTERN = /^-?\d{1,17}\.\d{2}$/;

  override convertToDatabaseValue(value: string | null | undefined): string {
    if (value === null || value === undefined) return value as unknown as string;
    if (typeof value !== "string" || !NumericStringType.PATTERN.test(value)) {
      throw new TypeError(`numeric(19,2) column only accepts decimal strings like "25.00", got ${typeof value}`);
    }
    return value;
  }

  override convertToJSValue(value: string | null | undefined): string {
    if (value === null || value === undefined) return value as unknown as string;
    if (typeof value !== "string") {
      throw new TypeError(`expected numeric(19,2) from the driver as string, got ${typeof value}`);
    }
    return value;
  }

  override compareAsType(): string {
    return "string";
  }

  override getColumnType(_prop: EntityProperty, _platform: Platform): string {
    return "numeric(19,2)";
  }
}
