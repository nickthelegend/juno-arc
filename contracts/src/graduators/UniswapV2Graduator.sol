// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IJunoGraduator} from "../interfaces/IJunoGraduator.sol";
import {IUniswapV2Factory, IUniswapV2Pair} from "../interfaces/IUniswapV2.sol";

/// @title UniswapV2Graduator
/// @notice Graduates a completed Juno curve into a Uniswap v2 TOKEN/USDC pair
/// on Arc and locks the liquidity by minting it to the dead address.
///
/// Arc has no Uniswap deployment, so Juno's deploy script puts Uniswap's own
/// published v2 factory on Arc byte for byte; its pairs share the canonical
/// init code hash (0x96e8ac42…845f), so any v2 tooling can find and trade them.
///
/// The pair's address is fixed at launch, so the token can refuse transfers
/// into it until the curve's reserves arrive — but the pair itself is only
/// deployed at graduation. A v2 pair lives at a CREATE2 address derived from
/// the factory, the two tokens and the pair's init code hash, so it can be
/// locked before it exists.
///
/// At graduation the reserves are transferred in and `mint` is called directly
/// — no router. The router refuses to add liquidity to a pair whose reserves
/// are one-sided, and anyone can make them one-sided by creating the pair
/// early, donating USDC and calling `sync`. `mint` credits whatever arrived
/// above the recorded reserves, so a donation only ever nudges the opening
/// price in the curve's favour at the donor's expense; it cannot stop
/// graduation.
contract UniswapV2Graduator is IJunoGraduator {
    using SafeERC20 for IERC20;

    /// @notice LP tokens minted here can never be burned, so the liquidity is permanent.
    address public constant LOCK = 0x000000000000000000000000000000000000dEaD;

    address public immutable launchpad;
    IUniswapV2Factory public immutable factory;
    /// @notice keccak256 of the factory's pair creation code: Uniswap's
    /// canonical 0x96e8ac42…845f for the published factory Juno deploys.
    bytes32 public immutable pairInitCodeHash;

    error OnlyLaunchpad();
    /// @dev The factory created the pair somewhere other than the address the
    /// token was locked against — the init code hash is wrong for this
    /// factory. Graduating anyway would seed an unlocked pair.
    error PairMismatch(address expected, address actual);

    constructor(address launchpad_, IUniswapV2Factory factory_, bytes32 pairInitCodeHash_) {
        launchpad = launchpad_;
        factory = factory_;
        pairInitCodeHash = pairInitCodeHash_;
    }

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _;
    }

    /// @notice Where the pair for `token`/`quote` is, or will be.
    function pairFor(address token, address quote) public view returns (address) {
        (address token0, address token1) = token < quote ? (token, quote) : (quote, token);
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(factory), salt, pairInitCodeHash))))
        );
    }

    function prepare(address token, address quote, uint256, uint256)
        external
        view
        onlyLaunchpad
        returns (address)
    {
        return pairFor(token, quote);
    }

    function graduate(address token, address quote, uint256 baseAmount, uint256 quoteAmount)
        external
        onlyLaunchpad
        returns (address pair, uint256 liquidity)
    {
        pair = factory.getPair(token, quote);
        if (pair == address(0)) pair = factory.createPair(token, quote);
        address expected = pairFor(token, quote);
        if (pair != expected) revert PairMismatch(expected, pair);

        IERC20(token).safeTransfer(pair, baseAmount);
        IERC20(quote).safeTransfer(pair, quoteAmount);
        liquidity = IUniswapV2Pair(pair).mint(LOCK);
    }
}
