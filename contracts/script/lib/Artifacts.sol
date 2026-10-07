// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";

/// @notice Deploys third-party contracts from their *published* bytecode, byte for byte, rather than
///         recompiling them: Uniswap v2 from the npm packages uniswap/v2-core and uniswap/v2-periphery (the npm build
///         artifacts Uniswap shipped; the pair's init code hash is the canonical 0x96e8ac42…845f) and
///         Chainlink CCIP 2.0 from the npm package chainlink/contracts-ccip (bytecode/) (extracted from Chainlink's gobindings).
library Artifacts {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    string internal constant V2_FACTORY = "node_modules/@uniswap/v2-core/build/UniswapV2Factory.json";
    string internal constant V2_PAIR = "node_modules/@uniswap/v2-core/build/UniswapV2Pair.json";
    string internal constant V2_ROUTER02 = "node_modules/@uniswap/v2-periphery/build/UniswapV2Router02.json";
    string internal constant CCIP = "node_modules/@chainlink/contracts-ccip/bytecode/";

    bytes32 internal constant UNISWAP_V2_PAIR_INIT_CODE_HASH =
        0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f;

    error DeployFailed(string what);

    /// @dev Creation code from a Waffle-style artifact (`bytecode` is a hex string).
    function uniswap(string memory path) internal view returns (bytes memory) {
        return vm.parseJsonBytes(vm.readFile(string.concat(vm.projectRoot(), "/", path)), ".bytecode");
    }

    /// @dev Creation code of a CCIP contract, e.g. `ccip("v2_0_0/burn_mint_token_pool")`.
    function ccip(string memory name) internal view returns (bytes memory) {
        string memory hexCode = vm.readFile(string.concat(vm.projectRoot(), "/", CCIP, name, ".bin"));
        return vm.parseBytes(_trim(hexCode));
    }

    function v2PairInitCodeHash() internal view returns (bytes32) {
        return keccak256(uniswap(V2_PAIR));
    }

    function create(bytes memory initCode, string memory what) internal returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (deployed == address(0)) revert DeployFailed(what);
    }

    function _trim(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 n = b.length;
        while (n > 0 && (b[n - 1] == 0x0a || b[n - 1] == 0x0d || b[n - 1] == 0x20)) n--;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) out[i] = b[i];
        if (n < 2 || out[0] != "0" || out[1] != "x") return string.concat("0x", string(out));
        return string(out);
    }
}
