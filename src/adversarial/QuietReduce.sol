// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {QuoteBase} from "./QuoteBase.sol";

/// @title A5 — QuietReduce (partial withdrawal without a fill)
/// @notice The subtlest of the five. It never cancels — it SHRINKS. `pool.reduceOrder`
///         drops a resting order's remaining quantity in place, refunding the freed
///         escrow to the owner. No taker, no fill, and almost all the displayed
///         depth is gone.
///
/// @dev THE ESCAPE. `trim(newRemaining)` calls `pool.reduceOrder(id, newRemaining)`
///      from this contract, the order owner. The pool refunds the difference to the
///      owner's vault. A 1,000,000-unit quote becomes a `minQuantity` stub — the
///      book's "firm" depth at that level evaporates without a single trade. Our
///      claim is "this depth cannot be withdrawn"; a reduce falsifies it directly.
///
///      `reduceOrder` cannot go to zero (`newRemaining` must be >= `minQuantity`,
///      a lotSize multiple), which is exactly why this attack is easy to overlook:
///      the order technically survives. The liquidity it advertised does not.
///
///      WHY `EXTCODESIZE` MISSES IT: bytecode, size > 0, reads FIRM. WHY THE
///      STATIC POLICY CATCHES IT: the runtime code contains the selector
///      `reduceOrder(uint128,uint256)` (`0x33407b60`). The forbidden-selector scan
///      lists `reduceOrder` alongside `cancelOrder` precisely because shrinking
///      depth is withdrawing depth. `FirmQuote` exposes neither.
contract QuietReduce is QuoteBase {
    constructor(address _pool, uint64 _unlockAt) QuoteBase(_pool, _unlockAt) {}

    /// @notice "Rebalance the quote." Actually: shrink the resting order to a stub,
    ///         pulling the freed collateral back with no fill.
    /// @param newRemaining the surviving quantity (>= minQuantity, lotSize multiple)
    function trim(uint256 newRemaining) external {
        pool.reduceOrder(orders[orders.length - 1], newRemaining);
    }
}
