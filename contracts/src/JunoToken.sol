// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title JunoToken
/// @notice One post, one token. Minted in full to the launchpad that sells it
/// on a USDC bonding curve on Arc, graduated into a Uniswap v2 pair that
/// outlives the app, and — once graduated — able to become a Chainlink CCIP
/// Cross-Chain Token (CCT) that holders bridge to Base or Ethereum.
///
/// Three departures from a plain ERC-20, all in service of that one market:
///
/// 1. **The pair is locked until graduation.** The pair's address is fixed at
///    launch. Until the curve completes, nobody can send tokens to it —
///    otherwise anyone could seed the pair at a price of their choosing before
///    the curve's reserves arrive.
///
/// 2. **The launchpad needs no allowance.** It is this token's own market and
///    only ever moves tokens out of `msg.sender`, so selling is one signature.
///
/// 3. **CCIP burn/mint, bounded by what left.** Arc is the token's home chain:
///    every unit that exists anywhere was minted here at launch. After
///    graduation the token's CCIP admin can name one CCIP token pool
///    (Chainlink's BurnMintTokenPool). The pool burns what holders send out and
///    mints what comes back, and the token enforces `ccipMinted <= ccipBurned`:
///    the pool can only ever re-mint on Arc what was burned on Arc on the way
///    out. Whatever happens on a remote chain, the supply on Arc can never
///    exceed the one billion minted at launch, and the Arc pair can never be
///    drained with tokens conjured elsewhere.
contract JunoToken is ERC20, ERC20Permit {
    /// @notice The launchpad that minted and sells this token.
    address public immutable launchpad;
    /// @notice The wallet that published the post.
    address public immutable creator;
    /// @notice Pinned metadata: name, description, media. Usually `ipfs://…`.
    string public tokenURI;
    /// @notice The AMM pair this token graduates into. Zero before launch completes.
    address public pair;
    /// @notice Set once the curve's reserves have moved into `pair`.
    bool public graduated;

    /// @notice Who may register this token with CCIP (TokenAdminRegistry via
    /// RegistryModuleOwnerCustom.registerAdminViaGetCCIPAdmin) and name its pool.
    /// Juno's `JunoCrossChain` at launch, so a creator goes cross-chain in one call.
    address public ccipAdmin;
    address public pendingCCIPAdmin;
    /// @notice The CCIP token pool allowed to mint, and whose burns count as bridged out.
    address public ccipPool;
    /// @notice Burned on Arc by CCIP pools: tokens that left for another chain.
    uint256 public ccipBurned;
    /// @notice Minted on Arc by CCIP pools: tokens that came back.
    uint256 public ccipMinted;

    error OnlyLaunchpad();
    error OnlyCCIPAdmin();
    error OnlyCCIPPool();
    error PairLocked();
    error PairAlreadySet();
    error NotGraduated();
    /// @dev A pool tried to mint more on Arc than has been bridged out of Arc.
    error ExceedsBridgedOut(uint256 requested, uint256 available);

    event PairSet(address indexed pair);
    event Graduated(address indexed pair);
    event CCIPAdminTransferStarted(address indexed from, address indexed to);
    event CCIPAdminTransferred(address indexed from, address indexed to);
    event CCIPPoolSet(address indexed previous, address indexed pool);

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _;
    }

    modifier onlyCCIPAdmin() {
        if (msg.sender != ccipAdmin) revert OnlyCCIPAdmin();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        string memory uri_,
        address creator_,
        uint256 supply,
        address ccipAdmin_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        launchpad = msg.sender;
        creator = creator_;
        tokenURI = uri_;
        ccipAdmin = ccipAdmin_ == address(0) ? creator_ : ccipAdmin_;
        _mint(msg.sender, supply);
    }

    /* ------------------------------------------------------------------ */
    /* Launchpad                                                          */
    /* ------------------------------------------------------------------ */

    function setPair(address pair_) external onlyLaunchpad {
        if (pair != address(0)) revert PairAlreadySet();
        pair = pair_;
        emit PairSet(pair_);
    }

    function markGraduated() external onlyLaunchpad {
        graduated = true;
        emit Graduated(pair);
    }

    /* ------------------------------------------------------------------ */
    /* CCIP Cross-Chain Token                                             */
    /* ------------------------------------------------------------------ */

    /// @notice CCIP's RegistryModuleOwnerCustom reads this to let the admin
    /// register the token in the TokenAdminRegistry.
    function getCCIPAdmin() external view returns (address) {
        return ccipAdmin;
    }

    /// @notice Name the CCIP pool (or replace it). Only after graduation: a
    /// curve's supply is accounted for by the launchpad until then.
    function setCCIPPool(address pool) external onlyCCIPAdmin {
        if (!graduated) revert NotGraduated();
        emit CCIPPoolSet(ccipPool, pool);
        ccipPool = pool;
    }

    function transferCCIPAdmin(address to) external onlyCCIPAdmin {
        pendingCCIPAdmin = to;
        emit CCIPAdminTransferStarted(msg.sender, to);
    }

    function acceptCCIPAdmin() external {
        if (msg.sender != pendingCCIPAdmin) revert OnlyCCIPAdmin();
        emit CCIPAdminTransferred(ccipAdmin, msg.sender);
        ccipAdmin = msg.sender;
        pendingCCIPAdmin = address(0);
    }

    /// @notice Chainlink's BurnMintTokenPool mints here when tokens arrive from
    /// another chain — never more than has left Arc.
    function mint(address to, uint256 amount) external {
        if (msg.sender != ccipPool || msg.sender == address(0)) revert OnlyCCIPPool();
        uint256 available = ccipBurned - ccipMinted;
        if (amount > available) revert ExceedsBridgedOut(amount, available);
        ccipMinted += amount;
        _mint(to, amount);
    }

    /// @notice Burn your own tokens. The launchpad burns the curve's rounding
    /// buffer this way at graduation; the CCIP pool burns what leaves Arc.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        if (msg.sender == ccipPool && msg.sender != address(0)) ccipBurned += amount;
    }

    /// @notice What the CCIP pool may still mint on Arc.
    function bridgedOut() external view returns (uint256) {
        return ccipBurned - ccipMinted;
    }

    /* ------------------------------------------------------------------ */
    /* ERC-20                                                             */
    /* ------------------------------------------------------------------ */

    function _update(address from, address to, uint256 value) internal override {
        if (!graduated && to != address(0) && to == pair) revert PairLocked();
        super._update(from, to, value);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal override {
        if (spender == launchpad) return;
        super._spendAllowance(owner, spender, value);
    }
}
