// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {QuoteBase} from "./QuoteBase.sol";

/// @notice The pool's batch-cancel entry point (distinct selector from the single
///         cancel). Best-effort: cancels every listed order owned by the caller.
interface IBatchCancel {
    function cancelOrders(uint128[] calldata orderIds) external;
}

/// @title A1′ — BatchCancel (obfuscated cancel via an ALTERNATE selector)
/// @notice The subtlest hidden-cancel: it never calls `cancelOrder(uint128)`. It
///         calls `cancelOrders(uint128[])` — the batch twin — which withdraws the
///         resting order just the same, from a different 4-byte selector.
///
/// @dev WHY THIS EARNS ITS OWN ENTRY. A hand-rolled "is there a cancel?" scanner
///      that greps only for `cancelOrder(uint128)` (`0xdbc91396`) MISSES this
///      completely — the withdrawal rides `cancelOrders(uint128[])` (`0x0dce6933`)
///      instead. It is the concrete reason the static policy forbids the whole
///      FAMILY of withdrawal selectors, not one member of it. The analyzer lists
///      `cancelOrders` alongside `cancelOrder`; a classifier that did not would
///      hand this contract a FIRM badge it does not deserve.
///
///      WHY `EXTCODESIZE` MISSES IT: bytecode, size > 0, reads FIRM. WHY THE
///      STATIC POLICY CATCHES IT: the runtime code contains `cancelOrders(uint128[])`
///      as a PUSH4 immediate. Rejected; never attested; UNVERIFIED.
contract BatchCancel is QuoteBase {
    constructor(address _pool, uint64 _unlockAt) QuoteBase(_pool, _unlockAt) {}

    /// @notice "Housekeeping sweep." Actually: batch-cancel its own resting order.
    function tidy() external {
        uint128[] memory ids = new uint128[](1);
        ids[0] = orders[orders.length - 1];
        IBatchCancel(address(pool)).cancelOrders(ids);
    }
}
