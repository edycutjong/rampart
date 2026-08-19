// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBinaryPool, IERC20} from "./IBinaryPool.sol";

/// @title FirmQuote — a resting quote nobody can pull, enforced by the pool
/// @notice Holds collateral and rests BUY-side orders on a Somnia BinaryPool so
///         that `Order.owner` is THIS CONTRACT rather than an EOA.
///
/// @dev WHY THIS WORKS. Every path that withdraws a resting order is closed:
///
///      | path                          | who may call it              |
///      |-------------------------------|------------------------------|
///      | `pool.cancelOrder(id)`        | the order owner ONLY — a non-owner
///      |                               | reverts `IncorrectSender` 0xf5e39c1f
///      | `pool.cancelOrderFor(o,id)`   | an operator the OWNER approved. The
///      |                               | system-contract allowlist does NOT
///      |                               | admit callers here (unlike
///      |                               | `placeOrderFor`) — per-user approval only
///      | `pool.reduceOrderFor(...)`    | same: per-user approval only
///
///      This contract owns the orders and exposes no cancel, no reduce, and
///      never calls `setOperator` on anything before `unlockAt`. So the two
///      operator routes have no grant to ride on, and the direct routes revert
///      for everyone including the depositor. The quote stands until a taker
///      fills it or its mandatory `expireTimestampNs` lapses.
///
///      BUY SIDE ONLY, deliberately. A sell escrows outcome tokens, which needs
///      a one-time `setOperator` grant on the ERC-6909 singleton — and granting
///      an operator is exactly the thing whose absence makes the lock airtight.
///      Selling firm is a v2 problem.
///
///      NOT AUDITED. Hackathon code. Holds only the depositor's own collateral;
///      there is no third-party custody anywhere in this contract.
contract FirmQuote {
    /// @notice The account that funds this quote and may sweep it after unlock.
    address public immutable depositor;
    /// @notice The BinaryPool this quote rests on.
    IBinaryPool public immutable pool;
    /// @notice The pool's collateral token (TestUSDC on Shannon, USDso on mainnet).
    IERC20 public immutable collateral;
    /// @notice Unix seconds before which nothing may leave this contract.
    uint64 public immutable unlockAt;

    /// @notice Order ids this contract has placed, in placement order.
    uint128[] public orders;

    error Locked(uint64 unlockAt, uint64 nowTs);
    error NotDepositor(address caller, address expected);
    error PlacementFailed();
    error SweepTransferFailed();
    error ApproveFailed();

    event QuoteRested(uint128 indexed orderId, uint8 kind, uint256 price, uint256 quantity, uint64 expireNs);
    event Swept(uint256 collateralOut);

    modifier onlyDepositor() {
        if (msg.sender != depositor) revert NotDepositor(msg.sender, depositor);
        _;
    }

    /// @param _pool the BinaryPool to quote on
    /// @param _unlockAt unix seconds; until then nothing can be withdrawn from here
    constructor(address _pool, uint64 _unlockAt) {
        depositor = msg.sender;
        pool = IBinaryPool(_pool);
        collateral = IERC20(IBinaryPool(_pool).collateral());
        unlockAt = _unlockAt;
        // One allowance, set once at construction. Buy-side escrow is pulled by
        // the pool from THIS contract at placement time.
        if (!collateral.approve(_pool, type(uint256).max)) revert ApproveFailed();
    }

    /// @notice Rest a firm BUY quote. Callable only by the depositor, but note
    ///         that calling it is the ONLY thing the depositor can do: there is
    ///         no counterpart that takes an order back.
    /// @param kind 0 BUY_YES or 2 BUY_NO (sells are rejected — see the contract note)
    /// @param price YES-side price in raw collateral units, ALREADY tick-snapped
    /// @param quantity outcome-token quantity in raw units, ALREADY lot-snapped
    /// @param expireTimestampNs must be > 0 and <= pool.marketExpiryNs
    function rest(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs)
        external
        onlyDepositor
        returns (uint128 orderId)
    {
        require(kind == 0 || kind == 2, "buy-side only");
        bool ok;
        // orderType 0 = NormalOrder (rest). No builder, no fee, no userData.
        (ok, orderId) = pool.placeBinaryOrder(
            kind, price, quantity, expireTimestampNs, 0, 0, address(0), uint96(0), uint64(0)
        );
        if (!ok) revert PlacementFailed();
        orders.push(orderId);
        emit QuoteRested(orderId, kind, price, quantity, expireTimestampNs);
    }

    /// @notice After `unlockAt`, return everything to the depositor: any pool-vault
    ///         credit first (the `PayoutFallbackToVault` path), then the balance held here.
    /// @dev Before `unlockAt` this reverts, which is the whole commitment.
    function sweep() external onlyDepositor {
        if (block.timestamp < unlockAt) revert Locked(unlockAt, uint64(block.timestamp));
        uint256 vaulted = pool.getWithdrawableBalance(address(this), address(collateral));
        if (vaulted > 0) pool.withdraw(address(collateral), vaulted);
        uint256 bal = collateral.balanceOf(address(this));
        if (bal > 0) {
            // Check the return value: a token that reports failure instead of
            // reverting would otherwise leave the sweep looking successful while
            // the collateral never moved.
            if (!collateral.transfer(depositor, bal)) revert SweepTransferFailed();
        }
        emit Swept(bal);
    }

    /// @notice How many orders this contract has ever rested.
    function orderCount() external view returns (uint256) {
        return orders.length;
    }

    // Deliberately absent, and this absence IS the product:
    //   - no cancel()      - no reduce()
    //   - no setOperator() - no approveBuilder()
    //   - no rescue / owner-escape hatch before unlockAt
}
