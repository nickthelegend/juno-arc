#!/usr/bin/env node
// Restore four already-launched, receipt-verified testnet markets into a new DB.
// No keys, funding, minting, fake trades, or blockchain writes. Media is labelled demo content.
// JUNO_API_URL=https://<api> node scripts/seed-testnet-feed.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const base=process.env.JUNO_API_URL||'http://127.0.0.1:8911';
const config=await (await fetch(base+'/api/juno/config')).json();assert.equal(config.chainId,5042002);assert.equal(config.localFork,false);
const rows=JSON.parse(readFileSync(new URL('./fixtures/testnet-launches.json',import.meta.url)));
for(const row of rows){
  const file=new URL('./fixtures/'+row.file,import.meta.url);const form=new FormData();form.set('file',new Blob([readFileSync(file)],{type:row.mediaMime}),row.file);
  const r=await fetch(base+'/api/juno/upload',{method:'POST',body:form});assert.equal(r.status,201,'Upload failed');const media=await r.json();
  const p=await fetch(base+'/api/juno/pools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...row,mediaUrl:media.uri,posterUrl:media.posterUri||media.uri,mediaWidth:media.width,mediaHeight:media.height})});
  assert.equal(p.status,201,'Receipt-verified listing failed');console.log('Listed real Arc testnet market',row.symbol,row.token);
}
