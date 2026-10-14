import { type EntityProperty, type Platform, Type } from "@mikro-orm/core";

/**
 * numeric(19,2) <-> string decimal ("25.00"), sem passar por `number` em
 * nenhum momento. O driver pg já devolve numeric como string; este tipo torna
 * isso explícito e recusa qualquer valor que não seja string decimal — se
 * algum código tentar gravar um `number`, falha alto em vez de arredondar.
 *
 * A conversão string <-> Money acontece nos mappers (camada de persistência),
 * mantendo o domínio livre de tipos do ORM.
 */
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
