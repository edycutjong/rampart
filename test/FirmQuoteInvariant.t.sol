// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {FirmQuote} from "../src/FirmQuote.sol";
import {MockBinaryPool, MockERC20} from "./FirmQuote.t.sol";

/// @title Invariant suite — the security property is an ABSENCE, so fuzz the whole surface
/// @notice The unit tests assert that seven specific withdrawal selectors do not exist.
///         That is a test of the selectors we thought of. This suite is the complement:
///         it throws ARBITRARY calldata at the contract, from arbitrary callers, at
///         arbitrary times before `unlockAt`, and asserts the depositor is never paid.
///
/// @dev HOW THE CALL SURFACE IS EXPLORED, and why the obvious approach does not work.
///      Fuzzing a raw `bytes4` is useless here: the space is 2^32, so 128k calls have a
///      ~0.003% chance of ever landing on a given function. A mutation test proved it —
///      a `FirmQuote` variant with a planted `poke()` payout PASSED a random-selector
///      campaign, because the fuzzer never guessed `poke`'s selector.
///
///      So `pokeDispatch` draws from the selectors the contract ACTUALLY EXPOSES,
///      recovered by disassembling its deployed runtime bytecode and collecting every
///      PUSH4 immediate (the same technique `script/lib/analyzer.mjs` uses off-chain).
///      That covers undeclared entry points too — a hidden cancel path has to appear in
///      the dispatch table to be callable, so it appears in this list.
///
///      MUTATION-VERIFIED 2026-08-26. A `FirmQuote` variant carrying one extra method,
///      `poke() { collateral.transfer(depositor, balance); }`, was run against this
///      handler. It fails immediately:
///          [FAIL: collateral reached the depositor before unlockAt: 1000000 > 0]
///      The same mutant PASSED the earlier random-bytes4 version. That is the difference
///      between a suite that tests the contract and one that only looks like it does.
///
///      WHY "the depositor is never paid" rather than "the balance never falls": the
///      contract's balance legitimately falls when the POOL pulls buy-side escrow at
///      placement — that is the money going into the book, which is the point. A
///      withdrawal is money coming back OUT to the funder, and that is what must be
///      impossible before `unlockAt`.
contract FirmQuoteHandler is Test {
    FirmQuote public immutable q;
    MockBinaryPool public immutable pool;
    MockERC20 public immutable token;
    address public immutable depositor;
    uint64 public immutable unlockAt;
    uint256 public immutable depositorStartBalance;

    uint256 public restCalls;
    uint256 public restsAccepted;
    uint256 public sweepAttempts;
    uint256 public rawCalls;
    uint256 public rawAccepted;

    address[3] internal actors;
    /// Selectors recovered from the deployed runtime bytecode — the real call surface.
    bytes4[] public selectors;

    constructor(FirmQuote _q, MockBinaryPool _pool, MockERC20 _token, address _depositor, uint64 _unlockAt) {
        q = _q;
        pool = _pool;
        token = _token;
        depositor = _depositor;
        unlockAt = _unlockAt;
        depositorStartBalance = _token.balanceOf(_depositor);
        // actors[0] is the depositor — the ONE account with privileges. If even the
        // owner cannot extract before unlock, nobody can.
        actors = [_depositor, address(0xA77ACC), address(0xDEAD)];
        selectors = _extractSelectors(address(_q).code);
        require(selectors.length > 0, "no selectors recovered - the campaign would be blind");
    }

    function selectorsLength() external view returns (uint256) { return selectors.length; }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// Time may advance, never to or past the unlock: the whole campaign runs inside
    /// the window where the lock is supposed to hold.
    function _warpBounded(uint256 dt) internal {
        uint256 next = block.timestamp + (dt % 30 days);
        if (next >= unlockAt) next = unlockAt - 1;
        vm.warp(next);
    }

    /// Unbounded: any actor, any kind. Mostly rejected — that is the point, it probes
    /// the guard. Left in so the campaign keeps attacking `rest` itself.
    function restQuote(uint256 actorSeed, uint8 kind, uint256 price, uint256 qty, uint64 expiry, uint256 dt)
        external
    {
        _warpBounded(dt);
        restCalls++;
        vm.prank(_actor(actorSeed));
        try q.rest(kind, price, qty, expiry) { restsAccepted++; } catch {}
    }

    /// Bounded to arguments that are actually valid, so the HAPPY PATH is reachable.
    /// Without this the campaign is ~0.26% likely to land a successful rest per call
    /// (right actor AND kind in {0,2}), so most runs would leave the contract holding
    /// no orders at all and the other invariants would hold for a trivial reason.
    function restQuoteValid(uint256 price, uint256 qty, uint64 expiry, uint256 dt) external {
        _warpBounded(dt);
        restCalls++;
        uint8 kind = (price % 2 == 0) ? 0 : 2; // BUY_YES / BUY_NO
        vm.prank(depositor);
        try q.rest(kind, bound(price, 1, 1e6), bound(qty, 1, 1e6), expiry) { restsAccepted++; } catch {}
    }

    function attemptSweep(uint256 actorSeed, uint256 dt) external {
        _warpBounded(dt);
        sweepAttempts++;
        vm.prank(_actor(actorSeed));
        try q.sweep() {} catch {}
    }

    /// THE IMPORTANT ONE. Calls a selector the contract genuinely dispatches on, with a
    /// fuzzed payload, from a fuzzed actor, at a fuzzed time before unlock. Not limited
    /// to the declared ABI — the list comes from the bytecode, not the interface.
    function pokeDispatch(uint256 actorSeed, uint256 selIdx, bytes calldata payload, uint256 dt) external {
        _warpBounded(dt);
        rawCalls++;
        bytes4 sel = selectors[selIdx % selectors.length];
        vm.prank(_actor(actorSeed));
        (bool ok,) = address(q).call(abi.encodePacked(sel, payload));
        if (ok) rawAccepted++;
    }

    /// Still fuzz fully-random selectors as well — cheap, and it covers a fallback
    /// function, which by definition is NOT in the dispatch table.
    function pokeRandom(uint256 actorSeed, bytes4 selector, bytes calldata payload, uint256 dt) external {
        _warpBounded(dt);
        rawCalls++;
        vm.prank(_actor(actorSeed));
        (bool ok,) = address(q).call(abi.encodePacked(selector, payload));
        if (ok) rawAccepted++;
    }

    /// Every PUSH4 immediate in the runtime bytecode. PUSH immediates are skipped so a
    /// constant that merely contains 0x63 is not misread as an opcode — the same
    /// correctness requirement the off-chain disassembler has.
    function _extractSelectors(bytes memory code) internal pure returns (bytes4[] memory out) {
        bytes4[] memory buf = new bytes4[](256);
        uint256 n;
        for (uint256 i; i < code.length;) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                uint256 imm = op - 0x5f;
                if (op == 0x63 && i + 4 < code.length && n < buf.length) {
                    buf[n++] = bytes4(
                        bytes4(code[i + 1]) | (bytes4(code[i + 2]) >> 8)
                            | (bytes4(code[i + 3]) >> 16) | (bytes4(code[i + 4]) >> 24)
                    );
                }
                i += 1 + imm;
            } else {
                i += 1;
            }
        }
        out = new bytes4[](n);
        for (uint256 k; k < n; ++k) out[k] = buf[k];
    }

    /// Give the pool a vault credit so `sweep`'s withdraw branch is reachable at all —
    /// otherwise that branch is trivially dead for the whole campaign.
    function fundPoolVault(uint256 amount) external {
        pool.setVaultBalance(amount % 1e24);
    }

    /// More collateral arriving must not create a withdrawal path either.
    function fundContract(uint256 amount) external {
        token.mint(address(q), amount % 1e24);
    }
}

contract FirmQuoteInvariantTest is Test {
    MockERC20 internal token;
    MockBinaryPool internal pool;
    FirmQuote internal q;
    FirmQuoteHandler internal handler;

    uint64 internal constant EXPIRY_NS = 2_000_000_000 * 1e9;
    uint64 internal constant UNLOCK = 2_000_000_000;

    function setUp() public {
        vm.warp(1_000_000_000); // well before UNLOCK
        token = new MockERC20();
        pool = new MockBinaryPool(address(token), EXPIRY_NS);
        q = new FirmQuote(address(pool), UNLOCK); // depositor == this test contract
        token.mint(address(q), 1_000_000);

        handler = new FirmQuoteHandler(q, pool, token, address(this), UNLOCK);
        targetContract(address(handler));
    }

    /// THE INVARIANT. Before `unlockAt`, no sequence of calls — in the ABI or not, from
    /// any caller, at any time — may increase the depositor's collateral balance.
    function invariant_depositorIsNeverPaidBeforeUnlock() public view {
        assertLt(block.timestamp, UNLOCK, "campaign escaped the lock window");
        assertLe(
            token.balanceOf(handler.depositor()),
            handler.depositorStartBalance(),
            "collateral reached the depositor before unlockAt"
        );
    }

    /// Append-only, and exactly one entry per accepted rest. A shorter log would mean a
    /// removal path exists; a longer one would mean an entry appeared without a rest.
    function invariant_orderLogIsAppendOnly() public view {
        assertEq(q.orderCount(), handler.restsAccepted(), "orders array is not append-only");
    }

    /// Immutables are the anchor the whole claim rests on: if any could move, an attacker
    /// could re-point the lock or the beneficiary.
    function invariant_immutablesNeverMove() public view {
        assertEq(q.unlockAt(), UNLOCK, "unlockAt moved");
        assertEq(q.depositor(), handler.depositor(), "depositor moved");
        assertEq(address(q.pool()), address(pool), "pool moved");
        assertEq(address(q.collateral()), address(token), "collateral moved");
    }

    /// Runs once after the campaign. Two jobs:
    ///   1. VACUITY GUARD. A campaign that never reached the contract would pass every
    ///      invariant above for the wrong reason (LESSONS R10: a check that cannot fail
    ///      is not a check). This cannot live in an `invariant_` function — Foundry
    ///      evaluates those once before the first run too, when the counters are still 0.
    ///   2. Prints the campaign's real coverage so it is auditable, not asserted. -vv.
    function afterInvariant() public view {
        console.log("rest calls      ", handler.restCalls(), "accepted", handler.restsAccepted());
        console.log("sweep attempts  ", handler.sweepAttempts());
        console.log("raw fuzzed calls", handler.rawCalls(), "accepted", handler.rawAccepted());
        console.log("dispatch selectors recovered from bytecode:", handler.selectorsLength());
        assertGt(handler.restCalls() + handler.sweepAttempts() + handler.rawCalls(), 0, "handler never ran");
        assertGt(handler.restsAccepted(), 0, "no rest ever succeeded - the campaign never exercised the happy path");
        assertGt(handler.rawCalls(), 0, "the dispatch surface was never probed");
        // NOTE: rawAccepted is reported, never asserted to be 0. Accepting a call is not
        // the defect — FirmQuote's view functions (depositor, pool, collateral, unlockAt,
        // orders, orderCount) all succeed for any caller and always should. The defect
        // would be a call that MOVES COLLATERAL, and that is what
        // invariant_depositorIsNeverPaidBeforeUnlock tests, on every one of these calls.
    }
}
