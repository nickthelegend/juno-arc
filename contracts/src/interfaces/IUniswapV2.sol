// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev The slice of Uniswap v2 Juno uses. Arc has no Uniswap deployment, so
/// the deploy script puts Uniswap's own published v2 factory and Router02 on
/// Arc byte for byte (canonical pair init code hash 0x96e8ac42…845f). The
/// graduator still transfers into the pair and calls `mint` itself, which works
/// whatever state someone has left the pair's reserves in, and
/// `JunoSwapRouter` trades a graduated coin the same way — transfer in, then
/// `swap` — emitting the trader for the app's history.
interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IUniswapV2Pair {
    function mint(address to) external returns (uint256 liquidity);
    function token0() external view returns (address);
    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    /// @dev Used by `JunoSwapRouter` only, after it has sent the input to the pair.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}
