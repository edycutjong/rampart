// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {QuoteBase} from "./QuoteBase.sol";
import {IOperatorPermissionsRegistry} from "../IBinaryPool.sol";

/// @title A4 — OperatorGranter (late operator grant)
/// @notice Rests a quote with NO cancel path in its own code, then — after the
///         order is standing — grants an EOA the pool's `cancelOrderFor` right.
///         The EOA pulls the order. The contract never called `cancelOrder`.
///
/// @dev THE ESCAPE. `openBackDoor(op)` calls the shared OperatorPermissionsRegistry:
///
///        registry.setOperatorApprovalForPool(pool, op, [0xe37b444b], true)
///
///      Now `op` (a plain wallet) can call `pool.cancelOrderFor(thisContract, id)`
///      and the pool accepts it, because the OWNER — this contract — approved it.
///      The withdrawal happens entirely outside this contract's own selectors.
///
///      WHY `EXTCODESIZE` MISSES IT: nothing in this contract's runtime bytecode
///      resembles a cancel; the grant is a normal external call. WHY THE STATIC
///      POLICY CATCHES IT: the runtime code contains `setOperatorApprovalForPool`
///      (`0x7bbc67e6`) / `setOperatorApprovalGlobal` (`0x7f1e31ce`) — the ability
///      to admit an operator is itself the red flag. `FirmQuote` touches the
///      registry nowhere, so it can never open this door.
contract OperatorGranter is QuoteBase {
    /// @dev Shannon (50312). The mainnet twin is 0xE7a1…05ce.
    IOperatorPermissionsRegistry public constant REGISTRY =
        IOperatorPermissionsRegistry(0x15C7e8CE38F021c5b45d098AaD788f63090bF20A);

    bytes4 internal constant CANCEL_ORDER_FOR = 0xe37b444b;

    constructor(address _pool, uint64 _unlockAt) QuoteBase(_pool, _unlockAt) {}

    /// @notice "Delegate keeper duties." Actually: hand `op` a working cancel.
    /// @dev Grants BOTH scopes — per-pool AND global — so the escape lands
    ///      whichever resolution path the pool's authorizer consults. Either is
    ///      enough on its own; a real attacker would grant whatever works.
    function openBackDoor(address op) external {
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = CANCEL_ORDER_FOR;
        REGISTRY.setOperatorApprovalForPool(address(pool), op, sels, true);
        REGISTRY.setOperatorApprovalGlobal(op, sels, true);
    }
}
