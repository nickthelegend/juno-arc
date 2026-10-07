// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IUniswapV2Factory, IUniswapV2Pair} from "./interfaces/IUniswapV2.sol";

/// @title JunoSwapRouter
/// @notice Trades a graduated Juno coin against its Uniswap v2 pair, in one
/// transaction.
///
/// When a curve fills, `UniswapV2Graduator` moves its reserves into a v2
/// TOKEN/USDC pair on Arc and locks the liquidity. Uniswap's own Router02 (also
/// deployed by Juno's script) can trade it too; this router is what the app
/// uses because its `Swapped` event names the trader, so the app's history and
/// the indexer attribute every post-graduation fill to a wallet.
///
/// It is the minimum a router needs to be: find the pair, move the input into
/// it, ask the pair for the output the constant-product formula allows (with
/// v2's 0.3% fee), and check the caller's minimum and deadline. ERC-20 only:
/// on Arc, USDC is both the gas token and the ERC-20 at 0x3600…0000, so there
/// is nothing to wrap. It holds nothing between calls.
contract JunoSwapRouter is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IUniswapV2Factory public immutable factory;

    /// @notice A swap through the router. The pair's own `Swap` event names the
    /// router as sender; this names the trader.
    event Swapped(
        address indexed pair,
        address indexed trader,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address to
    );

    error Expired();
    error NoPair();
    error ZeroAmount();
    error InsufficientLiquidity();
    error Slippage(uint256 got, uint256 wanted);

    constructor(IUniswapV2Factory factory_) {
        factory = factory_;
    }

    /// @notice Swap one token for another through their pair — a coin quoted
    /// in USDC, in either direction. Needs an allowance for `tokenIn`.
    function swapExactTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroAmount();
        address pair = _pairFor(tokenIn, tokenOut);
        IERC20(tokenIn).safeTransferFrom(msg.sender, pair, amountIn);
        amountOut = _swap(pair, tokenIn, tokenOut, to);
        if (amountOut < minOut) revert Slippage(amountOut, minOut);
        emit Swapped(pair, msg.sender, tokenIn, tokenOut, amountIn, amountOut, to);
    }

    /// @notice What a swap of `amountIn` would pay out right now, and the
    /// reserves it was priced against.
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
    {
        (reserveIn, reserveOut) = _reserves(_pairFor(tokenIn, tokenOut), tokenIn);
        amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
    }

    /// @notice Uniswap v2's formula: 0.3% of the input stays in the pool.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256)
    {
        // Input checks, not comparisons of balances anyone can steer.
        // slither-disable-next-line incorrect-equality
        if (amountIn == 0) revert ZeroAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * reserveOut) / (reserveIn * 1_000 + inWithFee);
    }

    function _pairFor(address a, address b) internal view returns (address pair) {
        pair = factory.getPair(a, b);
        if (pair == address(0)) revert NoPair();
    }

    function _reserves(address pair, address tokenIn) internal view returns (uint256 reserveIn, uint256 reserveOut) {
        // The reserves are all a price needs; the last-update timestamp is not.
        // slither-disable-next-line unused-return
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
        (reserveIn, reserveOut) = tokenIn == IUniswapV2Pair(pair).token0() ? (r0, r1) : (r1, r0);
    }

    /// @dev The input is already in the pair. What arrived is measured rather
    /// than assumed, so a token that takes a fee on transfer is priced on what
    /// the pair actually received.
    function _swap(address pair, address tokenIn, address tokenOut, address to)
        internal
        returns (uint256 amountOut)
    {
        (uint256 reserveIn, uint256 reserveOut) = _reserves(pair, tokenIn);
        uint256 received = IERC20(tokenIn).balanceOf(pair) - reserveIn;
        amountOut = getAmountOut(received, reserveIn, reserveOut);
        (uint256 out0, uint256 out1) =
            tokenOut == IUniswapV2Pair(pair).token0() ? (amountOut, uint256(0)) : (uint256(0), amountOut);
        IUniswapV2Pair(pair).swap(out0, out1, to, new bytes(0));
    }
}
