// One real Arc testnet launch through the hosted API, bounded to 0.20 USDC.
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { API,post,get,signAndSubmit } from './lib/fork-client.mjs';
const account=privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const cfg=await get('/api/juno/config');if(cfg.chainId!==5042002)throw new Error('Arc testnet required');
const form=new FormData();form.set('file',new Blob([readFileSync('juno-expo/assets/icon.png')],{type:'image/png'}),'juno.png');
const uploaded=await fetch(API+'/api/juno/upload',{method:'POST',body:form});if(!uploaded.ok)throw new Error('Media upload failed');const media=await uploaded.json();
const name='Hosted Arc proof',symbol='HOSTARC',firstBuy=0.01;
const built=await post('/api/juno/tx/launch',{creator:account.address,name,symbol,preset:'content',uri:'',firstBuy});
let max=10000000000000000n;
for(const s of built.steps){if(s.request.chainId!==5042002)throw new Error('Wrong chain');max+=BigInt(s.request.gas)*BigInt(s.request.maxFeePerGas)+BigInt(s.request.value);}
if(max>200000000000000000n)throw new Error('Estimated maximum exceeds 0.20 USDC');
const receipts=await signAndSubmit(account,built.steps);const launch=receipts.at(-1);
const pool=await post('/api/juno/pools',{token:launch.launched.token,createTx:launch.hash,name,symbol,description:'A real launch through the publicly hosted API on Arc testnet. Test tokens, no real-money claim.',format:'post',curvePreset:'content',mediaUrl:media.url,mediaMime:media.mimeType,mediaWidth:media.width,mediaHeight:media.height});
mkdirSync('docs/screens/hosted',{recursive:true});const proof={checkedAt:new Date().toISOString(),chainId:5042002,maxCostUSDC:Number(max)/1e18,receipts,pool};writeFileSync('docs/screens/hosted/action.json',JSON.stringify(proof,null,2));console.log(JSON.stringify({token:launch.launched.token,hash:launch.hash,maxCostUSDC:proof.maxCostUSDC}));
