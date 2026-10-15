import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type EntitySchema, type Options } from "@mikro-orm/postgresql";
import { MIGRATIONS } from "./migrations";

export interface DatabaseOptions {
  url: string;
  poolMax: number;
  entities?: EntitySchema[];
}

export function buildMikroOrmConfig({ url, poolMax, entities = [] }: DatabaseOptions): Options {
  return defineConfig({
    clientUrl: url,
    entities,
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    forceUtcTimezone: true,
    extensions: [Migrator],
    ensureDatabase: false,
    migrations: { migrationsList: MIGRATIONS, transactional: true, allOrNothing: true, snapshot: false },
    pool: { min: 2, max: poolMax },
  });
}
