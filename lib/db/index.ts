import { drizzle } from "drizzle-orm/node-postgres";
import { drizzle as proxy } from "drizzle-orm/pg-proxy";
import { atlasSql } from "./atlas-sql";
import * as schema from "./schema";
import { getPgPool } from "./pool";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!_db) {
    _db = process.env.DATABASE_URL ? drizzle(getPgPool(), { schema }) : proxy(atlasSql, { schema }) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  }
  return _db;
}

export type Db = ReturnType<typeof getDb>;
