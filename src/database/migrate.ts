/**
 * Runner de migrations executado pelo Bun.
 *
 *   bun run migration:up      aplica as pendentes
 *   bun run migration:down    reverte a última
 *   bun run migration:list    lista aplicadas e pendentes
 *
 * Usamos o Migrator do MikroORM programaticamente em vez do CLI `mikro-orm`:
 * o CLI roda em Node e não carrega a config em TypeScript sem ts-node, e assim
 * o projeto inteiro (app, testes e migrations) roda no mesmo runtime.
 */
import { MikroORM } from "@mikro-orm/postgresql";
import config from "./mikro-orm.config";

type Command = "up" | "down" | "list";

async function main(command: Command): Promise<void> {
  const orm = await MikroORM.init(config);
  try {
    const migrator = orm.getMigrator();
    switch (command) {
      case "up": {
        const applied = await migrator.up();
        console.log(applied.length ? `applied: ${applied.map((m) => m.name).join(", ")}` : "nothing to apply");
        break;
      }
      case "down": {
        const reverted = await migrator.down();
        console.log(reverted.length ? `reverted: ${reverted.map((m) => m.name).join(", ")}` : "nothing to revert");
        break;
      }
      case "list": {
        const executed = await migrator.getExecutedMigrations();
        const pending = await migrator.getPendingMigrations();
        for (const m of executed) console.log(`[x] ${m.name}`);
        for (const m of pending) console.log(`[ ] ${m.name}`);
        break;
      }
    }
  } finally {
    await orm.close(true);
  }
}

const command = (process.argv[2] ?? "up") as Command;
if (!["up", "down", "list"].includes(command)) {
  console.error(`unknown command "${command}" (use up | down | list)`);
  process.exit(1);
}

main(command).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
