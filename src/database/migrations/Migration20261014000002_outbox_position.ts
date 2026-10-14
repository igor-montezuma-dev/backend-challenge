import { Migration } from "@mikro-orm/migrations";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = (direction: "up" | "down"): string =>
  readFileSync(join(import.meta.dir, "sql", `0002_outbox_position.${direction}.sql`), "utf8");

export class Migration20261014000002_outbox_position extends Migration {
  override async up(): Promise<void> {
    this.addSql(sql("up"));
  }

  override async down(): Promise<void> {
    this.addSql(sql("down"));
  }
}
