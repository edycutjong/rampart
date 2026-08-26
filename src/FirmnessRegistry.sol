// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The minimum an order owner must expose for a FIRM claim to be checkable.
interface IFirmQuoteView {
    function unlockAt() external view returns (uint64);
    function depositor() external view returns (address);
}

/// @title Firmness — the ternary classification, as pure logic
/// @notice FIRM / PULLABLE / UNVERIFIED from an account's `EXTCODEHASH`.
///
/// @dev THE DEFECT THIS EXISTS TO FIX. The obvious implementation of "is this
///      book level firm?" is `EXTCODESIZE(owner) > 0` — a contract cannot change
///      its mind, a wallet can. That check is forgeable and cheap to forge:
///
///        A1 hidden cancel      a contract with an obfuscated `pool.cancelOrder` path
///        A2 upgradeable proxy  EIP-1967 slot; the code hash is stable, behaviour is not
///        A3 delegatecall       runtime code never changes, arbitrary code runs in its context
///        A4 late operator      grants `cancelOrderFor` to an EOA AFTER resting
///        A5 quiet reduce       `pool.reduceOrder` shrinks displayed depth without a fill
///
///      All five have bytecode, all five read FIRM under `EXTCODESIZE`, and all
///      five can take their depth back. A metric that scores them FIRM is worse
///      than no metric: it launders unreliable liquidity through our own number.
///
///      So classification is a WHITELIST over `EXTCODEHASH` — a keccak-256
///      commitment to exact runtime bytecode (EIP-1052). An attestation binds to
///      CODE, not to an address, so it can never be re-pointed at different
///      behaviour. Code that is not attested is UNVERIFIED, and UNVERIFIED makes
///      no claim at all. Every escape in the published corpus therefore mints
///      UNVERIFIED depth, not FIRM.
///
///      SCOPE OF THE CLAIM. This registry is a TRANSPARENCY LIST, not an oracle
///      of irrevocability. Being attested means a human reviewed the code after
///      it passed the off-chain static pre-filter; it does NOT mean the filter
///      proved the code cannot withdraw. No static scan can prove that over a
///      language with arbitrary CALL — a withdrawal selector computed at runtime
///      appears nowhere in the bytecode. Consumers must read FIRM as "attested by
///      this registry's attesters and inside its lock window", nothing stronger.
library Firmness {
    /// @dev PULLABLE = wallet. UNVERIFIED = code we have not attested — NO CLAIM.
    ///      FIRM = attested code inside its lock window.
    enum Class {
        PULLABLE,
        UNVERIFIED,
        FIRM
    }

    /// @dev `EXTCODEHASH` of any account with no code. EIP-1052 returns this for an
    ///      EOA that exists, and 0x0 for an account that does not exist at all.
    bytes32 internal constant EMPTY_CODEHASH = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;

    /// @notice The classification predicate, with no storage and no external calls.
    /// @param codehash EXTCODEHASH(owner)
    /// @param isAttested whether that exact runtime bytecode passed the static policy
    /// @param unlockAt the owner's own lock horizon (0 if it exposes none)
    /// @param nowTs the timestamp to judge the lock window against
    function classify(bytes32 codehash, bool isAttested, uint64 unlockAt, uint64 nowTs)
        internal
        pure
        returns (Class)
    {
        // No code == a wallet. It can cancel in the next block, and saying so is
        // the honest answer, not a failure to classify.
        if (codehash == EMPTY_CODEHASH || codehash == bytes32(0)) return Class.PULLABLE;
        // Code we have never analysed. We make no claim about it either way.
        if (!isAttested) return Class.UNVERIFIED;
        // Attested, but the lock has run out: firmness has a horizon, not a badge.
        if (unlockAt <= nowTs) return Class.UNVERIFIED;
        return Class.FIRM;
    }
}

/// @title FirmnessRegistry — the attested-codehash set, on chain
/// @notice Maps runtime-bytecode hashes that passed the static policy to an
///         attestation record, and answers the ternary classification for any
///         address in one call.
///
/// @dev WHAT THIS IS NOT. It is a transparency list, not a trustless oracle. The
///      attester runs `script/analyze.mjs` — a static policy over runtime
///      bytecode — and publishes the record so anyone can re-derive it from the
///      same bytes. The policy is SOUND FOR THE FIVE KNOWN ESCAPES ABOVE and is
///      NOT a general proof of irrevocability. Saying so is the point: a metric
///      that overclaims is the thing this replaces.
///
///      Concretely, the analyzer scans push immediates for forbidden selectors.
///      Bytecode that assembles a selector arithmetically at runtime would evade
///      that scan — which is exactly why attestation is a whitelist. Evading the
///      scan gets you nothing: unattested code is UNVERIFIED, not FIRM.
contract FirmnessRegistry {
    using Firmness for bytes32;

    struct Attestation {
        address attester;
        uint64 attestedAt;
        bool revoked;
        /// @dev keccak256 of the off-chain JSON record (opcode histogram, selector
        ///      scan, proxy indicators, verdict). Content-addressed, so the record
        ///      published alongside cannot be swapped after the fact.
        bytes32 recordHash;
    }

    /// @notice The account permitted to attest and revoke. Deliberately one key:
    ///         the registry's honesty is auditable, not governed.
    address public immutable attester;

    mapping(bytes32 => Attestation) public attestations;
    bytes32[] public attestedList;

    error NotAttester(address caller, address expected);
    error AlreadyAttested(bytes32 codehash);
    error NotFound(bytes32 codehash);

    event Attested(bytes32 indexed codehash, address indexed attester, bytes32 recordHash);
    event Revoked(bytes32 indexed codehash, address indexed attester);

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester(msg.sender, attester);
        _;
    }

    constructor(address _attester) {
        attester = _attester;
    }

    /// @notice Publish that `codehash` passed the static policy.
    /// @param recordHash keccak256 of the JSON attestation record (see script/analyze.mjs)
    function attest(bytes32 codehash, bytes32 recordHash) external onlyAttester {
        Attestation storage a = attestations[codehash];
        if (a.attestedAt != 0 && !a.revoked) revert AlreadyAttested(codehash);
        if (a.attestedAt == 0) attestedList.push(codehash);
        a.attester = msg.sender;
        a.attestedAt = uint64(block.timestamp);
        a.revoked = false;
        a.recordHash = recordHash;
        emit Attested(codehash, msg.sender, recordHash);
    }

    /// @notice Withdraw an attestation. Existing FIRM depth immediately reads
    ///         UNVERIFIED — the classification is a live read, never cached.
    function revoke(bytes32 codehash) external onlyAttester {
        Attestation storage a = attestations[codehash];
        if (a.attestedAt == 0) revert NotFound(codehash);
        a.revoked = true;
        emit Revoked(codehash, msg.sender);
    }

    function isAttested(bytes32 codehash) public view returns (bool) {
        Attestation storage a = attestations[codehash];
        return a.attestedAt != 0 && !a.revoked;
    }

    /// @notice How many code hashes have EVER been attested, including ones since
    ///         revoked. `attestedList` is append-only by design — the transparency
    ///         record must not be able to erase its own history.
    /// @dev NOT a count of currently-firm code. Use `activeCount()` for that.
    ///      (2026-08-26 audit, F-10: this was previously documented as if it were
    ///      the active count, which overstates after any revoke.)
    function attestedCount() external view returns (uint256) {
        return attestedList.length;
    }

    /// @notice How many attestations are currently live (attested and not revoked).
    ///         This is the number a UI should show next to "attested code".
    function activeCount() external view returns (uint256 n) {
        uint256 len = attestedList.length;
        for (uint256 i; i < len; ++i) {
            if (isAttested(attestedList[i])) ++n;
        }
    }

    /// @notice Type one order owner.
    /// @return class 0 PULLABLE · 1 UNVERIFIED · 2 FIRM
    /// @return codehash EXTCODEHASH(owner) — the thing the attestation binds to
    /// @return firmUntil the owner's `unlockAt()`, or 0 when it exposes none.
    ///         The BOOK-level horizon is `min(firmUntil, order.expireTimestampNs)`:
    ///         `sweepExpiredAtLevel` is permissionless, so a quote is firm only
    ///         until its own mandatory expiry. Callers must take that min.
    function classify(address owner)
        external
        view
        returns (Firmness.Class class, bytes32 codehash, uint64 firmUntil)
    {
        assembly {
            codehash := extcodehash(owner)
        }
        bool attested = isAttested(codehash);
        // Only ask an attested contract for its lock horizon. Calling `unlockAt()`
        // on arbitrary unattested code hands it execution for no reason.
        if (attested) firmUntil = _unlockAt(owner);
        class = Firmness.classify(codehash, attested, firmUntil, uint64(block.timestamp));
    }

    /// @notice Type a whole book's worth of owners in one round-trip. The typed
    ///         book viewer memoises by address, so this is called with the
    ///         DISTINCT owners of the resting orders, not one entry per order.
    function classifyBatch(address[] calldata owners)
        external
        view
        returns (Firmness.Class[] memory classes, bytes32[] memory codehashes, uint64[] memory firmUntils)
    {
        uint256 n = owners.length;
        classes = new Firmness.Class[](n);
        codehashes = new bytes32[](n);
        firmUntils = new uint64[](n);
        uint64 nowTs = uint64(block.timestamp);
        for (uint256 i; i < n; ++i) {
            address o = owners[i];
            bytes32 ch;
            assembly {
                ch := extcodehash(o)
            }
            bool attested = isAttested(ch);
            uint64 u = attested ? _unlockAt(o) : uint64(0);
            codehashes[i] = ch;
            firmUntils[i] = u;
            classes[i] = Firmness.classify(ch, attested, u, nowTs);
        }
    }

    /// @dev Staticcall so a hostile `unlockAt()` cannot write state or consume the
    ///      whole gas budget of a batch classification; a failure reads as 0, which
    ///      classifies as UNVERIFIED rather than FIRM.
    function _unlockAt(address owner) internal view returns (uint64) {
        (bool ok, bytes memory ret) =
            owner.staticcall{gas: 30_000}(abi.encodeWithSelector(IFirmQuoteView.unlockAt.selector));
        if (!ok || ret.length < 32) return 0;
        return uint64(abi.decode(ret, (uint256)));
    }
}
