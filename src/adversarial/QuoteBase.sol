// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBinaryPool, IBinaryMarket, IERC20} from "../IBinaryPool.sol";

/// @title QuoteBase — the honest-looking half of every attacker in the corpus
/// @notice A deliberate near-clone of `FirmQuote`: it holds collateral, approves
///         the pool, rests BUY-side orders so `Order.owner` is the contract, and
///         its `sweep()` is time-locked. Read its ABI and it is indistinguishable
///         from a firm quote.
///
/// @dev THIS FILE IS THE ADVERSARY'S CAMOUFLAGE, AND THAT IS THE POINT.
///      Every contract in `src/adversarial/` inherits this and adds exactly one
///      escape. The escape is what a naive `EXTCODESIZE > 0` classifier cannot
///      see and what the static bytecode policy is built to catch.
///
///      Not a library, not shared with `FirmQuote`. `FirmQuote` is standalone on
///      purpose: an attested code hash must commit to a self-contained artifact a
///      reader can hold in their head, not to a base class an attacker also uses.
abstract contract QuoteBase {
    address public immutable depositor;
    IBinaryPool public immutable pool;
    IERC20 public immutable collateral;
    uint64 public immutable unlockAt;

    uint128[] public orders;

    error Locked(uint64 unlockAt, uint64 nowTs);
    error NotDepositor(address caller, address expected);
    error PlacementFailed();

    event QuoteRested(uint128 indexed orderId, uint8 kind, uint256 price, uint256 quantity, uint64 expireNs);

    modifier onlyDepositor() {
        if (msg.sender != depositor) revert NotDepositor(msg.sender, depositor);
        _;
    }

    constructor(address _pool, uint64 _unlockAt) {
        depositor = msg.sender;
        pool = IBinaryPool(_pool);
        collateral = IERC20(IBinaryMarket(IBinaryPool(_pool).market()).collateral());
        unlockAt = _unlockAt;
        collateral.approve(_pool, type(uint256).max);
    }

    function rest(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs)
        external
        onlyDepositor
        returns (uint128 orderId)
    {
        require(kind == 0 || kind == 2, "buy-side only");
        bool ok;
        (ok, orderId) = pool.placeBinaryOrder(
            kind, price, quantity, expireTimestampNs, 0, 0, address(0), uint96(0), uint64(0)
        );
        if (!ok) revert PlacementFailed();
        orders.push(orderId);
        emit QuoteRested(orderId, kind, price, quantity, expireTimestampNs);
    }

    function sweep() external onlyDepositor {
        if (block.timestamp < unlockAt) revert Locked(unlockAt, uint64(block.timestamp));
        uint256 vaulted = pool.getWithdrawableBalance(address(this), address(collateral));
        if (vaulted > 0) pool.withdraw(address(collateral), vaulted);
        uint256 bal = collateral.balanceOf(address(this));
        if (bal > 0) collateral.transfer(depositor, bal);
    }

    function orderCount() external view returns (uint256) {
        return orders.length;
    }
}
