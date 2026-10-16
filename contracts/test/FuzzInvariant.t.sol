// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {DMSTestBase} from "./utils/DMSTestBase.sol";
import {DeadManSwitch} from "../src/DeadManSwitch.sol";
import {externalEuint256} from "encrypted-types/EncryptedTypes.sol";
import {IKMSVerifier} from "forge-fhevm/generated/interfaces/IKMSVerifier.sol";
import {KMSDecryptionProofHelper} from "forge-fhevm/KMSDecryptionProofHelper.sol";

// ========================================================================= //
//                               Fuzz tests                                  //
// ========================================================================= //

/// @notice Property tests over the value-carrying and size-bounded inputs.
contract FuzzTest is DMSTestBase {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // ---------- Fixtures: the fuzzer always tries these exact boundary values ---------- //

    /// @dev Ciphertext lengths around CIPHERTEXT_OVERHEAD (61) and MAX_CIPHERTEXT_SIZE (2109).
    function fixtureCtLen() public pure returns (uint256[] memory f) {
        f = new uint256[](5);
        (f[0], f[1], f[2], f[3], f[4]) = (0, 60, 61, 2109, 2110);
    }

    /// @dev Ping intervals around MIN_PING_INTERVAL (60) and MAX_PING_INTERVAL (365 days).
    function fixtureInterval() public pure returns (uint64[] memory f) {
        f = new uint64[](8);
        (f[0], f[1], f[2], f[3]) = (0, 59, 60, 61);
        (f[4], f[5], f[6], f[7]) = (365 days - 1, 365 days, 365 days + 1, type(uint64).max);
    }

    /// @dev Payload lengths around MAX_PAYLOAD_SIZE (2048).
    function fixturePayloadLen() public pure returns (uint256[] memory f) {
        f = new uint256[](5);
        (f[0], f[1], f[2], f[3], f[4]) = (0, 1, 2047, 2048, 2049);
    }

    // ---------- Bounty payout ---------- //

    /// @dev Any owner escrow plus up to three contributions (a funder may repeat, and the
    ///      owner may fund their own switch) is paid to the revealer exactly — even a late
    ///      reveal deep into the rescue window, as long as no depositor has withdrawn.
    function testFuzz_Bounty_RevealerReceivesExactlyOwnerPlusFunderStakes(
        uint256 ownerBounty,
        uint256[3] memory amounts,
        uint256[3] memory funderSeeds,
        uint256 nFunders,
        uint256 revealDelay
    ) public {
        ownerBounty = bound(ownerBounty, dms.minBounty(), 1_000 ether);
        nFunders = bound(nFunders, 0, 3);
        revealDelay = bound(revealDelay, 0, 2 * dms.RESCUE_DELAY());

        vm.deal(alice, ownerBounty);
        bytes32 key =
            _create(alice, ID, INTERVAL, ownerBounty, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));
        assertEq(alice.balance, 0, "owner escrowed everything");

        address[4] memory pool = [alice, bob, carol, eve];
        uint256 expected = ownerBounty;
        for (uint256 i; i < nFunders; i++) {
            address funder = pool[funderSeeds[i] % pool.length];
            uint256 amt = bound(amounts[i], 1, 1_000 ether);
            uint256 stakeBefore = dms.getFunderStake(alice, ID, funder);
            vm.deal(funder, funder.balance + amt);
            vm.prank(funder);
            dms.fundBounty{value: amt}(alice, ID);
            assertEq(dms.getFunderStake(alice, ID, funder), stakeBefore + amt, "funder stake");
            expected += amt;
        }
        assertEq(dms.getBounty(alice, ID), expected, "pot");
        assertEq(dms.getOwnerStake(alice, ID), ownerBounty, "owner stake");
        assertEq(address(dms).balance, expected, "escrow");

        _darkAndMark(alice, ID);
        vm.warp(block.timestamp + revealDelay);
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);

        uint256[4] memory poolBefore;
        for (uint256 i; i < pool.length; i++) {
            poolBefore[i] = pool[i].balance;
        }
        address revealer = makeAddr("revealer");
        assertEq(revealer.balance, 0);

        vm.expectEmit(true, true, false, true, address(dms));
        emit DeadManSwitch.KeyRevealed(key, revealer, dek, expected, uint64(block.timestamp));
        vm.prank(revealer);
        dms.revealKey(alice, ID, dek, proof);

        assertEq(revealer.balance, expected, "revealer receives exactly the pot");
        assertEq(address(dms).balance, 0, "nothing left in escrow");
        assertEq(dms.getBounty(alice, ID), 0, "bounty zeroed");
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.REVEALED));
        for (uint256 i; i < pool.length; i++) {
            assertEq(pool[i].balance, poolBefore[i], "depositors are not paid by a reveal");
        }
    }

    // ---------- Create: size and interval bounds ---------- //

    function testFuzz_Create_CiphertextLengthAcceptedExactlyWithinBounds(uint256 ctLen, uint256 seed) public {
        uint256 minLen = dms.CIPHERTEXT_OVERHEAD();
        uint256 maxLen = dms.MAX_CIPHERTEXT_SIZE();
        ctLen = bound(ctLen, 0, maxLen + 256);
        bytes memory ct = _randomBytes(ctLen, seed);
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, ID));
        DeadManSwitch.CreateParams memory p = _params(ID, INTERVAL, _commitment(SALT, PLAINTEXT));
        bool accepted = ctLen >= minLen && ctLen <= maxLen;

        if (ctLen < minLen) vm.expectRevert(DeadManSwitch.CiphertextTooSmall.selector);
        else if (ctLen > maxLen) vm.expectRevert(DeadManSwitch.CiphertextTooLarge.selector);
        vm.prank(alice);
        dms.createSwitch{value: BOUNTY}(p, ct, h, proof);

        if (accepted) {
            assertEq(dms.getCiphertext(alice, ID), ct, "ciphertext stored verbatim");
            assertEq(dms.getSwitchInfo(alice, ID).ciphertextLength, ctLen);
            assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.ALIVE));
            assertEq(address(dms).balance, BOUNTY);
            assertTrue(dms.keyHandleUsed(externalEuint256.unwrap(h)));
        } else {
            assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.NONE));
            assertEq(address(dms).balance, 0);
            assertEq(alice.balance, 100 ether, "rejected create keeps the owner's ETH");
            assertFalse(dms.keyHandleUsed(externalEuint256.unwrap(h)));
        }
    }

    function testFuzz_Create_PingIntervalAcceptedExactlyWithinBounds(uint64 interval) public {
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, ID));
        DeadManSwitch.CreateParams memory p = _params(ID, interval, _commitment(SALT, PLAINTEXT));
        bytes memory ct = _ciphertext(PLAINTEXT.length);
        bool accepted = interval >= dms.MIN_PING_INTERVAL() && interval <= dms.MAX_PING_INTERVAL();

        if (!accepted) vm.expectRevert(DeadManSwitch.InvalidInterval.selector);
        vm.prank(alice);
        dms.createSwitch{value: BOUNTY}(p, ct, h, proof);

        if (!accepted) {
            assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.NONE));
            assertEq(address(dms).balance, 0);
            return;
        }
        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(alice, ID);
        assertEq(info.pingInterval, interval);
        assertEq(info.lastPing, block.timestamp);
        assertEq(info.expiresAt, block.timestamp + interval, "deadline = createdAt + interval");
        assertEq(uint8(info.state), uint8(DeadManSwitch.State.ALIVE));
    }

    // ---------- Ping: deadline arithmetic across the whole interval range ---------- //

    function testFuzz_Ping_DeadlineIsExactlyLastPingPlusInterval(uint256 intervalSeed, uint256 elapsed) public {
        uint64 iv = uint64(bound(intervalSeed, dms.MIN_PING_INTERVAL(), dms.MAX_PING_INTERVAL()));
        elapsed = bound(elapsed, 0, iv - 1);
        bytes32 key = _create(alice, ID, iv, BOUNTY, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));

        vm.warp(block.timestamp + elapsed);
        uint64 pingedAt = uint64(block.timestamp);
        vm.expectEmit(true, false, false, true, address(dms));
        emit DeadManSwitch.Pinged(key, pingedAt, pingedAt + iv);
        vm.prank(alice);
        dms.ping(ID);
        assertEq(dms.expirationTime(alice, ID), pingedAt + iv);

        // One second before the deadline: alive, not markable, key sealed.
        vm.warp(uint256(pingedAt) + iv - 1);
        assertTrue(dms.isAlive(alice, ID));
        vm.expectRevert(DeadManSwitch.NotDark.selector);
        dms.markDark(alice, ID);

        // At the deadline: dark, the owner can no longer ping, anyone can mark.
        vm.warp(uint256(pingedAt) + iv);
        assertTrue(dms.isDark(alice, ID));
        vm.expectRevert(DeadManSwitch.Expired.selector);
        vm.prank(alice);
        dms.ping(ID);
        bytes32 handle = dms.getEncKeyHandle(alice, ID);
        assertFalse(_isPubliclyDecryptable(handle));
        dms.markDark(alice, ID);
        assertTrue(_isPubliclyDecryptable(handle));
    }

    // ---------- publishPlaintext ---------- //

    /// @dev Any salt and any payload up to MAX_PAYLOAD_SIZE publishes iff it matches the
    ///      commitment; a committed payload above the cap is refused regardless.
    function testFuzz_Publish_AcceptsExactlyTheCommittedBoundedPayload(
        bytes32 salt,
        uint256 payloadLen,
        uint256 seed,
        uint256 flipSeed
    ) public {
        uint256 maxPayload = dms.MAX_PAYLOAD_SIZE();
        payloadLen = bound(payloadLen, 0, maxPayload + 64);
        bytes memory payload = _randomBytes(payloadLen, seed);
        uint256 ctPlainLen = payloadLen > maxPayload ? maxPayload : payloadLen;
        bytes32 key = _create(alice, ID, INTERVAL, BOUNTY, _commitment(salt, payload), _ciphertext(ctPlainLen));
        _reveal(alice, ID, bob);

        if (payloadLen > maxPayload) {
            vm.expectRevert(DeadManSwitch.PayloadTooLarge.selector);
            vm.prank(carol);
            dms.publishPlaintext(alice, ID, salt, payload);
            assertFalse(dms.getSwitchInfo(alice, ID).published);
            return;
        }

        // A one-bit change to the salt is refused.
        bytes32 wrongSalt = salt ^ bytes32(uint256(1) << (flipSeed % 256));
        vm.expectRevert(DeadManSwitch.CommitmentMismatch.selector);
        vm.prank(carol);
        dms.publishPlaintext(alice, ID, wrongSalt, payload);

        // A one-bit change to the payload (one extra byte when it is empty) is refused.
        bytes memory tampered = _tamper(payload, flipSeed);
        vm.expectRevert(DeadManSwitch.CommitmentMismatch.selector);
        vm.prank(carol);
        dms.publishPlaintext(alice, ID, salt, tampered);
        assertFalse(dms.getSwitchInfo(alice, ID).published);

        vm.expectEmit(true, true, false, true, address(dms));
        emit DeadManSwitch.PlaintextPublished(key, carol, payload);
        vm.prank(carol);
        dms.publishPlaintext(alice, ID, salt, payload);
        assertTrue(dms.getSwitchInfo(alice, ID).published);
    }

    // ---------- revealKey: only the KMS can authorise a key ---------- //

    /// @dev A well-formed proof from any signer other than the KMS is refused for any
    ///      claimed key — including the correct DEK.
    function testFuzz_Reveal_RejectsProofFromAnyNonKmsSigner(bytes32 dataKey, uint256 roguePk, bool claimTrueKey)
        public
    {
        roguePk = bound(roguePk, 1, SECP256K1_N - 1);
        address rogue = vm.addr(roguePk);
        vm.assume(rogue != mockKmsSigner);
        _create();
        _darkAndMark(alice, ID);
        if (claimTrueKey) dataKey = bytes32(_dekFor(alice, ID));
        bytes memory forged = _signProof(roguePk, dms.getEncKeyHandle(alice, ID), dataKey);
        uint256 eveBefore = eve.balance;

        vm.expectRevert(abi.encodeWithSelector(IKMSVerifier.KMSInvalidSigner.selector, rogue));
        vm.prank(eve);
        dms.revealKey(alice, ID, dataKey, forged);

        _assertUnrevealed(alice, ID);
        assertEq(eve.balance, eveBefore);
    }

    /// @dev The genuine KMS proof for this switch's DEK does not authorise any other key.
    function testFuzz_Reveal_RejectsKmsProofForAnyOtherDataKey(bytes32 dataKey) public {
        _create();
        _darkAndMark(alice, ID);
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);
        vm.assume(dataKey != dek);
        address recovered = _recoveredSigner(proof, dms.getEncKeyHandle(alice, ID), dataKey);
        assertNotEq(recovered, mockKmsSigner);

        vm.expectRevert(abi.encodeWithSelector(IKMSVerifier.KMSInvalidSigner.selector, recovered));
        vm.prank(eve);
        dms.revealKey(alice, ID, dataKey, proof);
        _assertUnrevealed(alice, ID);

        // The same proof with the true key still lands.
        uint256 eveBefore = eve.balance;
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, proof);
        assertEq(eve.balance - eveBefore, BOUNTY);
        assertEq(dms.getRevealedKey(alice, ID), dek);
    }

    // ---------- helpers ---------- //

    function _randomBytes(uint256 len, uint256 seed) internal pure returns (bytes memory b) {
        b = new bytes(len);
        bytes32 word;
        for (uint256 i; i < len; i++) {
            if (i % 32 == 0) word = keccak256(abi.encode(seed, i));
            b[i] = word[i % 32];
        }
    }

    function _tamper(bytes memory payload, uint256 flipSeed) internal pure returns (bytes memory t) {
        if (payload.length == 0) return hex"00";
        t = bytes.concat(payload);
        uint256 idx = flipSeed % payload.length;
        t[idx] = t[idx] ^ bytes1(uint8(1) << uint8((flipSeed >> 128) % 8));
    }

    function _assertUnrevealed(address owner, uint256 id) internal view {
        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(owner, id);
        assertEq(uint8(info.state), uint8(DeadManSwitch.State.DARK_MARKED), "still dark-marked");
        assertEq(info.bounty, BOUNTY, "bounty intact");
        assertEq(info.revealedKey, bytes32(0), "no key recorded");
        assertEq(info.revealedAt, 0);
        assertEq(address(dms).balance, BOUNTY, "escrow intact");
    }

    /// @dev EIP-712 digest the KMS verifier checks for (handle, abi.encode(dataKey), extraData).
    function _kmsDigest(bytes32 handle, bytes32 dataKey, bytes memory extraData) internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            _kmsVerifier.eip712Domain();
        bytes32 ds =
            KMSDecryptionProofHelper.computeKMSDecryptionDomainSeparator(name, version, chainId, verifyingContract);
        bytes32[] memory hs = new bytes32[](1);
        hs[0] = handle;
        return KMSDecryptionProofHelper.computeDecryptionDigest(hs, abi.encode(dataKey), extraData, ds);
    }

    /// @dev A well-formed single-signature decryption proof signed by `pk` over (handle, dataKey).
    function _signProof(uint256 pk, bytes32 handle, bytes32 dataKey) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _kmsDigest(handle, dataKey, EMPTY_EXTRA_DATA));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(r, s, v);
        return KMSDecryptionProofHelper.assembleDecryptionProof(sigs, EMPTY_EXTRA_DATA);
    }

    /// @dev Address the verifier recovers when the single-signature `proof` is checked against
    ///      (handle, dataKey) — the exact argument of the KMSInvalidSigner revert.
    function _recoveredSigner(bytes memory proof, bytes32 handle, bytes32 dataKey) internal view returns (address) {
        require(proof.length >= 66 && uint8(proof[0]) == 1, "single-sig proof expected");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(proof, 33))
            s := mload(add(proof, 65))
            v := byte(0, mload(add(proof, 97)))
        }
        bytes memory extra = new bytes(proof.length - 66);
        for (uint256 i; i < extra.length; i++) {
            extra[i] = proof[66 + i];
        }
        return ecrecover(_kmsDigest(handle, dataKey, extra), v, r, s);
    }
}

// ========================================================================= //
//                            Invariant suite                                //
// ========================================================================= //

/**
 * @notice The handler drives the contract but cannot encrypt or decrypt on its own:
 *         forge-fhevm's plaintext database and mock signers live in the FhevmTest
 *         contract. The invariant test implements this interface and the handler calls
 *         back into it, so every encryption and public decryption goes through the one
 *         FhevmTest instance that deployed the host contracts.
 */
interface IFhevmHarness {
    function encryptDek(address owner, uint256 dek) external returns (externalEuint256 handle, bytes memory proof);
    function kmsPublicDecrypt(bytes32 handle) external returns (bytes32 dataKey, bytes memory proof);
}

/**
 * @notice Stateful driver. Every action first picks a switch on which the contract
 *         *should* accept it (from the contract's own view of state), then calls it under
 *         try/catch: a revert of a pre-validated call is counted in `unexpectedReverts`
 *         rather than silently discarded by `fail_on_revert = false`. Recipients' balance
 *         deltas are measured around every payout, so ETH conservation is checked against
 *         ETH that actually moved, not against the contract's own bookkeeping.
 */
contract FuzzInvariantHandler is CommonBase, StdUtils {
    struct Tracked {
        address owner;
        uint256 id;
        bytes32 key;
        bytes32 dek;
        bytes32 salt;
        bytes payload;
    }

    enum Pick {
        Alive,
        Dark,
        Marked,
        Unpublished,
        OwnerRescue,
        FunderReclaim
    }

    uint256 internal constant IDS_PER_OWNER = 3;
    uint64 internal constant MAX_TEST_INTERVAL = 3 days;
    uint256 internal constant MAX_DEPOSIT = 10 ether;
    uint256 internal constant MAX_PAYLOAD = 96;

    DeadManSwitch public immutable dms;
    IFhevmHarness internal immutable harness;
    address[] internal actors;
    Tracked[] internal tracked;
    mapping(bytes32 => bool) internal isTracked;

    // ---- ghost accounting ---- //
    uint256 public ghostDeposited; // Σ msg.value of successful createSwitch / fundBounty
    uint256 public ghostPaidOut; // Σ measured balance increase of every payout recipient
    mapping(bytes32 => uint256) public ghostBounty;
    mapping(bytes32 => uint256) public ghostOwnerStake;
    mapping(bytes32 => mapping(address => uint256)) public ghostFunderStake;

    // ---- health ---- //
    uint256 public unexpectedReverts; // a pre-validated call reverted
    uint256 public payoutMismatches; // a recipient received something other than the ledger amount
    uint256 public wrongKeys; // the KMS cleartext differed from the DEK the owner encrypted
    mapping(string => uint256) public calls; // successful calls per action

    constructor(DeadManSwitch _dms, IFhevmHarness _harness, address[] memory _actors) {
        dms = _dms;
        harness = _harness;
        actors = _actors;
    }

    // ---------------------------------------------------------------- actions

    function create(uint256 ownerSeed, uint256 idSeed, uint256 intervalSeed, uint256 bountySeed, uint256 payloadSeed)
        external
    {
        address owner = actors[ownerSeed % actors.length];
        uint256 id = 1 + (idSeed % IDS_PER_OWNER);
        bytes32 key = dms.switchKey(owner, id);
        if (isTracked[key]) return;

        uint64 interval = uint64(bound(intervalSeed, dms.MIN_PING_INTERVAL(), MAX_TEST_INTERVAL));
        uint256 bounty = bound(bountySeed, dms.minBounty(), MAX_DEPOSIT);
        bytes32 salt = keccak256(abi.encode("salt", payloadSeed));
        bytes memory payload = _payload(payloadSeed);
        bytes memory ciphertext = new bytes(payload.length + dms.CIPHERTEXT_OVERHEAD());
        ciphertext[0] = 0x01;
        bytes32 dek = keccak256(abi.encode("dek", owner, id));
        (externalEuint256 h, bytes memory proof) = harness.encryptDek(owner, uint256(dek));
        DeadManSwitch.CreateParams memory p = DeadManSwitch.CreateParams({
            id: id, pingInterval: interval, plaintextCommitment: keccak256(abi.encodePacked(salt, payload))
        });

        vm.prank(owner);
        try dms.createSwitch{value: bounty}(p, ciphertext, h, proof) returns (bytes32 k) {
            if (k != key) unexpectedReverts++;
            tracked.push(Tracked({owner: owner, id: id, key: key, dek: dek, salt: salt, payload: payload}));
            isTracked[key] = true;
            ghostDeposited += bounty;
            ghostBounty[key] = bounty;
            ghostOwnerStake[key] = bounty;
            calls["create"]++;
        } catch {
            unexpectedReverts++;
        }
    }

    function ping(uint256 seed) external {
        (bool found, uint256 i) = _pick(seed, Pick.Alive);
        if (!found) return;
        Tracked storage t = tracked[i];
        vm.prank(t.owner);
        try dms.ping(t.id) {
            calls["ping"]++;
        } catch {
            unexpectedReverts++;
        }
    }

    function fundBounty(uint256 seed, uint256 funderSeed, uint256 amountSeed) external {
        (bool found, uint256 i) = _pick(seed, Pick.Alive);
        if (!found) return;
        Tracked storage t = tracked[i];
        address funder = actors[funderSeed % actors.length];
        uint256 amount = bound(amountSeed, 1, MAX_DEPOSIT);
        vm.prank(funder);
        try dms.fundBounty{value: amount}(t.owner, t.id) {
            ghostDeposited += amount;
            ghostBounty[t.key] += amount;
            ghostFunderStake[t.key][funder] += amount;
            calls["fundBounty"]++;
        } catch {
            unexpectedReverts++;
        }
    }

    function cancel(uint256 seed) external {
        (bool found, uint256 i) = _pick(seed, Pick.Alive);
        if (!found) return;
        Tracked storage t = tracked[i];
        uint256 expected = ghostOwnerStake[t.key];
        uint256 before = t.owner.balance;
        vm.prank(t.owner);
        try dms.cancel(t.id) {
            _recordPayout(t.owner, before, expected);
            ghostBounty[t.key] -= expected;
            ghostOwnerStake[t.key] = 0;
            calls["cancel"]++;
        } catch {
            unexpectedReverts++;
        }
    }

    function reclaimContribution(uint256 seed, uint256 funderSeed) external {
        (bool found, uint256 i) = _pick(seed, Pick.FunderReclaim);
        if (!found) return;
        Tracked storage t = tracked[i];
        address funder = _funderWithStake(t, funderSeed);
        uint256 expected = ghostFunderStake[t.key][funder];
        uint256 before = funder.balance;
        vm.prank(funder);
        try dms.reclaimContribution(t.owner, t.id) {
            _recordPayout(funder, before, expected);
            ghostBounty[t.key] -= expected;
            ghostFunderStake[t.key][funder] = 0;
            calls["reclaimContribution"]++;
        } catch {
            unexpectedReverts++;
        }
    }

    function reclaimOwnerStake(uint256 seed) external {
        (bool found, uint256 i) = _pick(seed, Pick.OwnerRescue);
        if (!found) return;
        Tracked storage t = tracked[i];
        uint256 expected = ghostOwnerStake[t.key];
        uint256 before = t.owner.balance;
        vm.prank(t.owner);
        try dms.reclaimOwnerStake(t.id) {
            _recordPayout(t.owner, before, expected);
            ghostBounty[t.key] -= expected;
            ghostOwnerStake[t.key] = 0;
            calls["reclaimOwnerStake"]++;
        } catch {
            unexpectedReverts++;
        }
    }

    function markDark(uint256 seed, uint256 callerSeed) external {
        (bool found, uint256 i) = _pick(seed, Pick.Dark);
        if (!found) return;
        Tracked storage t = tracked[i];
        vm.prank(actors[callerSeed % actors.length]);
        try dms.markDark(t.owner, t.id) {
            calls["markDark"]++;
        } catch {
            unexpectedReverts++;
        }
    }

    function revealKey(uint256 seed, uint256 revealerSeed) external {
        (bool found, uint256 i) = _pick(seed, Pick.Marked);
        if (!found) return;
        Tracked storage t = tracked[i];

        bytes32 dataKey;
        bytes memory proof;
        try harness.kmsPublicDecrypt(dms.getEncKeyHandle(t.owner, t.id)) returns (bytes32 k, bytes memory p) {
            (dataKey, proof) = (k, p);
        } catch {
            unexpectedReverts++;
            return;
        }
        if (dataKey != t.dek) wrongKeys++;

        address revealer = actors[revealerSeed % actors.length];
        uint256 expected = ghostBounty[t.key];
        uint256 before = revealer.balance;
        vm.prank(revealer);
        try dms.revealKey(t.owner, t.id, dataKey, proof) {
            _recordPayout(revealer, before, expected);
            ghostBounty[t.key] = 0;
            calls["revealKey"]++;
        } catch {
            unexpectedReverts++;
        }
    }

    function publishPlaintext(uint256 seed, uint256 publisherSeed) external {
        (bool found, uint256 i) = _pick(seed, Pick.Unpublished);
        if (!found) return;
        Tracked storage t = tracked[i];
        vm.prank(actors[publisherSeed % actors.length]);
        try dms.publishPlaintext(t.owner, t.id, t.salt, t.payload) {
            calls["publishPlaintext"]++;
        } catch {
            unexpectedReverts++;
        }
    }

    /// @dev Short hop: lets switches cross their own deadlines one by one.
    function warp(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 1, 2 days));
        calls["warp"]++;
    }

    /// @dev Long hop: reaches the rescue window of everything already dark.
    function warpPastRescue(uint256 seed) external {
        uint256 delay = dms.RESCUE_DELAY();
        vm.warp(block.timestamp + bound(seed, delay, delay + MAX_TEST_INTERVAL));
        calls["warpPastRescue"]++;
    }

    // ---------------------------------------------------------------- views

    function trackedCount() external view returns (uint256) {
        return tracked.length;
    }

    function trackedAt(uint256 i) external view returns (address owner, uint256 id, bytes32 key, bytes32 dek) {
        Tracked storage t = tracked[i];
        return (t.owner, t.id, t.key, t.dek);
    }

    function actorList() external view returns (address[] memory) {
        return actors;
    }

    // ---------------------------------------------------------------- internal

    /// @dev First switch, scanning from `seed`, on which the contract should accept `what`.
    function _pick(uint256 seed, Pick what) internal view returns (bool, uint256) {
        uint256 n = tracked.length;
        if (n == 0) return (false, 0);
        uint256 start = seed % n;
        for (uint256 j; j < n; j++) {
            uint256 i = (start + j) % n;
            if (_eligible(tracked[i], what)) return (true, i);
        }
        return (false, 0);
    }

    function _eligible(Tracked storage t, Pick what) internal view returns (bool) {
        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(t.owner, t.id);
        if (what == Pick.Alive) return info.state == DeadManSwitch.State.ALIVE;
        if (what == Pick.Dark) return info.state == DeadManSwitch.State.DARK;
        if (what == Pick.Marked) return info.state == DeadManSwitch.State.DARK_MARKED;
        if (what == Pick.Unpublished) return info.state == DeadManSwitch.State.REVEALED && !info.published;
        if (what == Pick.OwnerRescue) return info.rescuable && info.ownerStake > 0;
        // Pick.FunderReclaim
        if (info.state != DeadManSwitch.State.CANCELLED && !info.rescuable) return false;
        return _funderWithStake(t, 0) != address(0);
    }

    /// @dev First actor, scanning from `seed`, holding a contribution on `t` per the contract.
    function _funderWithStake(Tracked storage t, uint256 seed) internal view returns (address) {
        uint256 n = actors.length;
        for (uint256 j; j < n; j++) {
            address a = actors[(seed % n + j) % n];
            if (dms.getFunderStake(t.owner, t.id, a) > 0) return a;
        }
        return address(0);
    }

    /// @dev Never reverts: a mismatch is recorded, not thrown (a throw would be discarded).
    function _recordPayout(address recipient, uint256 balanceBefore, uint256 expected) internal {
        uint256 balanceAfter = recipient.balance;
        if (balanceAfter < balanceBefore) {
            payoutMismatches++;
            return;
        }
        uint256 received = balanceAfter - balanceBefore;
        ghostPaidOut += received;
        if (received != expected) payoutMismatches++;
    }

    function _payload(uint256 seed) internal pure returns (bytes memory b) {
        b = new bytes(seed % (MAX_PAYLOAD + 1));
        for (uint256 i; i < b.length; i++) {
            b[i] = bytes1(uint8(uint256(keccak256(abi.encode(seed, i)))));
        }
    }
}

/**
 * @notice Stateful invariants over random sequences of every lifecycle action and time warps.
 * @dev    The handler never reverts by design (contract calls are pre-validated and wrapped in
 *         try/catch), so any handler revert is a handler bug and must fail the suite rather
 *         than be discarded under the project-wide `fail_on_revert = false`.
 */
/// forge-config: default.invariant.fail-on-revert = true
contract FuzzInvariantTest is DMSTestBase, IFhevmHarness {
    FuzzInvariantHandler internal handler;
    address[] internal actors;

    function setUp() public override {
        super.setUp();
        actors.push(alice);
        actors.push(bob);
        actors.push(carol);
        actors.push(eve);
        for (uint256 i; i < actors.length; i++) {
            vm.deal(actors[i], 1_000_000 ether);
        }
        handler = new FuzzInvariantHandler(dms, this, actors);

        bytes4[] memory sels = new bytes4[](11);
        sels[0] = FuzzInvariantHandler.create.selector;
        sels[1] = FuzzInvariantHandler.ping.selector;
        sels[2] = FuzzInvariantHandler.fundBounty.selector;
        sels[3] = FuzzInvariantHandler.cancel.selector;
        sels[4] = FuzzInvariantHandler.reclaimContribution.selector;
        sels[5] = FuzzInvariantHandler.reclaimOwnerStake.selector;
        sels[6] = FuzzInvariantHandler.markDark.selector;
        sels[7] = FuzzInvariantHandler.revealKey.selector;
        sels[8] = FuzzInvariantHandler.publishPlaintext.selector;
        sels[9] = FuzzInvariantHandler.warp.selector;
        sels[10] = FuzzInvariantHandler.warpPastRescue.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    // ---------- IFhevmHarness (called back by the handler) ---------- //

    function encryptDek(address owner, uint256 dek) external returns (externalEuint256, bytes memory) {
        return _encKey(owner, dek);
    }

    function kmsPublicDecrypt(bytes32 handle) external returns (bytes32 dataKey, bytes memory proof) {
        bytes32[] memory hs = new bytes32[](1);
        hs[0] = handle;
        (uint256[] memory clear, bytes memory p) = publicDecrypt(hs);
        return (bytes32(clear[0]), p);
    }

    // ---------- Invariants ---------- //

    /// @dev (I1) The contract holds exactly the sum of all switches' bounties.
    function invariant_I1_BalanceEqualsSumOfBounties() public view {
        uint256 n = handler.trackedCount();
        uint256 sum;
        for (uint256 i; i < n; i++) {
            (address owner, uint256 id,,) = handler.trackedAt(i);
            sum += dms.getBounty(owner, id);
        }
        assertEq(address(dms).balance, sum);
    }

    /// @dev (I2) While ACTIVE (alive, dark or marked) or CANCELLED: bounty == ownerStake + Σ funderStake.
    function invariant_I2_ActiveOrCancelledBountyEqualsStakes() public view {
        uint256 n = handler.trackedCount();
        for (uint256 i; i < n; i++) {
            (address owner, uint256 id,,) = handler.trackedAt(i);
            if (dms.getState(owner, id) == DeadManSwitch.State.REVEALED) continue;
            uint256 stakes = dms.getOwnerStake(owner, id);
            for (uint256 j; j < actors.length; j++) {
                stakes += dms.getFunderStake(owner, id, actors[j]);
            }
            assertEq(dms.getBounty(owner, id), stakes);
        }
    }

    /// @dev (I3) A revealed switch has paid out its whole pot.
    function invariant_I3_RevealedBountyIsZero() public view {
        uint256 n = handler.trackedCount();
        for (uint256 i; i < n; i++) {
            (address owner, uint256 id,,) = handler.trackedAt(i);
            if (dms.getState(owner, id) == DeadManSwitch.State.REVEALED) assertEq(dms.getBounty(owner, id), 0);
        }
    }

    /// @dev (I4) The DEK of an ALIVE or CANCELLED switch — or a DARK one nobody has marked
    ///      yet — is never publicly decryptable.
    function invariant_I4_UnmarkedKeyIsNeverPubliclyDecryptable() public view {
        uint256 n = handler.trackedCount();
        for (uint256 i; i < n; i++) {
            (address owner, uint256 id,,) = handler.trackedAt(i);
            DeadManSwitch.State st = dms.getState(owner, id);
            if (
                st == DeadManSwitch.State.ALIVE || st == DeadManSwitch.State.CANCELLED || st == DeadManSwitch.State.DARK
            ) {
                assertFalse(_isPubliclyDecryptable(dms.getEncKeyHandle(owner, id)));
            }
        }
    }

    /// @dev (I5) Every wei deposited is either still held or was received by someone.
    function invariant_I5_EthIsConserved() public view {
        assertEq(handler.ghostDeposited(), address(dms).balance + handler.ghostPaidOut());
    }

    /// @dev (I6) The contract's per-depositor ledger matches an independent ghost ledger,
    ///      and every payout moved exactly the ledger amount.
    function invariant_I6_LedgerMatchesGhostAccounting() public view {
        assertEq(handler.payoutMismatches(), 0, "payout != ledger amount");
        uint256 n = handler.trackedCount();
        for (uint256 i; i < n; i++) {
            (address owner, uint256 id, bytes32 key,) = handler.trackedAt(i);
            assertEq(dms.getBounty(owner, id), handler.ghostBounty(key), "bounty");
            // Once REVEALED the whole pot went to the revealer: every stake view reads 0.
            bool revealed = dms.getState(owner, id) == DeadManSwitch.State.REVEALED;
            assertEq(dms.getOwnerStake(owner, id), revealed ? 0 : handler.ghostOwnerStake(key), "ownerStake");
            assertEq(dms.getSwitchInfo(owner, id).ownerStake, dms.getOwnerStake(owner, id), "info.ownerStake");
            for (uint256 j; j < actors.length; j++) {
                assertEq(
                    dms.getFunderStake(owner, id, actors[j]),
                    revealed ? 0 : handler.ghostFunderStake(key, actors[j]),
                    "funderStake"
                );
            }
        }
    }

    /// @dev (I7) Marked and revealed keys are public; a revealed key is the DEK its owner
    ///      encrypted, and no other switch reports a key.
    function invariant_I7_RevealedKeyIsTheOwnersDek() public view {
        assertEq(handler.wrongKeys(), 0, "KMS cleartext != encrypted DEK");
        uint256 n = handler.trackedCount();
        for (uint256 i; i < n; i++) {
            (address owner, uint256 id,, bytes32 dek) = handler.trackedAt(i);
            DeadManSwitch.State st = dms.getState(owner, id);
            if (st == DeadManSwitch.State.REVEALED) {
                assertEq(dms.getRevealedKey(owner, id), dek);
            } else {
                assertEq(dms.getRevealedKey(owner, id), bytes32(0));
            }
            if (st == DeadManSwitch.State.DARK_MARKED || st == DeadManSwitch.State.REVEALED) {
                assertTrue(_isPubliclyDecryptable(dms.getEncKeyHandle(owner, id)));
            }
        }
    }

    /// @dev (I8) Handler health: no action the contract should accept was refused.
    function invariant_I8_ValidActionsNeverRevert() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    // ---------- Handler self-test ---------- //

    /// @dev Scripted sequence through every handler action, so a broken handler cannot make
    ///      the invariants pass vacuously (fail_on_revert = false hides handler reverts).
    function test_Invariant_HandlerDrivesEveryAction() public {
        // tracked[0] = alice#1 (1 day), tracked[1] = bob#1 (1 day), tracked[2] = carol#1 (2 days)
        handler.create(0, 0, 1 days, 1 ether, 7);
        handler.create(1, 0, 1 days, 1 ether, 8);
        handler.create(2, 0, 2 days, 1 ether, 9);
        handler.create(0, 0, 1 days, 1 ether, 7); // duplicate (alice#1): skipped, not attempted
        assertEq(handler.trackedCount(), 3);

        handler.fundBounty(0, 2, 2 ether); // carol -> alice#1
        handler.fundBounty(1, 3, 3 ether); // eve -> bob#1
        handler.fundBounty(2, 3, 4 ether); // eve -> carol#1
        handler.ping(0); // alice#1
        handler.cancel(1); // bob#1
        handler.reclaimContribution(1, 3); // eve <- bob#1 (cancelled)

        handler.warp(1 days); // alice#1 dark; carol#1 still alive
        handler.markDark(0, 1); // alice#1, by bob
        handler.revealKey(0, 1); // alice#1, revealed by bob
        handler.publishPlaintext(0, 2); // alice#1, by carol

        handler.warpPastRescue(dms.RESCUE_DELAY() + 2 days); // carol#1 rescuable
        handler.reclaimOwnerStake(2); // carol#1
        handler.reclaimContribution(2, 3); // eve <- carol#1 (rescued)

        string[11] memory names = [
            "create",
            "ping",
            "fundBounty",
            "cancel",
            "reclaimContribution",
            "reclaimOwnerStake",
            "markDark",
            "revealKey",
            "publishPlaintext",
            "warp",
            "warpPastRescue"
        ];
        for (uint256 i; i < names.length; i++) {
            assertGt(handler.calls(names[i]), 0, string.concat("action never succeeded: ", names[i]));
        }
        assertEq(handler.calls("create"), 3);
        assertEq(handler.calls("reclaimContribution"), 2);

        assertEq(uint8(dms.getState(alice, 1)), uint8(DeadManSwitch.State.REVEALED));
        assertEq(uint8(dms.getState(bob, 1)), uint8(DeadManSwitch.State.CANCELLED));
        assertEq(uint8(dms.getState(carol, 1)), uint8(DeadManSwitch.State.DARK));
        assertEq(address(dms).balance, 0, "every wei paid out");
        assertEq(handler.ghostDeposited(), 3 ether + 9 ether);
        assertEq(handler.ghostPaidOut(), 3 ether + 9 ether);

        invariant_I1_BalanceEqualsSumOfBounties();
        invariant_I2_ActiveOrCancelledBountyEqualsStakes();
        invariant_I3_RevealedBountyIsZero();
        invariant_I4_UnmarkedKeyIsNeverPubliclyDecryptable();
        invariant_I5_EthIsConserved();
        invariant_I6_LedgerMatchesGhostAccounting();
        invariant_I7_RevealedKeyIsTheOwnersDek();
        invariant_I8_ValidActionsNeverRevert();
    }
}
