# Live Arc mainnet deployment

Chain 5042; production receipts checked on 2026-10-14. Testnet records are retained separately.

| Contract | Mainnet address |
|---|---|
| ccipRegistryModuleOwnerCustom | [0x3201a20D2a33820C0DaC8Bc93C4819755C2a8c7F](https://explorer.arc.io/address/0x3201a20D2a33820C0DaC8Bc93C4819755C2a8c7F) |
| ccipRouter | [0xB79791184973589c38e114D43Eb8E4588C283A18](https://explorer.arc.io/address/0xB79791184973589c38e114D43Eb8E4588C283A18) |
| ccipTokenAdminRegistry | [0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29](https://explorer.arc.io/address/0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29) |
| ccipTokenPoolFactory | [0x7CcFb2Fa43637b4858Cb1269CF0d64a99e8C668a](https://explorer.arc.io/address/0x7CcFb2Fa43637b4858Cb1269CF0d64a99e8C668a) |
| crossChain | [0xeBFD4d58972e5231FB816515198fC4E63593091b](https://explorer.arc.io/address/0xeBFD4d58972e5231FB816515198fC4E63593091b) |
| gatewayMinter | [0x2222222d7164433c4C09B0b0D809a9b52C04C205](https://explorer.arc.io/address/0x2222222d7164433c4C09B0b0D809a9b52C04C205) |
| gatewayWallet | [0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE](https://explorer.arc.io/address/0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE) |
| graduator | [0x524874735655963a82F160Cb741153F50CdebcF6](https://explorer.arc.io/address/0x524874735655963a82F160Cb741153F50CdebcF6) |
| launchpad | [0x52D364dF075CEC807f854d2f7D7ff8485dedf641](https://explorer.arc.io/address/0x52D364dF075CEC807f854d2f7D7ff8485dedf641) |
| memo | [0x5294E9927c3306DcBaDb03fe70b92e01cCede505](https://explorer.arc.io/address/0x5294E9927c3306DcBaDb03fe70b92e01cCede505) |
| swapRouter | [0x90948fda347bBF1fb6f2A6F7Cd4765D6ffD7cfBe](https://explorer.arc.io/address/0x90948fda347bBF1fb6f2A6F7Cd4765D6ffD7cfBe) |
| tokenMessengerV2 | [0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d](https://explorer.arc.io/address/0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d) |
| trackers | [0x05Ff7d5cfd43b714e4abA00493459A600320a406](https://explorer.arc.io/address/0x05Ff7d5cfd43b714e4abA00493459A600320a406) |
| uniswapV2Factory | [0x1294aF729364c40F43A891e92E9A2196D3385c77](https://explorer.arc.io/address/0x1294aF729364c40F43A891e92E9A2196D3385c77) |
| uniswapV2Router02 | [0x29CAa1fa4a9456d5B511e4607033026FE512CD09](https://explorer.arc.io/address/0x29CAa1fa4a9456d5B511e4607033026FE512CD09) |

## Transactions

- CREATE  : [0x10476d7e57777b0c381c59e4c5ed1202ccd624a060b1f86e476957deb9783ce7](https://explorer.arc.io/tx/0x10476d7e57777b0c381c59e4c5ed1202ccd624a060b1f86e476957deb9783ce7); status 1; gas 0.0610302235 USDC.
- CREATE  : [0xa4ae1b4b980c4ea3557594bd244ad4b74d806af3039604cd7cfe4123e05d6cf5](https://explorer.arc.io/tx/0xa4ae1b4b980c4ea3557594bd244ad4b74d806af3039604cd7cfe4123e05d6cf5); status 1; gas 0.0951497855 USDC.
- CREATE JunoLaunchpad : [0x0603fbd9ac61dff75c6b10dd83bad0fc1b1231321bb291b464f422be35805ada](https://explorer.arc.io/tx/0x0603fbd9ac61dff75c6b10dd83bad0fc1b1231321bb291b464f422be35805ada); status 1; gas 0.1015242459 USDC.
- CREATE UniswapV2Graduator : [0x7c8a40c4ac13c0c9f4f30ef28fe8e3feae8cf6ff14ffd1477e330d7eb52bdbc4](https://explorer.arc.io/tx/0x7c8a40c4ac13c0c9f4f30ef28fe8e3feae8cf6ff14ffd1477e330d7eb52bdbc4); status 1; gas 0.0079464205 USDC.
- CALL JunoLaunchpad setGraduator(address): [0x87fccb57bbd71f44d5ca4444bf60194e4db2d80d1fc4ba8db38282f0e50b737e](https://explorer.arc.io/tx/0x87fccb57bbd71f44d5ca4444bf60194e4db2d80d1fc4ba8db38282f0e50b737e); status 1; gas 0.0014347401 USDC.
- CREATE JunoCrossChain : [0x1e4e78cd6ff7139989eff636b606286396e20514349042280ae0269ab9c8a9ee](https://explorer.arc.io/tx/0x1e4e78cd6ff7139989eff636b606286396e20514349042280ae0269ab9c8a9ee); status 1; gas 0.0301289617 USDC.
- CALL JunoLaunchpad setCrossChain(address): [0xcedbf32f60bbf73b73c7af6146b71f56e9067e97c25886000ef1733cacc3a5e0](https://explorer.arc.io/tx/0xcedbf32f60bbf73b73c7af6146b71f56e9067e97c25886000ef1733cacc3a5e0); status 1; gas 0.0006016400 USDC.
- CREATE JunoSwapRouter : [0x16f3be27eb8488f436b53d7ce874c14e4a7739e5dd895dc61862d2d95a48877f](https://explorer.arc.io/tx/0x16f3be27eb8488f436b53d7ce874c14e4a7739e5dd895dc61862d2d95a48877f); status 1; gas 0.0094165805 USDC.
- CREATE JunoTrackers : [0x8e7a10044f0b23e86f2af237f33a9a06e80dd52d62eff570bd820345fbd7d9e0](https://explorer.arc.io/tx/0x8e7a10044f0b23e86f2af237f33a9a06e80dd52d62eff570bd820345fbd7d9e0); status 1; gas 0.0236061014 USDC.
- CALL JunoTrackers setFeed(bytes32,address,uint32,bool): [0xb8dc7f217f384bc38d95e1b434bc9196239089dfdfe85854cd2cbdb3a91f6f78](https://explorer.arc.io/tx/0xb8dc7f217f384bc38d95e1b434bc9196239089dfdfe85854cd2cbdb3a91f6f78); status 1; gas 0.0018833601 USDC.
- CALL JunoTrackers setFeed(bytes32,address,uint32,bool): [0x4bd51ac8838c4b5740083f5b6bdea629acaeb176d3a6fb76dc09d863e888967b](https://explorer.arc.io/tx/0x4bd51ac8838c4b5740083f5b6bdea629acaeb176d3a6fb76dc09d863e888967b); status 1; gas 0.0015416001 USDC.
- CALL JunoTrackers setFeed(bytes32,address,uint32,bool): [0xeaf6d757873964d61493eee6b6e5a657f83e048b86dc96b1894e2dd88b99284b](https://explorer.arc.io/tx/0xeaf6d757873964d61493eee6b6e5a657f83e048b86dc96b1894e2dd88b99284b); status 1; gas 0.0015416001 USDC.
- CALL JunoTrackers setFeed(bytes32,address,uint32,bool): [0xa604a6b13a90d6bb76480e4595c6e9251eaf0314eddad8dd591fde2475c4ceee](https://explorer.arc.io/tx/0xa604a6b13a90d6bb76480e4595c6e9251eaf0314eddad8dd591fde2475c4ceee); status 1; gas 0.0015413601 USDC.
- CALL JunoTrackers setFeed(bytes32,address,uint32,bool): [0x7befe3a809f2d78b147abf0cc07f097b95d8a1f50b43712ff3ecec80a333714e](https://explorer.arc.io/tx/0x7befe3a809f2d78b147abf0cc07f097b95d8a1f50b43712ff3ecec80a333714e); status 1; gas 0.0015416001 USDC.
- CALL JunoTrackers setFeed(bytes32,address,uint32,bool): [0x391500bc9a9fc70242945516e226a583c174132ad7056283b275978ecfabba3f](https://explorer.arc.io/tx/0x391500bc9a9fc70242945516e226a583c174132ad7056283b275978ecfabba3f); status 1; gas 0.0015416001 USDC.
- CALL JunoTrackers setFeed(bytes32,address,uint32,bool): [0x70ccc7364b7fe25c1b6f1b99fd7770ed65474d74e90db49a2782a6c2b6b26051](https://explorer.arc.io/tx/0x70ccc7364b7fe25c1b6f1b99fd7770ed65474d74e90db49a2782a6c2b6b26051); status 1; gas 0.0015416001 USDC.
- CALL JunoTrackers setFeed(bytes32,address,uint32,bool): [0x9227c82cca2ab1b30d83e0c2821c93a5ed43cd59a0140ec013edc59a8e5b062e](https://explorer.arc.io/tx/0x9227c82cca2ab1b30d83e0c2821c93a5ed43cd59a0140ec013edc59a8e5b062e); status 1; gas 0.0015416001 USDC.
- CALL JunoTrackers setFeed(bytes32,address,uint32,bool): [0xb396e85f05c3fa999c6c13f11996a8027023c0698ff548dcf5a6158eb7756b1a](https://explorer.arc.io/tx/0xb396e85f05c3fa999c6c13f11996a8027023c0698ff548dcf5a6158eb7756b1a); status 1; gas 0.0015413601 USDC.
- CALL JunoTrackers setFeed(bytes32,address,uint32,bool): [0x3375c5dc3677e0d848a55588e0ed67338b1df45b168253cdd548a759d9719501](https://explorer.arc.io/tx/0x3375c5dc3677e0d848a55588e0ed67338b1df45b168253cdd548a759d9719501); status 1; gas 0.0015413601 USDC.
- CALL JunoLaunchpad transferOwnership(address): [0x6381a35f377c4d00f9a9a83c40d5aee52248685bf6a9294f7611e30a837f5a5e](https://explorer.arc.io/tx/0x6381a35f377c4d00f9a9a83c40d5aee52248685bf6a9294f7611e30a837f5a5e); status 1; gas 0.0009712401 USDC.
- CALL JunoTrackers transferOwnership(address): [0xd7bada3a3eda1155b4354b425709f15d59e555bbb1ee0421aa2fd71f8fef2497](https://explorer.arc.io/tx/0xd7bada3a3eda1155b4354b425709f15d59e555bbb1ee0421aa2fd71f8fef2497); status 1; gas 0.0009579401 USDC.
- Safe accepts launchpad ownership: [0x70792f77833cab83f80da1064801762e804268c9e68e36285312081a39e656d5](https://explorer.arc.io/tx/0x70792f77833cab83f80da1064801762e804268c9e68e36285312081a39e656d5); status 1; gas 0.0017613750 USDC.
- Safe accepts trackers ownership: [0x516eb9403bf8bd99eeabe8bef241107995305aa46332ae351cdbeff04f7e87c9](https://explorer.arc.io/tx/0x516eb9403bf8bd99eeabe8bef241107995305aa46332ae351cdbeff04f7e87c9); status 1; gas 0.0013959540 USDC.
- service float RELAYER_ADDRESS 1: [0xb7d8bf15ec3b884df691deb66eff9c3baa9675b164527d2dedc61dbf56b78dce](https://explorer.arc.io/tx/0xb7d8bf15ec3b884df691deb66eff9c3baa9675b164527d2dedc61dbf56b78dce); status 1; gas 0.0004410000 USDC.
- Smoke: launch content coin with zero purchase: [0xfde385889cc303e46ee7c132b2c5cfd1f33ef9e6d396448210a51ebd6e688143](https://explorer.arc.io/tx/0xfde385889cc303e46ee7c132b2c5cfd1f33ef9e6d396448210a51ebd6e688143); status 1; gas 0.0499106790 USDC.

Total recorded project gas: 0.4020339281 USDC.

Mainnet smoke is script-driven; hosted mainnet browser transactions and cross-chain delivery are Not run. Public testnet proof remains separately labelled. Production role keys are outside this repository.

Explorer source verification: attempted; API returned a Cloudflare challenge. Read-only browser smoke verification checks receipts independently.
