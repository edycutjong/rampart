// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBinaryPool, IBinaryMarket, IERC20} from "../IBinaryPool.sol";

/// @title A2 — EIP-1967 upgradeable proxy
/// @notice The order owner is a PROXY. At rest time it delegates to firm logic
///         with no cancel path. After the order is standing, the admin swaps the
///         implementation to logic that DOES cancel, and pulls.
///
/// @dev WHY `EXTCODEHASH` ALONE MISSES IT: the proxy's runtime bytecode — and so
///      its code hash — never changes across the upgrade. A classifier that
///      attested the code hash at rest time would keep calling the depth FIRM
///      after the behaviour behind it was replaced wholesale. Code hash is a
///      commitment to bytes, and for a proxy the bytes are not where the
///      behaviour lives.
///
///      WHY THE STATIC POLICY CATCHES IT: the proxy shell contains the EIP-1967
///      implementation-slot constant
///      `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` as a
///      push immediate AND the `DELEGATECALL` opcode (`0xf4`). Either is
///      disqualifying on its own; a proxy trips both. The code hash is never
///      attested, so the depth reads UNVERIFIED — no FIRM claim, upgrade or not.
contract Erc1967Proxy {
    // EIP-1967 slots — chosen as keccak256("eip1967.proxy.*") - 1 so no compiler
    // ever allocates state here. Their PRESENCE in the runtime code is the tell.
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    constructor(address implementation, address admin) {
        assembly {
            sstore(IMPL_SLOT, implementation)
            sstore(ADMIN_SLOT, admin)
        }
    }

    /// @notice Admin-only. "Ship a patch." Actually: replace the entire behaviour
    ///         behind the same address and code hash.
    function upgradeTo(address newImplementation) external {
        require(msg.sender == _admin(), "not admin");
        assembly {
            sstore(IMPL_SLOT, newImplementation)
        }
    }

    function implementation() external view returns (address impl) {
        assembly {
            impl := sload(IMPL_SLOT)
        }
    }

    function _admin() internal view returns (address a) {
        assembly {
            a := sload(ADMIN_SLOT)
        }
    }

    fallback() external payable {
        assembly {
            let impl := sload(IMPL_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}

/// @notice Shared storage layout for both proxy implementations. EIP-1967 keeps
///         impl/admin in high slots, so slots 0..4 are free for logic state.
abstract contract ProxyLogicStorage {
    address internal _pool; // slot 0
    address internal _collateral; // slot 1
    uint64 internal _unlockAt; // slot 2
    address internal _depositor; // slot 3
    uint128[] internal _orders; // slot 4

    function unlockAt() external view returns (uint64) {
        return _unlockAt;
    }

    function depositor() external view returns (address) {
        return _depositor;
    }

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    function orders(uint256 i) external view returns (uint128) {
        return _orders[i];
    }
}

/// @notice V1 — the honest-looking implementation the proxy delegates to at rest
///         time. No cancel, no reduce, no operator grant. Passes for firm.
contract ProxyLogicFirm is ProxyLogicStorage {
    function init(address pool_, uint64 unlockAt_) external {
        require(_depositor == address(0), "init");
        _depositor = msg.sender;
        _pool = pool_;
        _collateral = IBinaryMarket(IBinaryPool(pool_).market()).collateral();
        _unlockAt = unlockAt_;
        IERC20(_collateral).approve(pool_, type(uint256).max);
    }

    function rest(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs)
        external
        returns (uint128 orderId)
    {
        require(kind == 0 || kind == 2, "buy-side only");
        bool ok;
        (ok, orderId) = IBinaryPool(_pool).placeBinaryOrder(
            kind, price, quantity, expireTimestampNs, 0, 0, address(0), uint96(0), uint64(0)
        );
        require(ok, "placement");
        _orders.push(orderId);
    }
}

/// @notice V2 — the malicious implementation swapped in AFTER the order rests.
///         Same storage layout; adds `pull()`.
contract ProxyLogicEvil is ProxyLogicStorage {
    function pull() external {
        IBinaryPool(_pool).cancelOrder(_orders[_orders.length - 1]);
    }
}
