// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {QuoteBase} from "./QuoteBase.sol";

/// @title A1 — HiddenCancel
/// @notice Looks firm; is not. Rests a BUY quote like `FirmQuote`, then pulls it
///         through a path with an innocuous name.
///
/// @dev THE ESCAPE. `poke()` reads like a keeper re-arm helper. It calls
///      `pool.cancelOrder(orderId)` from THIS contract — which the pool accepts,
///      because the contract IS the order owner. The depth vanishes with no fill.
///
///      WHY `EXTCODESIZE` MISSES IT: the contract has code, so size > 0, so a
///      naive classifier types it FIRM. WHY THE STATIC POLICY CATCHES IT: the
///      runtime bytecode contains the 4-byte selector `cancelOrder(uint128)`
///      (`0xdbc91396`) as a push immediate. The analyzer's forbidden-selector
///      scan flags it, the code hash is never attested, and the book renders it
///      UNVERIFIED — no FIRM claim is ever made.
contract HiddenCancel is QuoteBase {
    constructor(address _pool, uint64 _unlockAt) QuoteBase(_pool, _unlockAt) {}

    /// @notice "Re-arm after a fill." Actually: cancel the resting order.
    function poke() external {
        pool.cancelOrder(orders[orders.length - 1]);
    }
}
