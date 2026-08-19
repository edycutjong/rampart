// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FirmQuote} from "../src/FirmQuote.sol";
import {IBinaryPool, IERC20} from "../src/IBinaryPool.sol";

/// @dev SCOPE OF THESE TESTS — read this before trusting them.
///
///      These prove the CONTRACT's own invariants against a mock pool: that no
///      withdrawal path exists, that the timelock holds, that only the depositor
///      can rest. They do NOT prove the judged capability.
///
///      The judged capability is "a real Somnia BinaryPool accepts a contract as
///      Order.owner and then refuses the funder's cancel". No mock can establish
///      that — only `gate.sh` running against Shannon can, and its evidence is a
///      pair of explorer links (LESSONS R11: assert the external side effect, not
///      the return value).
contract MockBinaryMarket {
    address public collateral;
    constructor(address c) { collateral = c; }
}

contract MockBinaryPool {
    address public market;
    address public collateral;   // deliberately present but UNUSED by FirmQuote — the real pool reverts here
    uint64 public marketExpiryNs;
    bool public placeSucceeds = true;
    uint128 public nextId = 1;
    uint256 public vaultBalance;
    uint256 public lastKind;
    uint256 public lastPrice;
    uint256 public lastQuantity;
    address public lastCaller;
    bool public withdrawCalled;

    constructor(address _collateral, uint64 _expiryNs) {
        collateral = _collateral;
        marketExpiryNs = _expiryNs;
        market = address(new MockBinaryMarket(_collateral));
    }

    function setPlaceSucceeds(bool v) external { placeSucceeds = v; }
    function setVaultBalance(uint256 v) external { vaultBalance = v; }

    function placeBinaryOrder(
        uint8 kind, uint256 price, uint256 quantity, uint64, uint8, uint8, address, uint96, uint64
    ) external payable returns (bool, uint128) {
        lastCaller = msg.sender;
        lastKind = kind;
        lastPrice = price;
        lastQuantity = quantity;
        if (!placeSucceeds) return (false, 0);
        return (true, nextId++);
    }

    function getWithdrawableBalance(address, address) external view returns (uint256) { return vaultBalance; }

    function withdraw(address token, uint256 amount) external {
        withdrawCalled = true;
        vaultBalance = 0;
        MockERC20(token).mint(msg.sender, amount);
    }
}

contract MockERC20 is IERC20 {
    mapping(address => uint256) public bal;
    mapping(address => mapping(address => uint256)) public allowed;
    bool public approveReturns = true;
    bool public transferReturns = true;

    function setApproveReturns(bool v) external { approveReturns = v; }
    function setTransferReturns(bool v) external { transferReturns = v; }
    function mint(address to, uint256 a) external { bal[to] += a; }
    function balanceOf(address a) external view returns (uint256) { return bal[a]; }

    function approve(address s, uint256 a) external returns (bool) {
        allowed[msg.sender][s] = a;
        return approveReturns;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        if (!transferReturns) return false;
        bal[msg.sender] -= a;
        bal[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        bal[f] -= a; bal[t] += a; return true;
    }
}

contract FirmQuoteTest is Test {
    MockERC20 token;
    MockBinaryPool pool;
    FirmQuote fq;

    uint64 constant EXPIRY_NS = 2_000_000_000 * 1e9;
    uint64 constant UNLOCK = 2_000_000_000;
    address constant STRANGER = address(0xBEEF);

    function setUp() public {
        token = new MockERC20();
        pool = new MockBinaryPool(address(token), EXPIRY_NS);
        fq = new FirmQuote(address(pool), UNLOCK);
        token.mint(address(fq), 1_000_000);
    }

    // ---- construction -----------------------------------------------------

    function test_constructor_setsDepositorToDeployer() public view { assertEq(fq.depositor(), address(this)); }
    function test_constructor_setsPool() public view { assertEq(address(fq.pool()), address(pool)); }
    function test_constructor_readsCollateralFromPool() public view { assertEq(address(fq.collateral()), address(token)); }
    function test_constructor_setsUnlockAt() public view { assertEq(fq.unlockAt(), UNLOCK); }
    function test_constructor_approvesPoolForMax() public view {
        assertEq(token.allowed(address(fq), address(pool)), type(uint256).max);
    }

    function test_constructor_revertsIfApproveReturnsFalse() public {
        MockERC20 bad = new MockERC20();
        bad.setApproveReturns(false);
        MockBinaryPool p2 = new MockBinaryPool(address(bad), EXPIRY_NS);
        vm.expectRevert(FirmQuote.ApproveFailed.selector);
        new FirmQuote(address(p2), UNLOCK);
    }

    // ---- resting ----------------------------------------------------------

    function test_rest_placesAndReturnsOrderId() public {
        uint128 id = fq.rest(0, 500000, 1000000, EXPIRY_NS);
        assertEq(id, 1);
    }

    function test_rest_ownerOfOrderIsTheContractNotTheEoa() public {
        fq.rest(0, 500000, 1000000, EXPIRY_NS);
        // The single most important assertion in this file: the pool saw the
        // CONTRACT as msg.sender, so Order.owner is the contract.
        assertEq(pool.lastCaller(), address(fq));
        assertTrue(pool.lastCaller() != address(this));
    }

    function test_rest_recordsOrderId() public {
        fq.rest(0, 500000, 1000000, EXPIRY_NS);
        assertEq(fq.orders(0), 1);
    }

    function test_rest_incrementsOrderCount() public {
        assertEq(fq.orderCount(), 0);
        fq.rest(0, 500000, 1000000, EXPIRY_NS);
        assertEq(fq.orderCount(), 1);
        fq.rest(2, 400000, 1000000, EXPIRY_NS);
        assertEq(fq.orderCount(), 2);
    }

    function test_rest_forwardsKindPriceQuantity() public {
        fq.rest(2, 123456, 999000, EXPIRY_NS);
        assertEq(pool.lastKind(), 2);
        assertEq(pool.lastPrice(), 123456);
        assertEq(pool.lastQuantity(), 999000);
    }

    function test_rest_acceptsBuyYes() public { fq.rest(0, 500000, 1000000, EXPIRY_NS); }
    function test_rest_acceptsBuyNo() public { fq.rest(2, 500000, 1000000, EXPIRY_NS); }

    function test_rest_rejectsSellYes() public {
        vm.expectRevert("buy-side only");
        fq.rest(1, 500000, 1000000, EXPIRY_NS);
    }

    function test_rest_rejectsSellNo() public {
        vm.expectRevert("buy-side only");
        fq.rest(3, 500000, 1000000, EXPIRY_NS);
    }

    function test_rest_rejectsUnknownKind() public {
        vm.expectRevert("buy-side only");
        fq.rest(7, 500000, 1000000, EXPIRY_NS);
    }

    function test_rest_onlyDepositor() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(FirmQuote.NotDepositor.selector, STRANGER, address(this)));
        fq.rest(0, 500000, 1000000, EXPIRY_NS);
    }

    function test_rest_revertsWhenPoolReportsFailure() public {
        pool.setPlaceSucceeds(false);
        vm.expectRevert(FirmQuote.PlacementFailed.selector);
        fq.rest(0, 500000, 1000000, EXPIRY_NS);
    }

    function test_rest_emitsQuoteRested() public {
        vm.expectEmit(true, false, false, true, address(fq));
        emit FirmQuote.QuoteRested(1, 0, 500000, 1000000, EXPIRY_NS);
        fq.rest(0, 500000, 1000000, EXPIRY_NS);
    }

    // ---- the lock: no withdrawal path exists ------------------------------

    function test_lock_sweepRevertsBeforeUnlock() public {
        vm.warp(UNLOCK - 1);
        vm.expectRevert(abi.encodeWithSelector(FirmQuote.Locked.selector, UNLOCK, uint64(UNLOCK - 1)));
        fq.sweep();
    }

    function test_lock_sweepRevertsForStrangerEvenAfterUnlock() public {
        vm.warp(UNLOCK + 1);
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(FirmQuote.NotDepositor.selector, STRANGER, address(this)));
        fq.sweep();
    }

    /// @dev The product is what is ABSENT. If any of these selectors ever exists,
    ///      the quote is no longer firm and Rampart has no claim.
    function test_lock_noCancelSelector() public view { _assertNoFunction("cancel()"); }
    function test_lock_noCancelOrderSelector() public view { _assertNoFunction("cancelOrder(uint128)"); }
    function test_lock_noReduceOrderSelector() public view { _assertNoFunction("reduceOrder(uint128,uint256)"); }
    function test_lock_noSetOperatorSelector() public view { _assertNoFunction("setOperator(address,bool)"); }
    function test_lock_noApproveBuilderSelector() public view { _assertNoFunction("approveBuilder(address,uint256)"); }
    function test_lock_noRescueSelector() public view { _assertNoFunction("rescue(address,uint256)"); }
    function test_lock_noWithdrawSelector() public view { _assertNoFunction("withdraw(address,uint256)"); }

    function _assertNoFunction(string memory sig) internal view {
        (bool ok,) = address(fq).staticcall(abi.encodeWithSignature(sig));
        assertFalse(ok, string.concat("FirmQuote must not expose ", sig));
    }

    // ---- sweeping after unlock -------------------------------------------

    function test_sweep_afterUnlockReturnsBalanceToDepositor() public {
        vm.warp(UNLOCK);
        uint256 before = token.balanceOf(address(this));
        fq.sweep();
        assertEq(token.balanceOf(address(this)), before + 1_000_000);
        assertEq(token.balanceOf(address(fq)), 0);
    }

    function test_sweep_drainsPoolVaultFirst() public {
        pool.setVaultBalance(500);
        vm.warp(UNLOCK);
        fq.sweep();
        assertTrue(pool.withdrawCalled());
        assertEq(token.balanceOf(address(this)), 1_000_500);
    }

    function test_sweep_skipsVaultWhenEmpty() public {
        vm.warp(UNLOCK);
        fq.sweep();
        assertFalse(pool.withdrawCalled());
    }

    function test_sweep_toleratesZeroBalance() public {
        vm.warp(UNLOCK);
        fq.sweep();
        fq.sweep(); // second sweep is a no-op, not a revert
    }

    function test_sweep_revertsIfTransferReturnsFalse() public {
        token.setTransferReturns(false);
        vm.warp(UNLOCK);
        vm.expectRevert(FirmQuote.SweepTransferFailed.selector);
        fq.sweep();
    }

    function test_sweep_emitsSwept() public {
        vm.warp(UNLOCK);
        vm.expectEmit(false, false, false, true, address(fq));
        emit FirmQuote.Swept(1_000_000);
        fq.sweep();
    }

    function test_sweep_exactlyAtUnlockIsAllowed() public {
        vm.warp(UNLOCK);
        fq.sweep();
    }


    function test_lock_rejectsStrayEther() public {
        // No receive/fallback: the contract cannot be made to hold value it has
        // no path to release, and cannot be griefed into a nonzero ETH balance.
        (bool ok,) = address(fq).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_orders_outOfBoundsReverts() public {
        vm.expectRevert();
        fq.orders(0);
    }

    function test_twoQuotesOnSamePoolAreIndependent() public {
        FirmQuote other = new FirmQuote(address(pool), UNLOCK);
        fq.rest(0, 500000, 1000000, EXPIRY_NS);
        assertEq(fq.orderCount(), 1);
        assertEq(other.orderCount(), 0);
        assertTrue(address(other) != address(fq));
    }

    // ---- fuzz -------------------------------------------------------------

    function testFuzz_rest_onlyBuyKindsAccepted(uint8 kind) public {
        if (kind == 0 || kind == 2) {
            fq.rest(kind, 500000, 1000000, EXPIRY_NS);
            assertEq(fq.orderCount(), 1);
        } else {
            vm.expectRevert("buy-side only");
            fq.rest(kind, 500000, 1000000, EXPIRY_NS);
        }
    }

    function testFuzz_sweep_lockedForAnyTimeBeforeUnlock(uint64 t) public {
        t = uint64(bound(t, 1, UNLOCK - 1));
        vm.warp(t);
        vm.expectRevert(abi.encodeWithSelector(FirmQuote.Locked.selector, UNLOCK, t));
        fq.sweep();
    }

    function testFuzz_rest_neverCallableByNonDepositor(address caller) public {
        vm.assume(caller != address(this));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(FirmQuote.NotDepositor.selector, caller, address(this)));
        fq.rest(0, 500000, 1000000, EXPIRY_NS);
    }

    function testFuzz_rest_forwardsAnyPriceAndQuantity(uint256 price, uint256 qty) public {
        fq.rest(0, price, qty, EXPIRY_NS);
        assertEq(pool.lastPrice(), price);
        assertEq(pool.lastQuantity(), qty);
    }
}
