/** Real isolated Atlas SQL persistence check; drops only its own unique database. */
import fs from 'node:fs';import {parseEnv} from 'node:util';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const e=parseEnv(fs.readFileSync('.env.local','utf8'));
const r=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';
import {atlasSql,closeAtlasSql} from './lib/db/atlas-sql.ts';
import {MongoClient} from 'mongodb';
const name='arc_juno_check_'+Date.now();process.env.MONGODB_DB=name;
try {
 await atlasSql('INSERT INTO juno_log_cursor(id,block) VALUES ($1,0)',['check']);
 await Promise.all(Array.from({length:8},()=>atlasSql('UPDATE juno_log_cursor SET block=block+1 WHERE id=$1',['check'])));
 await closeAtlasSql();
 const result=await atlasSql('SELECT block FROM juno_log_cursor WHERE id=$1',['check']);assert.equal(Number(result.rows[0][0]),8);
 await assert.rejects(atlasSql('WITH changed AS (DELETE FROM juno_log_cursor RETURNING *) SELECT * FROM changed',[]));
 console.log('PASS: persisted SQL, eight concurrent increments, cold reload, read-only protection');
} finally {await closeAtlasSql();const c=await new MongoClient(process.env.MONGODB_URI).connect();await c.db(name).dropDatabase();await c.close();}
`],{env:{...process.env,MONGODB_URI:e.MONGODB_URI},stdio:'inherit'});process.exit(r.status??1);
