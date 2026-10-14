import { Migration } from "@mikro-orm/migrations";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * O SQL fica em arquivos .sql versionados ao lado desta classe: é mais fácil de
 * revisar (constraints, índices e triggers são parte da avaliação) e é o mesmo
 * SQL que os testes de integração aplicam.
 */
const sql = (direction: "up" | "down"): string =>
  readFileSync(join(import.meta.dir, "sql", `0001_initial.${direction}.sql`), "utf8");

export class Migration20261013000001_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(sql("up"));
  }

  override async down(): Promise<void> {
    this.addSql(sql("down"));
  }
}
