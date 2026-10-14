/** Small testnet SQL corpus persisted atomically in the existing Atlas database. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Binary, MongoClient } from 'mongodb';
import { PGlite, types } from '@electric-sql/pglite';

type Snapshot = { _id: string; version: number; image: Binary };
let mongo: Promise<MongoClient> | undefined;
let unavailableUntil = 0;
let queue: Promise<unknown> = Promise.resolve();
let cached: { version: number; db: PGlite } | undefined;
async function collection() {
  if (Date.now() < unavailableUntil) throw Error("Atlas storage unavailable");
  const name = process.env.MONGODB_DB;
  if (!process.env.MONGODB_URI || !name?.startsWith('arc_')) throw Error('Atlas SQL requires MONGODB_URI and an arc_ database');
  if (!mongo) {
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 3 });
    mongo = client.connect().catch(async () => { mongo = undefined; unavailableUntil = Date.now() + 10000; await client.close(); throw Error('Atlas storage unavailable'); });
  }
  return (await mongo).db(name).collection<Snapshot>('sql_snapshots');
}
async function open(snapshot: Snapshot | null) {
  if (cached && cached.version === (snapshot?.version ?? -1)) return cached.db;
  if (cached) { await cached.db.close(); cached = undefined; }
  const db = await PGlite.create({
    ...(snapshot ? { loadDataDir: new Blob([new Uint8Array(snapshot.image.buffer)]) } : {}),
    parsers: { [types.TIMESTAMP]: v => v, [types.TIMESTAMPTZ]: v => v, [types.INT8]: v => v },
  });
  if (!snapshot) await db.exec(readFileSync(resolve(process.cwd(), 'drizzle/0000_juno_arc.sql'), 'utf8'));
  cached = {version: snapshot?.version ?? -1, db};
  return db;
}
async function run(sql: string, params: unknown[]) {
  const coll = await collection();
  const read = /^\s*(select|with)\b/i.test(sql);
  for (let attempt = 0; attempt < 12; attempt++) {
    const snapshot = await coll.findOne({_id:'corpus'});
    const db = await open(snapshot);
    let rows: unknown[][];
    if (read) {
      await db.exec('BEGIN READ ONLY');
      try { rows = (await db.query<unknown[]>(sql, params, {rowMode:'array'})).rows; }
      finally { await db.exec('ROLLBACK'); }
    } else {
      rows = (await db.query<unknown[]>(sql, params, {rowMode:'array'})).rows;
    }
    if (read && snapshot) return {rows};
    const blob = await db.dumpDataDir('gzip');
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.length > 12 * 1024 * 1024) { await db.close(); cached = undefined; throw Error('Testnet SQL corpus exceeds 12 MiB; configure managed Postgres'); }
    const version = (snapshot?.version ?? -1) + 1;
    if (!snapshot) {
      try { await coll.insertOne({_id:'corpus',version,image:new Binary(bytes)}); cached!.version=version; return {rows}; }
      catch(error) { if ((error as {code?:number}).code !== 11000) throw error; }
    } else {
      const saved = await coll.updateOne({_id:'corpus',version:snapshot.version},{$set:{version,image:new Binary(bytes)}});
      if(saved.modifiedCount) { cached!.version=version; return {rows}; }
    }
    await db.close(); cached=undefined; // retry against the winning version; never overwrite a concurrent writer
  }
  throw Error('SQL storage contention; retry request');
}
export function atlasSql(sql: string, params: unknown[]) {
  const result = queue.then(() => run(sql, params));
  queue = result.catch(async () => { if(cached){await cached.db.close();cached=undefined;} });
  return result;
}
export async function closeAtlasSql() { await queue; if(cached)await cached.db.close();cached=undefined;if(mongo)await(await mongo).close();mongo=undefined; }
