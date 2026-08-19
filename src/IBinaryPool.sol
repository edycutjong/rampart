// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The subset of Somnia's BinaryPool that Rampart touches.
/// @dev Signatures transcribed from `@somnia-chain/markets-sdk@0.27.0`
///      `src/tradeAbi.ts` (`binaryPoolWriteAbi`). Two are easy to get wrong and
///      both are fatal:
///
///      1. A binary pool does NOT expose the generic `placeOrder` — that entry
///         reverts `UseBinaryPlacement`. The YES/NO side is an explicit `kind`
///         param and `price` is ALWAYS quoted in YES terms.
///      2. `builderFeeBpsTimes1k` must be `uint96`. It is selector-critical: a
///         `uint256` there silently produces a different function selector and
///         the call reverts with no decodable reason.
interface IBinaryPool {
    /// @param kind 0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO
    /// @param price YES-side limit price, raw collateral units per whole outcome token
    /// @param quantity outcome-token quantity, raw units (must be a lotSize multiple)
    /// @param expireTimestampNs mandatory; must satisfy 0 < it <= pool.marketExpiryNs
    /// @param orderType 0 NormalOrder(rest), 1 FOK, 2 IOC, 3 PostOnly
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    /// @dev Reverts `IncorrectSender(caller, expected)` (0xf5e39c1f) for a non-owner.
    ///      This revert is the entire point of Rampart.
    function cancelOrder(uint128 orderId) external;

    /// @dev The other withdrawal path. `reduceOrderFor` is per-user-approval only
    ///      (no system-contract allowlist), so a contract that grants no operator
    ///      cannot be reduced by anyone either.
    function reduceOrder(uint128 orderId, uint256 newQuantityRemaining) external;

    /// @notice Permissionless keeper drain. ANYONE may evict EXPIRED orders and the
    ///         escrow returns to each order's owner. This is why a firm quote is
    ///         firm only until `expireTimestampNs` — the commitment window is
    ///         bounded by the order's own expiry, by design.
    function sweepExpiredAtLevel(bool isBid, uint256 price, uint256 maxCount)
        external
        returns (uint256 cleaned);

    /// @notice Withdraw this account's pool-vault balance. Fills normally deliver
    ///         straight to the owner; if delivery ever fails the pool emits
    ///         `PayoutFallbackToVault` and credits here instead, so proceeds can
    ///         never strand.
    function withdraw(address token, uint256 amount) external;

    function getWithdrawableBalance(address account, address token) external view returns (uint256);

    /// @notice Nanosecond expiry of the market this pool currently serves.
    function marketExpiryNs() external view returns (uint64);

    function collateral() external view returns (address);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
