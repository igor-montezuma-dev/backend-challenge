import { defineConfig, type Options } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { Migration20261013000001_initial } from "./migrations/Migration20261013000001_initial";
import { Migration20261014000002_outbox_position } from "./migrations/Migration20261014000002_outbox_position";
import { ENTITY_SCHEMAS } from "./records";

/**
 * Usado pelo DatabaseModule (runtime) e pelo CLI do MikroORM (migrations).
 */
export function buildMikroOrmConfig(url: string, poolMax = 20): Options {
  return defineConfig({
    clientUrl: url,
    entities: ENTITY_SCHEMAS,
    // Sem global context: todo acesso passa por um fork explícito (UnitOfWork).
    allowGlobalContext: false,
    // timestamptz chega como Date em UTC; nada de fuso implícito.
    forceUtcTimezone: true,
    extensions: [Migrator],
    // Nada de schema automático: o schema é só o das migrations versionadas.
    ensureDatabase: false,
    migrations: {
      // Lista explícita: funciona igual com Bun, sem depender de glob em runtime.
      migrationsList: [
        { name: "Migration20261013000001_initial", class: Migration20261013000001_initial },
        { name: "Migration20261014000002_outbox_position", class: Migration20261014000002_outbox_position },
      ],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    pool: { min: 2, max: poolMax },
  });
}

// Export default exigido pelo CLI do MikroORM (`bun run migration:up`).
export default buildMikroOrmConfig(
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wagering",
  Number(process.env.DATABASE_POOL_MAX ?? 20),
);
