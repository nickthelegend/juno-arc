#!/usr/bin/env node
// Read-only: node scripts/e2e-browser-juno.mjs (API :8911, web export :8912).
// Real testnet writes: JUNO_BROWSER_WRITE=1 node scripts/e2e-browser-juno.mjs --flow
// Requires a configured/funded faucet. Funding from the shared deployer is capped
// at 0.60 USDC once per saved run; secrets stay in .juno/browser-round2/.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import sharp from 'sharp';

const API = process.env.JUNO_API_URL || 'http://127.0.0.1:8911';
const WEB = process.env.JUNO_WEB_URL || 'http://127.0.0.1:8912';
const PRIVATE = resolve('.juno/browser-'+(process.env.JUNO_BROWSER_RUN || 'round2'));
const OUT = resolve('docs/screens/testnet/round2');
mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });
mkdirSync(OUT, { recursive: true });
const get = async p => { const r = await fetch(API + p); assert.equal(r.status, 200, p); return r.json(); };
const config = await get('/api/juno/config');
assert.equal(config.chainId, 5042002);
assert.equal(config.localFork, false, 'The application must use live Arc testnet');
assert.equal(new URL(config.rpcUrl).hostname, 'rpc.testnet.arc.io');
const flow = process.argv.includes('--flow');
if (flow) assert.equal(process.env.JUNO_BROWSER_WRITE, '1', 'Explicit write opt-in required');
const statePath = resolve(PRIVATE, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : { receipts: [], launches: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
const chain = defineChain({ id: 5042002, name: 'Arc testnet', nativeCurrency: {name:'USDC',symbol:'USDC',decimals:18}, rpcUrls:{default:{http:['https://rpc.testnet.arc.io']}} });
const rpc = createPublicClient({chain, transport:http('https://rpc.testnet.arc.io')});
assert.equal(await rpc.getChainId(), 5042002);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: {width:390,height:1000} });
const page = await context.newPage();
page.setDefaultTimeout(45000);
let step = 'open';
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const pending = new Set();
page.on('response', r => {
  if (!flow || !r.url().includes('/api/juno/')) return;
  if (!/\/(submit|buy-relayed|faucet)$/.test(new URL(r.url()).pathname) || r.request().method() !== 'POST') return;
  const task = r.json().then(data => { if(data.hash) {state.receipts.push({step, ...data}); save();} }).catch(()=>{});
  pending.add(task); task.finally(()=>pending.delete(task));
});
await page.route('**/api/juno/tx/submit', async route => {
  const tx = parseTransaction(route.request().postDataJSON().signed);
  assert.equal(tx.chainId, 5042002, 'Refuse any non-testnet transaction');
  assert.ok((tx.value || 0n) <= parseEther('0.5'));
  await route.continue();
});
const screenshot = name => page.screenshot({path:resolve(OUT,name+'.png'),fullPage:true});
async function skipTour() { const skip=page.getByRole('button',{name:'Skip',exact:true}); if(await skip.isVisible()) await skip.click(); }
async function open(route) { await page.goto(WEB+route, {waitUntil:'domcontentloaded'}); await page.waitForTimeout(2500); await skipTour(); }
async function waitButton(name) { const b=page.getByRole('button',{name,exact:true}); await b.waitFor(); await b.click(); }

async function fundRelayer() {
  if(state.funding) return;
  process.loadEnvFile('.env.local');
  const content = readFileSync('../.deployer/deployer.env','utf8');
  const key=content.split('\n').find(s=>s.startsWith('DEPLOYER_PRIVATE_KEY=')).split('=').slice(1).join('=').trim().replace(/^["']|["']$/g,'');
  const deployer=privateKeyToAccount(key.startsWith('0x')?key:'0x'+key);
  assert.equal(deployer.address.toLowerCase(),'0x0648adf1967692a0c991d7715b0b588452321fbd');
  const to=config.arc.relayer.address;
  assert.ok(to);
  const lock=resolve('../.deployer/lock');
  while(true) {try{mkdirSync(lock);break;}catch{await new Promise(r=>setTimeout(r,3000));}}
  try {
    const client=createWalletClient({account:deployer,chain,transport:http('https://rpc.testnet.arc.io')});
    const hash=await client.sendTransaction({to,value:parseEther('0.6')});
    state.funding={hash,to,amountUSDC:0.6};save();
    assert.equal((await rpc.waitForTransactionReceipt({hash})).status,'success');
  } finally {rmdirSync(lock);}
}

async function runFlow() {
  if(state.key) await context.addInitScript(key=>localStorage.setItem('juno.arc.signer.v1',key),state.key);
  await open('/post');
  if(!state.key) {
    await waitButton('Create wallet to launch');
    state.key=await page.evaluate(()=>localStorage.getItem('juno.arc.signer.v1'));
    assert.ok(state.key);state.wallet=privateKeyToAccount(state.key).address;save();
  }
  await fundRelayer();
  if(!state.faucet) {
    step='faucet';
    const answer=page.waitForResponse(r=>r.url().endsWith('/api/juno/faucet') && r.request().method()==='POST');
    await waitButton('Get testnet USDC');
    const r=await answer;assert.equal(r.status(),200);const data=await r.json();assert.ok(data.amount<=0.5);state.faucet=data;save();
  }
  const seeds=[['One balance','ONEARC','Post, trade and gas.','USDC does all three.','#D6FF3D','#12150E'],['Made on Arc','MADEARC','A post becomes','a real market.','#DCE7D5','#12150E'],['Own the moment','MOMENTARC','A signed buy.','A verifiable receipt.','#12150E','#D6FF3D']];
  for(let i=state.launches.length;i<seeds.length;i++) {
    const [name,symbol,l1,l2,bg,fg]=seeds[i];
    const file=resolve(PRIVATE,`seed-${i}.png`);
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="${bg}"/><g fill="${fg}" font-family="Helvetica,Arial,sans-serif"><text x="60" y="95" font-size="42" font-weight="bold">juno</text><text x="60" y="350" font-size="62" font-weight="bold">${l1}</text><text x="60" y="430" font-size="62" font-weight="bold">${l2}</text><path d="M60 610H740" stroke="${fg}"/><text x="60" y="670" font-size="24">ARC TESTNET · DEMONSTRATION LAUNCH</text><text x="60" y="715" font-size="24">Real contract. Test tokens. No monetary value.</text></g></svg>`)).png().toFile(file);
    await open('/post');
    const chooser=page.waitForEvent('filechooser');
    await page.getByRole('button',{name:/Add a photo/}).click();
    await (await chooser).setFiles(file);
    await page.getByLabel('Name',{exact:true}).fill(name);
    await page.getByLabel('Ticker',{exact:true}).fill(symbol);
    await page.getByLabel('Caption',{exact:true}).fill('Demonstration launch on Arc testnet. Real on-chain market; test tokens have no monetary value.');
    await page.getByRole('radio',{name:'$0.01',exact:true}).click();
    step=`launch ${symbol}`;
    await screenshot(`flow-${i+1}-ready`);
    await waitButton('Launch post');
    await page.waitForURL(/\/coin\/0x/, {timeout:120000});
    const token=new URL(page.url()).pathname.split('/').at(-1);
    state.launches.push({name,symbol,token});save();
    await page.waitForTimeout(2000);await screenshot(`flow-${i+1}-launched`);
    console.log('Launched',symbol,token);
  }
  await Promise.all([...pending]);
  if(!state.reel) {
    await open('/post?format=reel');
    const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:/Add a video/}).click();
    await (await chooser).setFiles(resolve('scripts/fixtures/juno-test-clip.mp4'));
    await page.getByLabel('Name',{exact:true}).fill('Reel upload proof');
    await page.getByLabel('Ticker',{exact:true}).fill('REELARC');
    await page.getByLabel('Caption',{exact:true}).fill('One-second demonstration clip. Real video upload and Arc testnet launch; test tokens have no monetary value.');
    step='launch REELARC';await waitButton('Launch reel');
    await page.waitForURL(/\/coin\/0x/,{timeout:120000});
    state.reel={token:new URL(page.url()).pathname.split('/').at(-1)};save();
    await open('/reels');await screenshot('reel-launched');
    await page.waitForFunction(()=>[...document.querySelectorAll('video')].some(v=>v.readyState>=2),undefined,{timeout:45000});
    state.reel.playable=true;save();console.log('PASS browser reel launch and playback');
  }
  const token=state.launches[0].token;
  for(const mode of ['gasless buy','signed buy','sell']) {
    if(state.receipts.some(r=>r.step===mode))continue;
    await open('/coin/'+token);
    await waitButton('Buy');
    await page.getByTestId('sheet-coin').waitFor();
    if(mode==='sell') {
      await page.getByRole('button',{name:'Sell',exact:true}).first().click();
      await page.getByTestId('quick-amount').last().click();
    } else {
      for(const key of ['0','.','0','1']) await page.getByRole('button',{name:key,exact:true}).click();
      if(mode==='gasless buy') await page.getByRole('switch',{name:'Pay with signature, no gas'}).click();
    }
    step=mode;
    const before=await rpc.getBalance({address:state.wallet});
    const submit=mode==='gasless buy'?'Sign and buy — no gas':mode==='sell'?'Sell':'Buy';
    const confirm=page.getByRole('button',{name:submit,exact:true}).last();
    await confirm.waitFor();
    await screenshot(mode.replaceAll(' ','-')+'-quote');
    await confirm.click();
    await page.getByRole('button',{name:'Done',exact:true}).waitFor({timeout:120000});
    await Promise.all([...pending]);
    if(mode==='gasless buy') {
      const after=await rpc.getBalance({address:state.wallet});
      assert.equal(before-after,parseEther('0.01'),'Buyer pays only 0.01 USDC; relayer pays gas');
      state.gaslessBalanceProof={before:formatEther(before),after:formatEther(after),spentUSDC:0.01};save();
    }
    await screenshot(mode.replaceAll(' ','-')+'-receipt');
    await waitButton('Done');console.log('PASS browser',mode);
  }
  if(!state.receipts.some(r=>r.step==='creator fee claim')) {
    await open('/coin/'+token);
    step='creator fee claim';
    await page.getByRole('button',{name:'Claim',exact:true}).click();
    await page.getByText('Claimed — view the transaction',{exact:true}).waitFor({timeout:90000});
    await screenshot('creator-fee-claim');console.log('PASS browser fee claim');
  }
  await Promise.all([...pending]);
  if(!state.profileSaved) {
    await open('/profile');await waitButton('Edit profile');
    await page.getByLabel('Name',{exact:true}).fill('arcproof'+state.wallet.slice(-4).toLowerCase());
    await page.getByLabel('Bio',{exact:true}).fill('Arc testnet demonstration creator. These are real launches using test tokens with no monetary value.');
    await waitButton('Save');
    await page.getByRole('button',{name:'Edit profile',exact:true}).waitFor();
    state.profileSaved=true;save();await screenshot('profile-saved');
  }
  if(!state.commentSaved) {
    await open('/coin/'+token);await page.getByLabel('Comment on this coin',{exact:true}).click();
    const comment='Browser-tested on Arc testnet: image launch, gasless buy, signed buy, sell and fee claim. Test tokens only.';
    await page.getByPlaceholder('Add a comment...').fill(comment);await page.getByRole('button',{name:'Post comment'}).click();
    await page.getByText(comment,{exact:true}).waitFor();state.commentSaved=true;save();await screenshot('comment-posted');
  }
  if(!state.postId) {
    const r=await fetch(API+'/api/juno/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({author:state.wallet,token,body:'Arc testnet demonstration: this post links to ONEARC, a real image launch. The browser bought with a gasless signature, bought normally, sold and claimed creator fees. Test tokens have no monetary value.'})});
    assert.equal(r.status,201);state.postId=(await r.json()).post.id;save();
  }
  if(!state.extras) {
    await open('/coin/'+token);await page.getByRole('button',{name:'Details',exact:true}).click();
    const watch=page.getByLabel('Watch',{exact:true});if(await watch.isVisible())await watch.click();
    await page.getByRole('button',{name:/Alert me at a price/}).click();
    await page.getByPlaceholder('0.00',{exact:true}).fill('0.000002');await waitButton('Set alert');
    await page.getByRole('button',{name:/Alert at/}).waitFor();
    await page.getByRole('button',{name:'Buy this every week',exact:true}).click();
    await page.getByPlaceholder('0.00',{exact:true}).fill('0.01');
    await page.getByPlaceholder('No goal',{exact:true}).fill('0.05');await waitButton('Start');
    await page.getByLabel('Pause 0.01 USDC weekly',{exact:true}).click();
    await page.getByLabel('Resume 0.01 USDC weekly',{exact:true}).waitFor();
    await screenshot('alert-and-paused-plan');
    await page.getByLabel('Remove 0.01 USDC weekly',{exact:true}).click();
    await page.getByRole('button',{name:'Buy this every week',exact:true}).waitFor();
    await page.getByRole('button',{name:/Alert at/}).click();await page.getByLabel('Remove the alert',{exact:true}).click();
    await page.getByRole('button',{name:/Alert me at a price/}).waitFor();
    await open('/post/'+state.postId);
    const reply='Demonstration reply: all trades above are real Arc testnet transactions.';
    await page.getByPlaceholder('Write a reply…').fill(reply);await waitButton('Reply');
    await page.getByText(reply,{exact:true}).waitFor();await screenshot('post-reply');
    await open('/social');const follow=page.getByRole('button',{name:'Follow',exact:true}).first();await follow.click();
    await page.getByRole('tab',{name:'Following',exact:true}).click();await page.waitForTimeout(1500);
    assert.ok(!(await page.locator('body').innerText()).includes('Follow someone'));
    await screenshot('following-real-creator');
    state.extras=true;save();console.log('PASS browser watch, alert create/remove, plan create/pause/remove, reply, follow');
  }
  const proof={checkedAt:new Date().toISOString(),chainId:5042002,wallet:state.wallet,funding:state.funding,launches:state.launches,reel:state.reel,gaslessBalanceProof:state.gaslessBalanceProof,receipts:state.receipts};
  for(const r of proof.receipts){const receipt=await rpc.getTransactionReceipt({hash:r.hash});assert.equal(receipt.status,'success');r.gasUSDC=formatEther(receipt.gasUsed*receipt.effectiveGasPrice);r.explorer='https://explorer.testnet.arc.io/tx/'+r.hash;}
  writeFileSync(resolve(OUT,'transactions.json'),JSON.stringify(proof,null,2));
}

async function audit() {
  const pools=(await get('/api/juno/pools')).pools;assert.ok(pools.length>=3,'Feed needs real launches');
  const posts=(await get('/api/juno/posts')).posts;
  const routes=['/','/social','/trade','/trade?sort=trackers','/trade?sort=traders','/post','/post?format=reel','/post?tracker=BTC%2FUSD','/reels','/profile','/arc','/inbox','/search',`/coin/${pools[0].token}`,`/trader/${pools[0].creatorWallet}`,...(posts[0]?[`/post/${posts[0].id}`]:[]),'/post/999999','/missing-route'];
  const interactionsOnly=process.argv.includes('--interactions-only');
  const results=interactionsOnly?JSON.parse(readFileSync(resolve(OUT,'routes.json'))).results.filter(r=>r.route!=='signed-in interactions'):[];
  for(const width of [1440,390]) {
    if(interactionsOnly)break;
    await page.setViewportSize({width,height:1000});
    for(const [i,route] of routes.entries()) {
      errors.length=0;await open(route);
      if(route.includes('trackers')) await page.getByTestId('feed-board').waitFor({timeout:60000});
      await page.waitForFunction(()=>[...document.images].every(i=>i.complete),undefined,{timeout:15000});
      const text=await page.locator('body').innerText();
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
      const brokenImages=await page.locator('img').evaluateAll(nodes=>nodes.filter(n=>n.complete&&n.naturalWidth===0).map(n=>n.getAttribute('src')));
      assert.equal(overflow,false,route+' overflow');assert.deepEqual(errors,[],route+' browser errors');assert.deepEqual(brokenImages,[],route+' broken images');
      assert.ok(!/\b(Monad|AUSD|Kuru|Mera|lorem|undefined)\b|\[object Object\]/i.test(text),route+' stale/placeholder copy');
      if(route==='/post') assert.match(text,/Demo storage:/);
      await screenshot(`route-${width}-${String(i).padStart(2,'0')}`);
      results.push({width,route,overflow,brokenImages,errors:[...errors],text});
      writeFileSync(resolve(OUT,'routes.json'),JSON.stringify({checkedAt:new Date().toISOString(),api:API,web:WEB,chainId:config.chainId,results},null,2));
      console.log('PASS',width,route);
    }
  }
  if(state.key) {
    await context.addInitScript(key=>localStorage.setItem('juno.arc.signer.v1',key),state.key);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      await open('/coin/'+state.launches[0].token);
      for(const tab of ['Activity','Holders','Details']) {
        await page.getByRole('button',{name:tab,exact:true}).click();await page.waitForTimeout(800);
        await screenshot(`coin-${width}-${tab.toLowerCase()}`);
      }
      await page.getByRole('button',{name:/^Comments(?: \d+)?$/}).click();
      await page.getByPlaceholder('Add a comment...').waitFor();await screenshot(`coin-${width}-comments`);await page.keyboard.press('Escape');
      await open('/profile');
      for(const tab of ['Posts','Reels','Coins','Backed','Wallet']) {
        await page.getByRole('tab',{name:tab,exact:true}).first().click();await page.waitForTimeout(1200);
        await screenshot(`profile-${width}-${tab.toLowerCase()}`);
      }
      for(const tab of ['Holdings','Watching','Plans','Activity','About']) {
        const button=page.getByRole('tab',{name:tab,exact:true});
        if(await button.count()){await button.click();await page.waitForTimeout(800);await screenshot(`wallet-${width}-${tab.toLowerCase()}`);}
      }
      await open('/search');await page.getByLabel('Search coins and creators').fill('ONEARC');
      await page.getByTestId('search-coin').first().waitFor();await screenshot(`search-${width}-results`);
      await page.getByTestId('search-coin').first().click();await page.waitForURL(/\/coin\/0x/);
      await open('/social');await page.getByRole('tab',{name:'Following',exact:true}).click();await screenshot(`following-${width}`);
      await page.getByRole('tab',{name:'For you',exact:true}).click();
      await page.getByLabel('Create — a photo or a reel',{exact:true}).click();await screenshot(`create-menu-${width}`);
      results.push({width,route:'signed-in interactions',checked:['coin Activity/Holders/Details/Comments','profile Posts/Reels/Coins/Backed/Wallet','wallet sub-tabs','search result navigation','Following/For you','create menu']});
    }
  }
  writeFileSync(resolve(OUT,'routes.json'),JSON.stringify({checkedAt:new Date().toISOString(),api:API,web:WEB,chainId:config.chainId,results},null,2));
}
try { if(flow) await runFlow(); else await audit(); }
catch(e) { await screenshot('failure'); console.error('Browser check failed:',e.message);process.exitCode=1; }
finally { await Promise.all([...pending]);await browser.close(); }
