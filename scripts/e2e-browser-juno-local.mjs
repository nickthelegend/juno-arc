#!/usr/bin/env node
// One command: node scripts/e2e-browser-juno-local.mjs
// Uses the existing testnet .env.local, .next build and Expo dist export.
// Reuses listeners; starts missing local services only, stops its own PIDs.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createReadStream, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
process.loadEnvFile('.env.local');
const run=resolve('.juno/browser-services');mkdirSync(run,{recursive:true});
process.env.TMPDIR=run;
const children=[];let server;
const listening=port=>new Promise(r=>{const s=createConnection({host:'127.0.0.1',port});s.once('connect',()=>{s.destroy();r(true)});s.once('error',()=>r(false));});
async function start(name,args,port){
  if(await listening(port))return;
  const log=openSync(resolve(run,name+'.log'),'a');
  const child=spawn(args[0],args.slice(1),{env:process.env,stdio:['ignore',log,log]});children.push(child);
  for(let i=0;i<60;i++){if(await listening(port))return;if(child.exitCode!==null)throw new Error(name+' exited; see '+run);await new Promise(r=>setTimeout(r,500));}
  throw new Error(name+' did not start');
}
function cleanup(){server?.close();for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');}
process.on('SIGINT',()=>{cleanup();process.exit(130)});process.on('SIGTERM',()=>{cleanup();process.exit(143)});
try{
  // A local mainnet fork supplies feed reads; the application/transactions stay on testnet.
  process.env.ARC_MAINNET_RPC_URL='http://127.0.0.1:8910';
  process.env.ARC_RPC_URL='https://rpc.testnet.arc.io';
  process.env.NEXT_PUBLIC_ARC_RPC_URL='https://rpc.testnet.arc.io';
  process.env.NEXT_PUBLIC_ARC_NETWORK='testnet';
  process.env.JUNO_DEPLOYMENT_FILE='deployments/arc-testnet.json';
  process.env.JUNO_API_URL='http://127.0.0.1:8911';
  process.env.JUNO_MEDIA_BACKEND='mongo';
  if(process.argv.includes('--flow'))process.env.FAUCET_AMOUNT_USDC='0.5';
  if(!await listening(8910))await start('feeds',[resolve('../.tools/arcfoundry/anvil'),'--network','arc','--fork-url','https://rpc.mainnet.arc.io','--port','8910','--silent'],8910);
  if(new URL(process.env.MONGODB_URI).hostname==='127.0.0.1'){
    mkdirSync(resolve('.juno/testnet/mongo'),{recursive:true});
    await start('mongo',['mongod','--dbpath',resolve('.juno/testnet/mongo'),'--port','8913','--bind_ip','127.0.0.1'],8913);
  }
  await start('api',[process.execPath,'node_modules/next/dist/bin/next','start','-p','8911'],8911);
  if(!await listening(8912)){
    const root=resolve('juno-expo/dist');if(!existsSync(root+'/index.html'))throw new Error('Run the Expo web export first');
    server=createServer((q,s)=>{let f=resolve(root,'.'+decodeURIComponent(new URL(q.url,'http://localhost').pathname));if(!f.startsWith(root+sep)||!existsSync(f)||statSync(f).isDirectory())f=root+'/index.html';s.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.png':'image/png','.svg':'image/svg+xml','.ttf':'font/ttf','.css':'text/css'})[extname(f)]||'application/octet-stream');createReadStream(f).pipe(s);});await new Promise(r=>server.listen(8912,'127.0.0.1',r));
  }
  const test=spawn(process.execPath,['scripts/e2e-browser-juno.mjs',...process.argv.slice(2)],{env:process.env,stdio:'inherit'});children.push(test);
  process.exitCode=await new Promise(r=>test.on('exit',code=>r(code??1)));
}finally{cleanup();}
