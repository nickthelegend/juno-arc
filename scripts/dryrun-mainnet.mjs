import * as c from './dryrun-common.mjs';
await c.run('juno', async () => {
const {buildPresetParams}=await import('../lib/juno/curves.ts');
const {junoLaunchpadAbi:a}=await import('../lib/juno/abi.ts');
const n='juno',d=c.load(n),ta=c.abi(n,'JunoTrackers');
for(const role of ['buyer','buyer2','relayer','admin'])await c.fund(n,role,role==='buyer'?'0.6':role==='buyer2'?'0.4':'0.1');
const feeds=await c.read(d.trackers,ta,'feedCount');
const feedAbi=c.parseAbi(['function price(bytes32) view returns(uint256,uint256)','function feedIds(uint256) view returns(bytes32)']);
let prices=[];for(let i=0n;i<feeds;i++){const id=await c.read(d.trackers,feedAbi,'feedIds',[i]); prices.push({id,price:await c.read(d.trackers,ta,'price',[id])});}c.note('feedPrices',prices);
const curve=buildPresetParams({preset:'content',initialMarketCap:30,migrationMarketCap:300,quoteDecimals:6});
const params={...curve,name:'Fork photo post',symbol:'PHOTO',uri:'https://fork-only.invalid/photo.json',quote:c.USDC,graduator:'0x0000000000000000000000000000000000000000'};
const token=await c.read(d.launchpad,a,'predictToken',[c.roles.buyer,params.name,params.symbol,params.uri]);
await c.approve(n,'buyer',d.launchpad,300000n);
await c.memoWrite(n,'launch photo with 0.1 USDC','buyer',d.launchpad,a,'launch',[params,100000n,0n]);
const deadline=(await c.pub.getBlock()).timestamp+86400n;
await c.memoWrite(n,'scroll buy 0.1 USDC','buyer',d.launchpad,a,'buy',[token,100000n,0n,c.roles.buyer,deadline]);
const salt=c.keccak256(c.toHex('juno-second-buyer')),nonce=await c.read(d.launchpad,a,'buyNonce',[token,c.roles.buyer2,100000n,0n,deadline,salt]);
const u=await c.auth('buyer2',d.launchpad,100000n,nonce,'ReceiveWithAuthorization');
await c.memoWrite(n,'gasless second buyer 0.1 USDC','relayer',d.launchpad,a,'buyWithAuthorization',[token,c.roles.buyer2,100000n,0n,deadline,salt,u.validAfter,u.validBefore,u.v,u.r,u.s]);
c.note('positionBeforeSell',{pool:await c.read(d.launchpad,a,'getPool',[token]),token});
for(const role of ['buyer','buyer2']){const amount=await c.read(token,c.erc,'balanceOf',[c.roles[role]]);await c.approve(n,role,d.launchpad,amount,token);await c.memoWrite(n,'sell all '+role,role,d.launchpad,a,'sell',[token,amount,0n,c.roles[role],deadline]);}
await c.write(n,'creator claims fees','buyer',d.launchpad,a,'claimCreatorFees',[token,c.roles.buyer]);

});
