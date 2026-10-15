import { Migration } from "@mikro-orm/migrations";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type MigrationClass = new (...args: ConstructorParameters<typeof Migration>) => Migration;

export const SQL_MIGRATIONS_DIR = join(import.meta.dir, "sql");

export const MIGRATION_FILES = ["0001_initial", "0002_outbox_position", "0003_deferrable_foreign_keys"] as const;

export function readMigrationSql(file: string, direction: "up" | "down"): string {
  return readFileSync(join(SQL_MIGRATIONS_DIR, `${file}.${direction}.sql`), "utf8");
}

function sqlMigration(file: string): MigrationClass {
  return class extends Migration {
    override async up(): Promise<void> {
      this.addSql(readMigrationSql(file, "up"));
    }

    override async down(): Promise<void> {
      this.addSql(readMigrationSql(file, "down"));
    }
  };
}

export const MIGRATIONS = [
  { name: "Migration20261013000001_initial", class: sqlMigration("0001_initial") },
  { name: "Migration20261014000002_outbox_position", class: sqlMigration("0002_outbox_position") },
  { name: "Migration20261014000003_deferrable_foreign_keys", class: sqlMigration("0003_deferrable_foreign_keys") },
];
