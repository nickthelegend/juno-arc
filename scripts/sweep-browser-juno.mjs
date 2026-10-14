#!/usr/bin/env node
// JUNO_BROWSER_WRITE=1 node scripts/sweep-browser-juno.mjs [--top-up-faucet]
// Sweep the saved browser test wallet to the shared deployer. Never prints keys.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,rmdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createPublicClient,createWalletClient,http,parseEther,formatEther,defineChain} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
assert.equal(process.env.JUNO_BROWSER_WRITE,'1');
const file=resolve('.juno/browser-'+(process.env.JUNO_BROWSER_RUN||'round2')+'/state.json');
const state=JSON.parse(readFileSync(file));
const save=()=>writeFileSync(file,JSON.stringify(state,null,2),{mode:0o600});
const chain=defineChain({id:5042002,name:'Arc testnet',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:['https://rpc.testnet.arc.io']}}});
const transport=http('https://rpc.testnet.arc.io');
const rpc=createPublicClient({chain,transport});assert.equal(await rpc.getChainId(),5042002);
const recipient='0x0648aDF1967692A0c991d7715b0b588452321FBd';
async function send(account,to,value){
  const gasPrice=await rpc.getGasPrice();assert.ok(gasPrice*21000n<parseEther('0.01'));
  const client=createWalletClient({account,chain,transport});
  const hash=await client.sendTransaction({to,value,gas:21000n,maxFeePerGas:gasPrice,maxPriorityFeePerGas:0n});
  assert.equal((await rpc.waitForTransactionReceipt({hash})).status,'success');return hash;
}
if(process.argv.includes('--top-up-faucet')&&!state.reserveFunding){
  assert.ok(state.funding.amountUSDC+0.2<=0.8);
  const line=readFileSync('../.deployer/deployer.env','utf8').split('\n').find(l=>l.startsWith('DEPLOYER_PRIVATE_KEY='));
  const raw=line.slice(line.indexOf('=')+1).trim().replace(/^["']|["']$/g,'');
  const account=privateKeyToAccount(raw.startsWith('0x')?raw:'0x'+raw);assert.equal(account.address,recipient);
  const lock=resolve('../.deployer/lock');
  while(true){try{mkdirSync(lock);break}catch{await new Promise(r=>setTimeout(r,3000))}}
  try{const hash=await send(account,state.funding.to,parseEther('0.2'));state.reserveFunding={hash,amountUSDC:0.2};save();}finally{rmdirSync(lock)}
}
if(!state.sweep){
  const account=privateKeyToAccount(state.key);const before=await rpc.getBalance({address:account.address});
  const fee=(await rpc.getGasPrice())*21000n;
  if(before>fee){const amount=before-fee;const hash=await send(account,recipient,amount);state.sweep={hash,to:recipient,amountUSDC:formatEther(amount),remainingUSDC:formatEther(await rpc.getBalance({address:account.address}))};save();}
}
const proofPath='docs/screens/testnet/round2/transactions.json';const proof=JSON.parse(readFileSync(proofPath));proof.reserveFunding=state.reserveFunding;proof.sweep=state.sweep;
proof.budget={grossFundingUSDC:state.funding.amountUSDC+(state.reserveFunding?.amountUSDC||0),sweptBackUSDC:state.sweep?.amountUSDC||'0',capUSDC:1};
writeFileSync(proofPath,JSON.stringify(proof,null,2));console.log(JSON.stringify({budget:proof.budget,sweep:state.sweep},null,2));
