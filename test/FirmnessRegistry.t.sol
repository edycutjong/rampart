// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FirmnessRegistry, Firmness, IFirmQuoteView} from "../src/FirmnessRegistry.sol";

/// @dev A minimal owner that looks firm: exposes only `unlockAt()`.
contract LockedOwner {
    uint64 public unlockAt;

    constructor(uint64 u) {
        unlockAt = u;
    }
}

/// @dev An owner whose `unlockAt()` reverts — must NOT be treated as FIRM.
contract HostileOwner {
    function unlockAt() external pure returns (uint64) {
        revert("no");
    }
}

/// @dev A distinct-bytecode owner used for the UNVERIFIED slot (different code
///      hash than LockedOwner, so attesting one does not attest this).
contract OtherOwner {
    uint64 public unlockAt;
    uint256 public padding = 0xdeadbeef; // perturbs the runtime code hash

    constructor(uint64 u) {
        unlockAt = u;
    }
}

contract FirmnessRegistryTest is Test {
    FirmnessRegistry reg;
    address constant ATTESTER = address(0xA11CE);
    address constant STRANGER = address(0xBEEF);
    uint64 constant FUTURE = 4_000_000_000;
    bytes32 constant RECORD = keccak256("record");

    function setUp() public {
        reg = new FirmnessRegistry(ATTESTER);
    }

    // ---- Firmness library (pure) -----------------------------------------

    function test_lib_eoaIsPullable() public pure {
        assertEq(uint256(Firmness.classify(Firmness.EMPTY_CODEHASH, false, 0, 100)), uint256(Firmness.Class.PULLABLE));
    }

    function test_lib_zeroHashIsPullable() public pure {
        assertEq(uint256(Firmness.classify(bytes32(0), false, 0, 100)), uint256(Firmness.Class.PULLABLE));
    }

    function test_lib_unattestedCodeIsUnverified() public pure {
        assertEq(uint256(Firmness.classify(keccak256("code"), false, FUTURE, 100)), uint256(Firmness.Class.UNVERIFIED));
    }

    function test_lib_attestedInWindowIsFirm() public pure {
        assertEq(uint256(Firmness.classify(keccak256("code"), true, FUTURE, 100)), uint256(Firmness.Class.FIRM));
    }

    function test_lib_attestedButExpiredIsUnverified() public pure {
        // Firmness has a horizon: attested code past its unlock is no longer FIRM.
        assertEq(uint256(Firmness.classify(keccak256("code"), true, 50, 100)), uint256(Firmness.Class.UNVERIFIED));
    }

    function test_lib_attestedButNoUnlockIsUnverified() public pure {
        assertEq(uint256(Firmness.classify(keccak256("code"), true, 0, 100)), uint256(Firmness.Class.UNVERIFIED));
    }

    // ---- attestation access control --------------------------------------

    function test_attest_onlyAttester() public {
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(FirmnessRegistry.NotAttester.selector, STRANGER, ATTESTER));
        reg.attest(keccak256("c"), RECORD);
    }

    function test_attest_marksAttested() public {
        vm.prank(ATTESTER);
        reg.attest(keccak256("c"), RECORD);
        assertTrue(reg.isAttested(keccak256("c")));
        assertEq(reg.attestedCount(), 1);
    }

    function test_attest_rejectsDuplicate() public {
        vm.startPrank(ATTESTER);
        reg.attest(keccak256("c"), RECORD);
        vm.expectRevert(abi.encodeWithSelector(FirmnessRegistry.AlreadyAttested.selector, keccak256("c")));
        reg.attest(keccak256("c"), RECORD);
        vm.stopPrank();
    }

    function test_revoke_onlyAttester() public {
        vm.prank(ATTESTER);
        reg.attest(keccak256("c"), RECORD);
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(FirmnessRegistry.NotAttester.selector, STRANGER, ATTESTER));
        reg.revoke(keccak256("c"));
    }

    function test_revoke_flipsAttestedOff() public {
        vm.startPrank(ATTESTER);
        reg.attest(keccak256("c"), RECORD);
        assertTrue(reg.isAttested(keccak256("c")));
        reg.revoke(keccak256("c"));
        assertFalse(reg.isAttested(keccak256("c")));
        vm.stopPrank();
    }

    function test_revoke_revertsIfUnknown() public {
        vm.prank(ATTESTER);
        vm.expectRevert(abi.encodeWithSelector(FirmnessRegistry.NotFound.selector, keccak256("x")));
        reg.revoke(keccak256("x"));
    }

    function test_reattestAfterRevoke() public {
        vm.startPrank(ATTESTER);
        reg.attest(keccak256("c"), RECORD);
        reg.revoke(keccak256("c"));
        reg.attest(keccak256("c"), RECORD); // allowed again
        assertTrue(reg.isAttested(keccak256("c")));
        assertEq(reg.attestedCount(), 1); // not double-listed
        vm.stopPrank();
    }

    // ---- classify(address) end to end ------------------------------------

    function test_classify_eoaIsPullable() public view {
        (Firmness.Class c,, uint64 fu) = reg.classify(STRANGER);
        assertEq(uint256(c), uint256(Firmness.Class.PULLABLE));
        assertEq(fu, 0);
    }

    function test_classify_unattestedContractIsUnverified() public {
        LockedOwner o = new LockedOwner(FUTURE);
        (Firmness.Class c,,) = reg.classify(address(o));
        assertEq(uint256(c), uint256(Firmness.Class.UNVERIFIED));
    }

    function test_classify_attestedInWindowIsFirm() public {
        LockedOwner o = new LockedOwner(FUTURE);
        bytes32 ch = address(o).codehash;
        vm.prank(ATTESTER);
        reg.attest(ch, RECORD);
        (Firmness.Class c, bytes32 got, uint64 fu) = reg.classify(address(o));
        assertEq(uint256(c), uint256(Firmness.Class.FIRM));
        assertEq(got, ch);
        assertEq(fu, FUTURE);
    }

    function test_classify_attestedButExpiredIsUnverified() public {
        LockedOwner o = new LockedOwner(uint64(block.timestamp + 100));
        vm.prank(ATTESTER);
        reg.attest(address(o).codehash, RECORD);
        vm.warp(block.timestamp + 101);
        (Firmness.Class c,,) = reg.classify(address(o));
        assertEq(uint256(c), uint256(Firmness.Class.UNVERIFIED));
    }

    function test_classify_revokeMakesFirmDepthUnverifiedLive() public {
        LockedOwner o = new LockedOwner(FUTURE);
        bytes32 ch = address(o).codehash;
        vm.startPrank(ATTESTER);
        reg.attest(ch, RECORD);
        vm.stopPrank();
        (Firmness.Class c1,,) = reg.classify(address(o));
        assertEq(uint256(c1), uint256(Firmness.Class.FIRM));
        vm.prank(ATTESTER);
        reg.revoke(ch);
        (Firmness.Class c2,,) = reg.classify(address(o));
        assertEq(uint256(c2), uint256(Firmness.Class.UNVERIFIED)); // no cache — live read
    }

    function test_classify_hostileUnlockAtNeverFirm() public {
        // A contract whose unlockAt() reverts: even if someone attested its hash,
        // the staticcall fails -> firmUntil 0 -> UNVERIFIED, never FIRM.
        HostileOwner o = new HostileOwner();
        vm.prank(ATTESTER);
        reg.attest(address(o).codehash, RECORD);
        (Firmness.Class c,, uint64 fu) = reg.classify(address(o));
        assertEq(fu, 0);
        assertEq(uint256(c), uint256(Firmness.Class.UNVERIFIED));
    }

    // ---- classifyBatch ----------------------------------------------------

    function test_classifyBatch_mixed() public {
        LockedOwner firm = new LockedOwner(FUTURE);
        OtherOwner unver = new OtherOwner(FUTURE); // distinct code hash, never attested
        vm.prank(ATTESTER);
        reg.attest(address(firm).codehash, RECORD); // only `firm`'s hash

        address[] memory owners = new address[](3);
        owners[0] = address(firm);
        owners[1] = address(unver);
        owners[2] = STRANGER;

        (Firmness.Class[] memory classes,, uint64[] memory fus) = reg.classifyBatch(owners);
        assertEq(uint256(classes[0]), uint256(Firmness.Class.FIRM));
        assertEq(uint256(classes[1]), uint256(Firmness.Class.UNVERIFIED));
        assertEq(uint256(classes[2]), uint256(Firmness.Class.PULLABLE));
        assertEq(fus[0], FUTURE);
    }

    function testFuzz_classify_randomEoaAlwaysPullable(address who) public view {
        vm.assume(who.code.length == 0);
        (Firmness.Class c,,) = reg.classify(who);
        assertEq(uint256(c), uint256(Firmness.Class.PULLABLE));
    }
}
