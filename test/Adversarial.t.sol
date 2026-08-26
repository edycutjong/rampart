// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FirmQuote} from "../src/FirmQuote.sol";
import {HiddenCancel} from "../src/adversarial/HiddenCancel.sol";
import {QuietReduce} from "../src/adversarial/QuietReduce.sol";
import {OperatorGranter} from "../src/adversarial/OperatorGranter.sol";
import {DelegateEscape, EscapeLogic} from "../src/adversarial/DelegateEscape.sol";
import {BatchCancel} from "../src/adversarial/BatchCancel.sol";
import {QuoteBase} from "../src/adversarial/QuoteBase.sol";
import {
    Erc1967Proxy, ProxyLogicFirm, ProxyLogicEvil
} from "../src/adversarial/Erc1967Proxy.sol";

/// @dev These tests prove each attacker's escape ACTUALLY WORKS against a pool
///      that enforces ownership exactly as the real BinaryPool does — the order
///      leaves the book with no fill. That is what makes the classifier's
///      UNVERIFIED verdict correct rather than paranoid. The on-chain twins of
///      these escapes (real Shannon transactions) are in DEMO.md; these are the
///      deterministic, offline proof of the same mechanics.
///
///      The control is `test_firmQuote_hasNoEscape`: the honest contract exposes
///      none of the escape surfaces, so its resting order cannot be pulled.

address constant SHANNON_OP_REGISTRY = 0x15C7e8CE38F021c5b45d098AaD788f63090bF20A;
bytes4 constant CANCEL_ORDER_FOR = 0xe37b444b;

contract MockMarket {
    address public collateral;

    constructor(address c) {
        collateral = c;
    }
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

/// @dev The per-user operator grant registry, minimal but faithful: an owner can
///      approve an operator for a selector on a pool, and the pool checks it.
contract MockOperatorRegistry {
    mapping(bytes32 => bool) public approved;

    function _key(address pool, address owner, address op, bytes4 sel) internal pure returns (bytes32) {
        return keccak256(abi.encode(pool, owner, op, sel));
    }

    function setOperatorApprovalForPool(address pool, address op, bytes4[] calldata sels, bool ok) external {
        for (uint256 i; i < sels.length; ++i) {
            approved[_key(pool, msg.sender, op, sels[i])] = ok;
        }
    }

    /// @dev Global grants are stored under a sentinel pool address; our MockPool
    ///      only consults the per-pool grant, so this just needs to not revert.
    function setOperatorApprovalGlobal(address op, bytes4[] calldata sels, bool ok) external {
        for (uint256 i; i < sels.length; ++i) {
            approved[_key(address(0), msg.sender, op, sels[i])] = ok;
        }
    }

    function isApprovedForPool(address pool, address owner, address op, bytes4 sel) external view returns (bool) {
        return approved[_key(pool, owner, op, sel)];
    }
}

/// @dev A pool that enforces order ownership like the real BinaryPool: direct
///      cancel/reduce require the owner; the `...For` route requires a per-user
///      operator grant in the registry.
contract MockPool {
    struct Order {
        address owner;
        uint256 remaining;
        bool active;
    }

    address public market;
    address public collateral;
    MockOperatorRegistry public registry;
    mapping(uint128 => Order) public orders;
    uint128 public nextId = 1;

    error IncorrectSender(address caller, address expected);
    error OnlyApprovedContracts();

    constructor(address _collateral, MockOperatorRegistry _registry) {
        collateral = _collateral;
        registry = _registry;
        market = address(new MockMarket(_collateral));
    }

    function placeBinaryOrder(uint8, uint256, uint256 quantity, uint64, uint8, uint8, address, uint96, uint64)
        external
        payable
        returns (bool, uint128)
    {
        uint128 id = nextId++;
        orders[id] = Order({owner: msg.sender, remaining: quantity, active: true});
        return (true, id);
    }

    function cancelOrder(uint128 id) external {
        Order storage o = orders[id];
        if (msg.sender != o.owner) revert IncorrectSender(msg.sender, o.owner);
        o.active = false;
        o.remaining = 0;
    }

    /// @dev Best-effort batch cancel: skips orders the caller does not own,
    ///      cancels the ones it does — faithful to the real pool's semantics.
    function cancelOrders(uint128[] calldata ids) external {
        for (uint256 i; i < ids.length; ++i) {
            Order storage o = orders[ids[i]];
            if (o.owner == msg.sender) {
                o.active = false;
                o.remaining = 0;
            }
        }
    }

    function reduceOrder(uint128 id, uint256 newRemaining) external {
        Order storage o = orders[id];
        if (msg.sender != o.owner) revert IncorrectSender(msg.sender, o.owner);
        o.remaining = newRemaining;
    }

    function cancelOrderFor(address owner, uint128 id) external {
        if (!registry.isApprovedForPool(address(this), owner, msg.sender, CANCEL_ORDER_FOR)) {
            revert OnlyApprovedContracts();
        }
        Order storage o = orders[id];
        require(o.owner == owner, "owner mismatch");
        o.active = false;
        o.remaining = 0;
    }

    function isActive(uint128 id) external view returns (bool) {
        return orders[id].active;
    }

    function remainingOf(uint128 id) external view returns (uint256) {
        return orders[id].remaining;
    }

    function getWithdrawableBalance(address, address) external pure returns (uint256) {
        return 0;
    }

    function withdraw(address, uint256) external {}
}

contract AdversarialTest is Test {
    MockERC20 token;
    MockOperatorRegistry registry;
    MockPool pool;

    uint64 constant UNLOCK = 4_000_000_000;
    uint256 constant QTY = 2_000_000;
    address constant ATTACKER_EOA = address(0xA77ACC);

    function setUp() public {
        token = new MockERC20();
        registry = new MockOperatorRegistry();
        // OperatorGranter hardcodes the Shannon registry address — place the mock there.
        vm.etch(SHANNON_OP_REGISTRY, address(registry).code);
        pool = new MockPool(address(token), MockOperatorRegistry(SHANNON_OP_REGISTRY));
        token.mint(address(this), 100_000_000);
    }

    function _fund(address c) internal {
        token.mint(c, 10_000_000);
    }

    // ---- the control: FirmQuote cannot escape ----------------------------

    function test_firmQuote_hasNoEscape() public {
        FirmQuote fq = new FirmQuote(address(pool), UNLOCK);
        _fund(address(fq));
        uint128 id = fq.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        assertTrue(pool.isActive(id));
        // No poke/escape/trim/openBackDoor surface exists — assert each is absent.
        bytes4[5] memory escapes = [
            bytes4(0x18178358), // poke()
            bytes4(0x9cb6ed7e), // escape(address)
            bytes4(0xd7f032e1), // trim(uint256)
            bytes4(0x02e53eac), // openBackDoor(address)
            bytes4(0x5beeaed7) //  tidy()
        ];
        for (uint256 i; i < escapes.length; ++i) {
            (bool ok,) = address(fq).call(abi.encodeWithSelector(escapes[i], address(0)));
            assertFalse(ok, "FirmQuote must expose no escape surface");
        }
        // The order is still active and full — nothing pulled it.
        assertTrue(pool.isActive(id));
        assertEq(pool.remainingOf(id), QTY);
    }

    // ---- A1 hidden cancel -------------------------------------------------

    function test_A1_hiddenCancel_pullsTheOrder() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        _fund(address(a));
        uint128 id = a.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        assertTrue(pool.isActive(id));
        a.poke(); // the escape
        assertFalse(pool.isActive(id)); // depth vanished, no fill
    }

    // ---- A2 upgradeable proxy --------------------------------------------

    function test_A2_proxyUpgrade_pullsTheOrder() public {
        ProxyLogicFirm v1 = new ProxyLogicFirm();
        ProxyLogicEvil v2 = new ProxyLogicEvil();
        Erc1967Proxy proxy = new Erc1967Proxy(address(v1), address(this));

        ProxyLogicFirm(address(proxy)).init(address(pool), UNLOCK);
        _fund(address(proxy));
        ProxyLogicFirm(address(proxy)).rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        uint128 id = uint128(ProxyLogicFirm(address(proxy)).orders(0));
        assertTrue(pool.isActive(id));

        proxy.upgradeTo(address(v2)); // same address, same code hash, new behaviour
        ProxyLogicEvil(address(proxy)).pull(); // the escape
        assertFalse(pool.isActive(id));
    }

    // ---- A3 delegatecall escape ------------------------------------------

    function test_A3_delegateEscape_pullsTheOrder() public {
        DelegateEscape a = new DelegateEscape(address(pool), UNLOCK);
        EscapeLogic logic = new EscapeLogic();
        _fund(address(a));
        uint128 id = a.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        assertTrue(pool.isActive(id));
        a.escape(address(logic)); // the escape
        assertFalse(pool.isActive(id));
    }

    // ---- A4 late operator grant ------------------------------------------

    function test_A4_operatorGranter_pullsViaEoa() public {
        OperatorGranter a = new OperatorGranter(address(pool), UNLOCK);
        _fund(address(a));
        uint128 id = a.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        assertTrue(pool.isActive(id));

        // Before the grant, the EOA cannot cancelOrderFor.
        vm.prank(ATTACKER_EOA);
        vm.expectRevert(MockPool.OnlyApprovedContracts.selector);
        pool.cancelOrderFor(address(a), id);

        a.openBackDoor(ATTACKER_EOA); // the escape: grant the EOA the right
        vm.prank(ATTACKER_EOA);
        pool.cancelOrderFor(address(a), id); // now it works
        assertFalse(pool.isActive(id));
    }

    // ---- A1' batch cancel via alternate selector --------------------------

    function test_A1b_batchCancel_pullsViaAlternateSelector() public {
        BatchCancel a = new BatchCancel(address(pool), UNLOCK);
        _fund(address(a));
        uint128 id = a.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        assertTrue(pool.isActive(id));
        a.tidy(); // the escape: cancelOrders([id]) — a DIFFERENT selector than cancelOrder
        assertFalse(pool.isActive(id));
    }

    // ---- A5 quiet reduce --------------------------------------------------

    function test_A5_quietReduce_shrinksDepthWithoutFill() public {
        QuietReduce a = new QuietReduce(address(pool), UNLOCK);
        _fund(address(a));
        uint128 id = a.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        assertEq(pool.remainingOf(id), QTY);
        a.trim(1_000_000); // the escape: shrink 2,000,000 -> 1,000,000, no fill
        assertEq(pool.remainingOf(id), 1_000_000);
        assertTrue(pool.isActive(id)); // technically survives; the depth it advertised did not
    }

    // ---- QuoteBase: the camouflage's own surface ---------------------------
    //
    // These do not prove an escape — they cover the honest-looking half every
    // attacker inherits. Left untested, `QuoteBase` sat at 14% branch coverage
    // (2026-08-26 audit, F-9), which meant the corpus's *shared* code was the
    // least-exercised code in the repo. Uses HiddenCancel as an arbitrary
    // concrete subclass; the behaviour under test is entirely QuoteBase's.

    function test_quoteBase_restRejectsSellSide() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        _fund(address(a));
        vm.expectRevert(bytes("buy-side only"));
        a.rest(1, 10000, QTY, uint64(block.timestamp + 1000)); // kind 1 == sell
    }

    function test_quoteBase_restRejectsUnknownKind() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        _fund(address(a));
        vm.expectRevert(bytes("buy-side only"));
        a.rest(7, 10000, QTY, uint64(block.timestamp + 1000));
    }

    function test_quoteBase_restOnlyDepositor() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        _fund(address(a));
        vm.prank(ATTACKER_EOA);
        vm.expectRevert(
            abi.encodeWithSelector(QuoteBase.NotDepositor.selector, ATTACKER_EOA, address(this))
        );
        a.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
    }

    function test_quoteBase_restRevertsWhenPoolReportsFailure() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        _fund(address(a));
        // Make the pool report a failed placement without reverting.
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(MockPool.placeBinaryOrder.selector),
            abi.encode(false, uint128(0))
        );
        vm.expectRevert(QuoteBase.PlacementFailed.selector);
        a.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        vm.clearMockedCalls();
    }

    function test_quoteBase_orderCountTracksRests() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        _fund(address(a));
        assertEq(a.orderCount(), 0);
        a.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        assertEq(a.orderCount(), 1);
        a.rest(2, 10000, QTY, uint64(block.timestamp + 1000));
        assertEq(a.orderCount(), 2);
    }

    function test_quoteBase_sweepIsLockedBeforeUnlock() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        _fund(address(a));
        vm.expectRevert(
            abi.encodeWithSelector(QuoteBase.Locked.selector, UNLOCK, uint64(block.timestamp))
        );
        a.sweep();
    }

    function test_quoteBase_sweepOnlyDepositor() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        vm.warp(UNLOCK);
        vm.prank(ATTACKER_EOA);
        vm.expectRevert(
            abi.encodeWithSelector(QuoteBase.NotDepositor.selector, ATTACKER_EOA, address(this))
        );
        a.sweep();
    }

    function test_quoteBase_sweepDrainsVaultThenBalance() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        _fund(address(a)); // 10,000,000 sitting on the contract
        // Report a non-zero pool-vault credit so the `vaulted > 0` branch runs.
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(MockPool.getWithdrawableBalance.selector),
            abi.encode(uint256(5_000_000))
        );
        uint256 before = token.balanceOf(address(this));
        vm.warp(UNLOCK);
        a.sweep();
        vm.clearMockedCalls();
        // Both branches ran: the vault withdraw was attempted and the balance swept home.
        assertEq(token.balanceOf(address(a)), 0, "contract balance must be swept");
        assertEq(token.balanceOf(address(this)), before + 10_000_000);
    }

    function test_quoteBase_sweepToleratesEmptyContract() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        vm.warp(UNLOCK); // never funded: both `vaulted > 0` and `bal > 0` are false
        a.sweep();
        assertEq(token.balanceOf(address(a)), 0);
    }

    function test_quoteBase_sweepExactlyAtUnlockIsAllowed() public {
        HiddenCancel a = new HiddenCancel(address(pool), UNLOCK);
        vm.warp(UNLOCK); // boundary: `block.timestamp < unlockAt` is false
        a.sweep();
    }

    // ---- DelegateEscape: the revert-reason bubbling ------------------------

    function test_delegateEscape_bubblesLongRevertString() public {
        DelegateEscape a = new DelegateEscape(address(pool), UNLOCK);
        _fund(address(a));
        a.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        // RevertingLogic reverts with a >68-byte string, so `_reason` takes the
        // abi.decode arm and the original message survives the delegatecall.
        RevertingLogic bad = new RevertingLogic();
        vm.expectRevert(bytes(LONG_REASON));
        a.escape(address(bad));
    }

    function test_delegateEscape_fallsBackWhenReasonIsShort() public {
        DelegateEscape a = new DelegateEscape(address(pool), UNLOCK);
        _fund(address(a));
        a.rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        // An EOA target: delegatecall to a codeless address returns empty data,
        // so `ret.length < 68` and `_reason` takes the "delegate failed" arm.
        SilentRevertLogic quiet = new SilentRevertLogic();
        vm.expectRevert(bytes("delegate failed"));
        a.escape(address(quiet));
    }

    // ---- Erc1967Proxy: the shell's own surface -----------------------------

    function test_proxy_upgradeToRejectsNonAdmin() public {
        ProxyLogicFirm v1 = new ProxyLogicFirm();
        Erc1967Proxy proxy = new Erc1967Proxy(address(v1), address(this));
        vm.prank(ATTACKER_EOA);
        vm.expectRevert(bytes("not admin"));
        proxy.upgradeTo(address(0xBEEF));
    }

    function test_proxy_implementationGetterTracksUpgrade() public {
        ProxyLogicFirm v1 = new ProxyLogicFirm();
        ProxyLogicEvil v2 = new ProxyLogicEvil();
        Erc1967Proxy proxy = new Erc1967Proxy(address(v1), address(this));
        assertEq(proxy.implementation(), address(v1));
        proxy.upgradeTo(address(v2));
        assertEq(proxy.implementation(), address(v2));
        // The shell's runtime code — and so its EXTCODEHASH — is unchanged by the
        // upgrade. That is precisely why hashing a proxy commits to nothing.
    }

    function test_proxy_initCannotBeCalledTwice() public {
        ProxyLogicFirm v1 = new ProxyLogicFirm();
        Erc1967Proxy proxy = new Erc1967Proxy(address(v1), address(this));
        ProxyLogicFirm(address(proxy)).init(address(pool), UNLOCK);
        vm.expectRevert(bytes("init"));
        ProxyLogicFirm(address(proxy)).init(address(pool), UNLOCK);
    }

    function test_proxy_fallbackBubblesRevertFromImplementation() public {
        ProxyLogicFirm v1 = new ProxyLogicFirm();
        ProxyLogicEvil v2 = new ProxyLogicEvil();
        Erc1967Proxy proxy = new Erc1967Proxy(address(v1), address(this));
        ProxyLogicFirm(address(proxy)).init(address(pool), UNLOCK);
        proxy.upgradeTo(address(v2));
        // No order has been rested, so `_orders[_orders.length - 1]` underflows in
        // the implementation. The fallback's `case 0 { revert }` arm must bubble it.
        vm.expectRevert();
        ProxyLogicEvil(address(proxy)).pull();
    }

    function test_proxy_restRejectsSellAndPlacementFailure() public {
        ProxyLogicFirm v1 = new ProxyLogicFirm();
        Erc1967Proxy proxy = new Erc1967Proxy(address(v1), address(this));
        ProxyLogicFirm(address(proxy)).init(address(pool), UNLOCK);
        _fund(address(proxy));

        vm.expectRevert(bytes("buy-side only"));
        ProxyLogicFirm(address(proxy)).rest(1, 10000, QTY, uint64(block.timestamp + 1000));

        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(MockPool.placeBinaryOrder.selector),
            abi.encode(false, uint128(0))
        );
        vm.expectRevert(bytes("placement"));
        ProxyLogicFirm(address(proxy)).rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        vm.clearMockedCalls();
    }

    function test_proxy_storageGettersReadThroughDelegate() public {
        ProxyLogicFirm v1 = new ProxyLogicFirm();
        Erc1967Proxy proxy = new Erc1967Proxy(address(v1), address(this));
        ProxyLogicFirm(address(proxy)).init(address(pool), UNLOCK);
        _fund(address(proxy));

        assertEq(ProxyLogicFirm(address(proxy)).depositor(), address(this));
        assertEq(ProxyLogicFirm(address(proxy)).unlockAt(), UNLOCK);
        assertEq(ProxyLogicFirm(address(proxy)).orderCount(), 0);

        uint128 id = ProxyLogicFirm(address(proxy)).rest(0, 10000, QTY, uint64(block.timestamp + 1000));
        assertEq(ProxyLogicFirm(address(proxy)).orderCount(), 1);
        assertEq(ProxyLogicFirm(address(proxy)).orders(0), id);
    }

    function test_proxy_receiveAcceptsNativeValue() public {
        ProxyLogicFirm v1 = new ProxyLogicFirm();
        Erc1967Proxy proxy = new Erc1967Proxy(address(v1), address(this));
        (bool ok,) = address(proxy).call{value: 1 ether}("");
        assertTrue(ok, "receive() must accept plain value transfers");
        assertEq(address(proxy).balance, 1 ether);
    }

    receive() external payable {}
}

string constant LONG_REASON =
    "delegate target refused: this reason is deliberately longer than sixty-eight bytes so the decoder takes the abi.decode arm";

/// @dev Delegatecall target that reverts with a LONG string — exercises
///      `DelegateEscape._reason`'s `abi.decode` arm.
contract RevertingLogic {
    uint128[] public orders; // storage-layout mirror, as EscapeLogic does

    function pull(address) external pure {
        revert(LONG_REASON);
    }
}

/// @dev Delegatecall target whose `pull` reverts with NO return data — exercises
///      `_reason`'s `ret.length < 68` fallback arm.
contract SilentRevertLogic {
    uint128[] public orders;

    function pull(address) external pure {
        assembly {
            revert(0, 0)
        }
    }
}
