// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// GENERATED FILE — do not edit by hand.
//
// Written by scripts/curve-fixtures.ts from the app's curve builder
// (lib/juno/curves.ts, buildPresetParams) and its bigint CurveMath port
// (lib/juno/curve-math.ts). Regenerate from the repo root with:
//
//     npx tsx scripts/curve-fixtures.ts
//
// The file is committed, so `forge test` needs no Node, npm or network: it is
// only the generator that does. Every preset appears once, quoted in Arc's
// USDC (6 decimals, $1,000 FDV at the open). `curveBase`, `threshold` and
// `migrationBase` are what the TypeScript side predicts the launchpad will
// compute; PresetParity.t.sol checks the chain agrees exactly.

import {JunoLaunchpad} from "../../src/JunoLaunchpad.sol";

library PresetFixtures {
    struct Fixture {
        string label;
        /// @dev Always 6: USDC on Arc.
        uint8 quoteDecimals;
        /// @dev FDV at the start and at the top of the curve, in whole quote tokens.
        uint256 initialMarketCap;
        uint256 migrationMarketCap;
        /// @dev `launch` arguments. `quote` is left zero; the test sets it.
        JunoLaunchpad.LaunchParams params;
        /// @dev TypeScript's prediction of the launchpad's own totals.
        uint256 curveBase;
        uint256 threshold;
        uint256 migrationBase;
    }

    uint256 internal constant COUNT = 4;

    function get(uint256 i) internal pure returns (Fixture memory) {
        if (i == 0) return contentUsdc();
        if (i == 1) return thinNameUsdc();
        if (i == 2) return ipoBookUsdc();
        if (i == 3) return tightNavUsdc();
        revert("PresetFixtures: no such fixture");
    }

    /// @dev One range: its upper sqrt price (Q64.96) and its liquidity.
    function seg(uint160 sqrt, uint128 liquidity) private pure returns (JunoLaunchpad.Segment memory) {
        return JunoLaunchpad.Segment({sqrtPriceX96: sqrt, liquidity: liquidity});
    }

    function contentUsdc() internal pure returns (Fixture memory f) {
        f.label = "content / USDC";
        f.quoteDecimals = 6;
        f.initialMarketCap = 1000;
        f.migrationMarketCap = 25000;
        f.params.name = "Parity content / USDC";
        f.params.symbol = "CONTENTUSDC";
        f.params.uri = "ipfs://parity";
        f.params.preset = 0;
        f.params.sqrtStartPriceX96 = 79228162514264337593;
        f.params.curve[0] = seg(87612325705285574413, 234874282682172990);
        f.params.curve[1] = seg(96883726340454522648, 281849139218607588);
        f.params.curve[2] = seg(107136254562933087912, 338218967062329106);
        f.params.curve[3] = seg(118473736254101969378, 405862760474794927);
        f.params.curve[4] = seg(131010984463355395126, 487035312569753912);
        f.params.curve[5] = seg(144874962103368931871, 584442375083704695);
        f.params.curve[6] = seg(160206067685288421087, 701330850100445634);
        f.params.curve[7] = seg(177159557114295710296, 841597067095391297);
        f.params.curve[8] = seg(195907115943870750252, 1009916433539613020);
        f.params.curve[9] = seg(216638598010743245893, 1211899626297822552);
        f.params.curve[10] = seg(239563948057440405217, 1454279551557387062);
        f.params.curve[11] = seg(264915327812553301294, 1745135649768290620);
        f.params.curve[12] = seg(292949467059231469164, 2094162591822522599);
        f.params.curve[13] = seg(323950263500838845702, 2512995345061309801);
        f.params.curve[14] = seg(358231657752237294333, 3015594367098715225);
        f.params.curve[15] = seg(396140812571321687967, 3618713240518458270);
        f.params.startFeeBps = 900;
        f.params.endFeeBps = 100;
        f.params.feeDecaySeconds = 600;
        f.params.feeDecayWad = 35957993026439420;
        f.curveBase = 711970664276829220461479960;
        f.threshold = 6950733401;
        f.migrationBase = 278029336040000000000505153;
    }

    function thinNameUsdc() internal pure returns (Fixture memory f) {
        f.label = "thin-name / USDC";
        f.quoteDecimals = 6;
        f.initialMarketCap = 1000;
        f.migrationMarketCap = 25000;
        f.params.name = "Parity thin-name / USDC";
        f.params.symbol = "THINNAMEUSDC";
        f.params.uri = "ipfs://parity";
        f.params.preset = 1;
        f.params.sqrtStartPriceX96 = 79228162514264337593;
        f.params.curve[0] = seg(87612325705285574413, 2456182265053591298);
        f.params.curve[1] = seg(96883726340454522648, 2014069457343944864);
        f.params.curve[2] = seg(107136254562933087912, 1651536955022034789);
        f.params.curve[3] = seg(118473736254101969378, 1354260303118068527);
        f.params.curve[4] = seg(131010984463355395126, 1110494038040559805);
        f.params.curve[5] = seg(144874962103368931871, 910605012945968438);
        f.params.curve[6] = seg(160206067685288421087, 746696601852147129);
        f.params.curve[7] = seg(177159557114295710296, 612289395943884506);
        f.params.curve[8] = seg(195907115943870750252, 502078041528664811);
        f.params.curve[9] = seg(216638598010743245893, 411705271268282973);
        f.params.curve[10] = seg(239563948057440405217, 337597339967086016);
        f.params.curve[11] = seg(264915327812553301294, 276828934547395114);
        f.params.curve[12] = seg(292949467059231469164, 227000364936252907);
        f.params.curve[13] = seg(323950263500838845702, 186139316774821362);
        f.params.curve[14] = seg(358231657752237294333, 152634534497225324);
        f.params.curve[15] = seg(396140812571321687967, 125159679680335851);
        f.params.startFeeBps = 500;
        f.params.endFeeBps = 60;
        f.params.feeDecaySeconds = 900;
        f.params.feeDecayWad = 34720638352628423;
        f.curveBase = 901776390623068992012909113;
        f.threshold = 2205590244;
        f.migrationBase = 88223609760000000000160294;
    }

    function ipoBookUsdc() internal pure returns (Fixture memory f) {
        f.label = "ipo-book / USDC";
        f.quoteDecimals = 6;
        f.initialMarketCap = 1000;
        f.migrationMarketCap = 25000;
        f.params.name = "Parity ipo-book / USDC";
        f.params.symbol = "IPOBOOKUSDC";
        f.params.uri = "ipfs://parity";
        f.params.preset = 2;
        f.params.sqrtStartPriceX96 = 79228162514264337593;
        f.params.curve[0] = seg(87612325705285574413, 1854727171375707556);
        f.params.curve[1] = seg(96883726340454522648, 1508510814476518353);
        f.params.curve[2] = seg(107136254562933087912, 1211754467056405144);
        f.params.curve[3] = seg(118473736254101969378, 964458129115367929);
        f.params.curve[4] = seg(131010984463355395126, 766619945926235331);
        f.params.curve[5] = seg(144874962103368931871, 618241772216178726);
        f.params.curve[6] = seg(160206067685288421087, 519323607985198115);
        f.params.curve[7] = seg(177159557114295710296, 469863598506122122);
        f.params.curve[8] = seg(195907115943870750252, 469863598506122122);
        f.params.curve[9] = seg(216638598010743245893, 519323607985198115);
        f.params.curve[10] = seg(239563948057440405217, 618241772216178726);
        f.params.curve[11] = seg(264915327812553301294, 766619945926235331);
        f.params.curve[12] = seg(292949467059231469164, 964458129115367929);
        f.params.curve[13] = seg(323950263500838845702, 1211754467056405144);
        f.params.curve[14] = seg(358231657752237294333, 1508510814476518353);
        f.params.curve[15] = seg(396140812571321687967, 1854727171375707556);
        f.params.startFeeBps = 400;
        f.params.endFeeBps = 50;
        f.params.feeDecaySeconds = 900;
        f.params.feeDecayWad = 34063671075154448;
        f.curveBase = 824999999999999999634720771;
        f.threshold = 4125000009;
        f.migrationBase = 165000000360000000000299789;
    }

    function tightNavUsdc() internal pure returns (Fixture memory f) {
        f.label = "tight-nav / USDC";
        f.quoteDecimals = 6;
        f.initialMarketCap = 1000;
        f.migrationMarketCap = 1500;
        f.params.name = "Parity tight-nav / USDC";
        f.params.symbol = "TIGHTNAVUSDC";
        f.params.uri = "ipfs://parity";
        f.params.preset = 3;
        f.params.sqrtStartPriceX96 = 79228162514264337593;
        f.params.curve[0] = seg(80238432437863037277, 2970000000000000000);
        f.params.curve[1] = seg(81261584716499875884, 2970000000000000000);
        f.params.curve[2] = seg(82297783618225848648, 2970000000000000000);
        f.params.curve[3] = seg(83347195505739435514, 2970000000000000000);
        f.params.curve[4] = seg(84409988863096287277, 2970000000000000000);
        f.params.curve[5] = seg(85486334322759497596, 2970000000000000000);
        f.params.curve[6] = seg(86576404692994803815, 2970000000000000000);
        f.params.curve[7] = seg(87680374985615114936, 2970000000000000000);
        f.params.curve[8] = seg(88798422444078821131, 2970000000000000000);
        f.params.curve[9] = seg(89930726571946396017, 2970000000000000000);
        f.params.curve[10] = seg(91077469161699860433, 2970000000000000000);
        f.params.curve[11] = seg(92238834323929734688, 2970000000000000000);
        f.params.curve[12] = seg(93415008516894165302, 2970000000000000000);
        f.params.curve[13] = seg(94606180576454971957, 2970000000000000000);
        f.params.curve[14] = seg(95812541746395420943, 2970000000000000000);
        f.params.curve[15] = seg(97034285709124592626, 2970000000000000000);
        f.params.startFeeBps = 200;
        f.params.endFeeBps = 25;
        f.params.feeDecaySeconds = 300;
        f.params.feeDecayWad = 34063671075154448;
        f.curveBase = 545005154644653682787613768;
        f.threshold = 667492279;
        f.migrationBase = 444994852666666665954459879;
    }
}
