// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FirmQuote} from "../src/FirmQuote.sol";
import {MockBinaryPool, MockERC20} from "./FirmQuote.t.sol";

/// @title Symbolic proofs — the lock, PROVEN rather than sampled
/// @notice Run with `halmos --match-contract FirmQuoteSymbolic` (see `npm run prove`).
///         `forge test` ignores this file: Foundry runs `test*`, halmos runs `check_*`.
///
/// @dev WHY THIS EXISTS ALONGSIDE THE INVARIANT SUITE. The invariant campaign explores
///      128k concrete call sequences — a lot, but still samples. These `check_` functions
///      are symbolically executed: halmos solves over EVERY `address` and EVERY `uint64`
///      timestamp at once and reports a counterexample if one exists. For a property
///      whose whole value is "there is no such caller and no such moment", sampling can
///      only ever fail to find one. This can show there is none.
///
///      MUTATION-VERIFIED 2026-08-26. A `sweep()` carrying an off-by-one
///      (`>= unlockAt - 1` instead of `>= unlockAt`) was run against
///      `check_sweepRevertsForEveryCallerBeforeUnlock`. Halmos returned:
///          Counterexample: p_nowTs_uint64 = 0x773593ff   (= 1_999_999_999 = UNLOCK - 1)
///      It located the single leaking second in a 2-billion-second range. That is the
///      argument for proving instead of sampling, in one line of output.
///
///      Scope, stated honestly: these prove properties of `FirmQuote`'s own logic against
///      the mock pool and mock token. They do not prove anything about the real
///      `BinaryPool`, which is external code we do not control — that is what the
///      on-chain gate transaction is for. Nor do they touch the off-chain classifier,
///      whose own limits are documented in DEMO.md under "Honest limits".
contract FirmQuoteSymbolicTest is Test {
    MockERC20 internal token;
    MockBinaryPool internal pool;
    FirmQuote internal q;

    uint64 internal constant EXPIRY_NS = 2_000_000_000 * 1e9;
    uint64 internal constant UNLOCK = 2_000_000_000;

    function setUp() public {
        token = new MockERC20();
        pool = new MockBinaryPool(address(token), EXPIRY_NS);
        q = new FirmQuote(address(pool), UNLOCK); // depositor == this contract
        token.mint(address(q), 1_000_000);
    }

    /// THE LOCK. For EVERY caller and EVERY timestamp strictly before `unlockAt`,
    /// `sweep()` reverts. This is the commitment the whole product rests on, and it is
    /// the one statement that benefits most from being proven rather than sampled:
    /// a fuzzer that never happens to try the one address that works proves nothing.
    function check_sweepRevertsForEveryCallerBeforeUnlock(address caller, uint64 nowTs) public {
        vm.assume(nowTs < UNLOCK);
        vm.warp(nowTs);
        vm.prank(caller);
        (bool ok,) = address(q).call(abi.encodeWithSignature("sweep()"));
        assert(!ok);
    }

    /// The depositor is the ONLY account that may rest, for every possible argument.
    function check_restRejectsEveryNonDepositor(address caller, uint8 kind, uint256 price, uint256 qty, uint64 exp)
        public
    {
        vm.assume(caller != q.depositor());
        vm.prank(caller);
        (bool ok,) = address(q).call(abi.encodeWithSignature("rest(uint8,uint256,uint256,uint64)", kind, price, qty, exp));
        assert(!ok);
    }

    /// Buy-side only, for every `kind` outside {0, 2}. The absence of a sell path is what
    /// keeps the contract from ever needing an ERC-6909 operator grant — and an operator
    /// grant is precisely the escape the adversarial corpus is built around.
    function check_restRejectsEverySellKind(uint8 kind, uint256 price, uint256 qty, uint64 exp) public {
        vm.assume(kind != 0 && kind != 2);
        (bool ok,) = address(q).call(abi.encodeWithSignature("rest(uint8,uint256,uint256,uint64)", kind, price, qty, exp));
        assert(!ok);
    }

    /// Resting cannot pay the depositor. Escrow flows OUT to the pool; nothing comes back.
    function check_restNeverPaysTheDepositor(uint8 kind, uint256 price, uint256 qty, uint64 exp) public {
        address dep = q.depositor();
        uint256 before = token.balanceOf(dep);
        (bool ok,) = address(q).call(abi.encodeWithSignature("rest(uint8,uint256,uint256,uint64)", kind, price, qty, exp));
        ok; // either outcome is fine; the balance claim must hold regardless
        assert(token.balanceOf(dep) <= before);
    }

    /// The immutables cannot be moved by any call, from any caller, with any payload.
    /// If `unlockAt` or `depositor` could shift, every proof above would be vacuous.
    function check_immutablesAreUnreachable(address caller, bytes4 selector, bytes memory payload) public {
        uint64 u0 = q.unlockAt();
        address d0 = q.depositor();
        vm.prank(caller);
        (bool ok,) = address(q).call(abi.encodePacked(selector, payload));
        ok;
        assert(q.unlockAt() == u0);
        assert(q.depositor() == d0);
    }
}
