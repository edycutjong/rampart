// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {QuoteBase} from "./QuoteBase.sol";
import {IBinaryPool} from "../IBinaryPool.sol";

/// @notice The code `DelegateEscape` runs in its OWN storage context via
///         DELEGATECALL. It calls `pool.cancelOrder` — and because it executes as
///         the quote contract, `msg.sender` at the pool is the order owner.
contract EscapeLogic {
    /// @dev Storage layout MUST match DelegateEscape's inherited slots so `orders`
    ///      reads correctly under delegatecall. QuoteBase declares four immutables
    ///      (no storage slots) then `uint128[] orders` at slot 0. This mirror puts
    ///      `orders` at slot 0 too.
    uint128[] public orders;

    function pull(address pool) external {
        IBinaryPool(pool).cancelOrder(orders[orders.length - 1]);
    }
}

/// @title A3 — DelegateEscape (the sharpest attack)
/// @notice Its own runtime bytecode contains NO cancel path. It reaches one
///         through `DELEGATECALL` to an attacker-chosen target, which runs
///         arbitrary code in this contract's context.
///
/// @dev THE ESCAPE. `escape(logic)` delegatecalls `EscapeLogic.pull(pool)`. The
///      cancel executes with `address(this)` as the caller the pool sees, so the
///      pool accepts it — this contract owns the order. The pulled logic can be
///      chosen or swapped at will; the quote contract's runtime code never
///      changes, yet its behaviour is entirely unbounded.
///
///      WHY `EXTCODESIZE` MISSES IT: size > 0 and stable; behaviour is not in the
///      code at all. WHY THE STATIC POLICY CATCHES IT: the runtime bytecode
///      contains the `DELEGATECALL` opcode (`0xf4`). The analyzer's opcode
///      histogram requires `DELEGATECALL == 0` for a FIRM-capable verdict —
///      because with even one, the code hash commits to nothing about behaviour.
///      `FirmQuote` contains no `DELEGATECALL`.
contract DelegateEscape is QuoteBase {
    constructor(address _pool, uint64 _unlockAt) QuoteBase(_pool, _unlockAt) {}

    /// @notice "Run a maintenance routine." Actually: delegatecall arbitrary code
    ///         that cancels the resting order in this contract's context.
    function escape(address logic) external {
        (bool ok, bytes memory ret) =
            logic.delegatecall(abi.encodeWithSelector(EscapeLogic.pull.selector, address(pool)));
        require(ok, _reason(ret));
    }

    function _reason(bytes memory ret) internal pure returns (string memory) {
        if (ret.length < 68) return "delegate failed";
        assembly {
            ret := add(ret, 0x04)
        }
        return abi.decode(ret, (string));
    }
}
