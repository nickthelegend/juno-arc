/** DB-only registration of an existing mainnet launch; the API verifies receipt and pool. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const base=process.env.HOSTED_API_URL||'https://juno-arc-api.vercel.app';
const config=await fetch(base+'/api/juno/config').then(r=>r.json());assert.equal(config.chainId,5042);
const body=JSON.parse(readFileSync(new URL('../docs/proof/mainnet-video-pool.json',import.meta.url)));
const r=await fetch(base+'/api/juno/pools',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
assert(r.ok,await r.text());
const feed=await fetch(base+'/api/juno/pools',{cache:'no-store'}).then(r=>r.json());
assert(feed.pools.some(p=>p.token.toLowerCase()===body.token.toLowerCase()&&p.createTx===body.createTx));
console.log('PASS: existing mainnet video launch verified by API, registered, and read back in hosted feed');
