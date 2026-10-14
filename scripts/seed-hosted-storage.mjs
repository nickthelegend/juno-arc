/** Re-register existing receipt-verified testnet launches in Atlas. Sends no transactions. */
import {readFileSync,copyFileSync,mkdirSync} from 'node:fs';import {parseEnv} from 'node:util';import {spawnSync} from 'node:child_process';
const env=parseEnv(readFileSync('.env.local','utf8'));
mkdirSync('public/demo',{recursive:true});
const rows=JSON.parse(readFileSync('scripts/fixtures/testnet-launches.json','utf8'));
for(const row of rows)copyFileSync('scripts/fixtures/'+row.file,'public/demo/'+row.file);
const script=`
import fs from 'node:fs';import assert from 'node:assert/strict';
import {POST} from './app/api/juno/pools/route.ts';
import {closeAtlasSql} from './lib/db/atlas-sql.ts';
try {for(const row of JSON.parse(fs.readFileSync('scripts/fixtures/testnet-launches.json','utf8'))){
 const media=process.env.JUNO_API_URL+'/demo/'+row.file;
 const r=await POST(new Request(process.env.JUNO_API_URL+'/api/juno/pools',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...row,mediaUrl:media,posterUrl:row.mediaMime.startsWith('image/')?media:null})}));
 if(r.status!==201)throw Error('Listing failed: '+r.status+' '+await r.text());console.log('Verified and indexed',row.symbol);
}}finally{await closeAtlasSql();}
`;
const r=spawnSync(process.execPath,['--conditions=react-server','--import','tsx','--input-type=module','-e',script],{env:{...process.env,...env},stdio:'inherit'});process.exit(r.status??1);
