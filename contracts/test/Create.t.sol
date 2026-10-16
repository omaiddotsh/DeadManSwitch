// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DMSTestBase} from "./utils/DMSTestBase.sol";
import {DeadManSwitch} from "../src/DeadManSwitch.sol";
import {externalEuint64, externalEuint256} from "encrypted-types/EncryptedTypes.sol";
import {IInputVerifier} from "forge-fhevm/generated/interfaces/IInputVerifier.sol";
import {IFHEVMExecutor} from "forge-fhevm/generated/interfaces/IFHEVMExecutor.sol";
import {InputProofHelper} from "forge-fhevm/InputProofHelper.sol";

/// @notice `createSwitch`: stored state, event, escrow, FHE input binding, and every revert.
contract CreateTest is DMSTestBase {
    /// @dev A realistic clock so timestamps and oracle ages are non-trivial.
    uint64 internal constant T0 = 1_760_000_000;
    /// @dev $10 floor at $2,000/ETH (DMSTestBase defaults).
    uint256 internal constant MIN_BOUNTY_WEI = 0.005 ether;

    function setUp() public override {
        super.setUp();
        vm.warp(T0);
    }

    // ---------- Helpers ---------- //

    /// @dev Opaque bytes of an exact length (DMSTestBase's `_ciphertext` always adds the 61-byte overhead).
    function _rawCiphertext(uint256 len) internal pure returns (bytes memory c) {
        c = new bytes(len);
        for (uint256 i; i < len; i++) {
            c[i] = bytes1(uint8(uint256(keccak256(abi.encode("ct", i))) & 0xff));
        }
    }

    function _defaultCommitment() internal pure returns (bytes32) {
        return _commitment(SALT, PLAINTEXT);
    }

    /// @dev createSwitch on `target` as `owner` with an explicit encrypted input.
    function _submit(
        DeadManSwitch target,
        address owner,
        uint256 id,
        uint256 value,
        bytes memory ct,
        externalEuint256 h,
        bytes memory proof
    ) internal returns (bytes32) {
        vm.prank(owner);
        return target.createSwitch{value: value}(_params(id, INTERVAL, _defaultCommitment()), ct, h, proof);
    }

    /// @dev Default-shaped create for `owner`/`id` sealing an explicit DEK. Returns the handle.
    function _createWithDek(address owner, uint256 id, uint256 dek) internal returns (bytes32) {
        (externalEuint256 h, bytes memory proof) = _encKey(owner, dek);
        _submit(dms, owner, id, BOUNTY, _ciphertext(PLAINTEXT.length), h, proof);
        return externalEuint256.unwrap(h);
    }

    /// @dev A genuine mock-coprocessor input proof binding an *existing* handle to (user, target).
    function _signInputProof(bytes32 handle, address user, address target) internal view returns (bytes memory) {
        bytes32[] memory hs = new bytes32[](1);
        hs[0] = handle;
        bytes32 ds = InputProofHelper.computeInputVerifierDomainSeparator(address(_inputVerifier), block.chainid);
        bytes32 digest =
            InputProofHelper.computeInputVerificationDigest(hs, user, target, block.chainid, EMPTY_EXTRA_DATA, ds);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _signDigest(MOCK_INPUT_SIGNER_PK, digest);
        return InputProofHelper.assembleInputProof(hs, sigs, EMPTY_EXTRA_DATA);
    }

    /// @dev The address the InputVerifier recovers when a single-handle `proof` is checked
    ///      against (user, target) — i.e. the exact `InvalidSigner(address)` argument when the
    ///      proof was signed for a different (user, target) pair.
    function _recoveredSigner(bytes memory proof, address user, address target) internal view returns (address) {
        // Layout: numHandles(1) ‖ numSigners(1) ‖ handle(32) ‖ sig r(32) s(32) v(1) ‖ extraData
        require(uint8(proof[0]) == 1 && uint8(proof[1]) == 1, "single-handle, single-signer proof expected");
        bytes32 handle;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            handle := mload(add(proof, 34))
            r := mload(add(proof, 66))
            s := mload(add(proof, 98))
            v := byte(0, mload(add(proof, 130)))
        }
        bytes memory extraData = new bytes(proof.length - 99);
        for (uint256 i; i < extraData.length; i++) {
            extraData[i] = proof[99 + i];
        }
        bytes32[] memory hs = new bytes32[](1);
        hs[0] = handle;
        bytes32 ds = InputProofHelper.computeInputVerifierDomainSeparator(address(_inputVerifier), block.chainid);
        bytes32 digest = InputProofHelper.computeInputVerificationDigest(hs, user, target, block.chainid, extraData, ds);
        return ecrecover(digest, v, r, s);
    }

    function _expectInvalidSigner(bytes memory proof, address user, address target) internal {
        address recovered = _recoveredSigner(proof, user, target);
        assertTrue(recovered != mockInputSigner, "proof unexpectedly valid for this pair");
        vm.expectRevert(abi.encodeWithSelector(IInputVerifier.InvalidSigner.selector, recovered));
    }

    // ---------- Happy path: state, escrow, event ---------- //

    function test_Create_StoresEverySwitchInfoField() public {
        bytes memory ct = _ciphertext(PLAINTEXT.length);
        bytes32 commitment = _defaultCommitment();
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, ID));
        bytes32 handle = externalEuint256.unwrap(h);

        vm.prank(alice);
        bytes32 key = dms.createSwitch{value: BOUNTY}(_params(ID, INTERVAL, commitment), ct, h, proof);

        assertEq(key, keccak256(abi.encodePacked(alice, ID)), "key derivation");
        assertEq(key, dms.switchKey(alice, ID), "switchKey view");

        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(alice, ID);
        assertEq(info.owner, alice, "owner");
        assertEq(uint8(info.state), uint8(DeadManSwitch.State.ALIVE), "state");
        assertEq(info.lastPing, T0, "lastPing");
        assertEq(info.pingInterval, INTERVAL, "pingInterval");
        assertEq(info.createdAt, T0, "createdAt");
        assertEq(info.expiresAt, T0 + INTERVAL, "expiresAt");
        assertEq(info.darkMarkedAt, 0, "darkMarkedAt");
        assertEq(info.revealedAt, 0, "revealedAt");
        assertEq(info.bounty, BOUNTY, "bounty");
        assertEq(info.ownerStake, BOUNTY, "ownerStake");
        assertEq(info.plaintextCommitment, commitment, "plaintextCommitment");
        assertEq(info.encKeyHandle, handle, "encKeyHandle");
        assertEq(info.revealedKey, bytes32(0), "revealedKey");
        assertEq(info.ciphertextLength, ct.length, "ciphertextLength");
        assertFalse(info.published, "published");
        assertFalse(info.rescuable, "rescuable");

        // Point views agree with the aggregate.
        assertEq(dms.getCiphertext(alice, ID), ct, "ciphertext bytes");
        assertEq(dms.getEncKeyHandle(alice, ID), handle);
        assertEq(dms.getBounty(alice, ID), BOUNTY);
        assertEq(dms.getOwnerStake(alice, ID), BOUNTY);
        assertEq(dms.getFunderStake(alice, ID, alice), 0);
        assertEq(dms.getRevealedKey(alice, ID), bytes32(0));
        assertEq(dms.expirationTime(alice, ID), T0 + INTERVAL);
        assertTrue(dms.isAlive(alice, ID));
        assertFalse(dms.isDark(alice, ID));
    }

    function test_Create_EscrowsMsgValueAsOwnerStake() public {
        uint256 aliceBefore = alice.balance;
        uint256 dmsBefore = address(dms).balance;

        _create();

        assertEq(alice.balance, aliceBefore - BOUNTY, "owner paid the bounty");
        assertEq(address(dms).balance, dmsBefore + BOUNTY, "contract holds the bounty");
        // Invariant at creation: bounty == ownerStake (no funders yet).
        assertEq(dms.getOwnerStake(alice, ID), BOUNTY);
        assertEq(dms.getBounty(alice, ID), dms.getOwnerStake(alice, ID));
    }

    function test_Create_EmitsSwitchCreatedWithAllFields() public {
        // Distinct values in every field so a swapped field cannot pass.
        uint256 id = 42;
        uint64 interval = 3 days + 7;
        uint256 bounty = 0.0123 ether;
        bytes32 commitment = _commitment(bytes32(uint256(7)), bytes("event payload"));
        bytes memory ct = _ciphertext(13);
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, id));
        bytes32 key = dms.switchKey(alice, id);

        vm.expectEmit(true, true, true, true, address(dms));
        emit DeadManSwitch.SwitchCreated(
            key, alice, id, interval, T0, bounty, commitment, externalEuint256.unwrap(h), ct
        );
        vm.prank(alice);
        dms.createSwitch{value: bounty}(_params(id, interval, commitment), ct, h, proof);
    }

    // ---------- The encrypted DEK ---------- //

    function test_Create_SealsKeyToContractOnlyAndMarksHandleUsed() public {
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, ID));
        bytes32 handle = externalEuint256.unwrap(h);
        assertFalse(dms.keyHandleUsed(handle), "unused before create");

        _submit(dms, alice, ID, BOUNTY, _ciphertext(PLAINTEXT.length), h, proof);

        assertTrue(dms.keyHandleUsed(handle), "bound after create");
        assertTrue(_acl.persistAllowed(handle, address(dms)), "contract may use its key later (allowThis)");
        // No FHE.allow(user) path: not even the owner can user-decrypt the DEK.
        assertFalse(_acl.persistAllowed(handle, alice), "owner not on the ACL");
        assertFalse(_isPubliclyDecryptable(handle), "sealed until markDark");
    }

    function test_Create_StoredHandleDecryptsToOwnersDek() public {
        // Full-width DEKs: the top bit set proves no truncation below 256 bits.
        uint256 dekA = type(uint256).max;
        uint256 dekB = uint256(keccak256("bob's dek")) | (uint256(1) << 255);
        bytes32 handleA = _createWithDek(alice, ID, dekA);
        bytes32 handleB = _createWithDek(bob, ID, dekB);
        assertTrue(handleA != handleB);
        assertEq(dms.getEncKeyHandle(alice, ID), handleA);
        assertEq(dms.getEncKeyHandle(bob, ID), handleB);

        _darkAndMark(alice, ID);
        _darkAndMark(bob, ID);

        (bytes32 clearA, bytes memory proofA) = _kmsDecrypt(alice, ID);
        (bytes32 clearB,) = _kmsDecrypt(bob, ID);
        assertEq(uint256(clearA), dekA, "alice's handle -> alice's DEK");
        assertEq(uint256(clearB), dekB, "bob's handle -> bob's DEK");

        // The KMS proof over that cleartext verifies against the stored handle.
        vm.prank(carol);
        dms.revealKey(alice, ID, clearA, proofA);
        assertEq(dms.getRevealedKey(alice, ID), bytes32(dekA));
    }

    // ---------- Parameter validation ---------- //

    function test_Create_RevertsInvalidSwitchIdZero() public {
        (externalEuint256 h, bytes memory proof) = _encKey(alice, 1);
        bytes memory ct = _ciphertext(PLAINTEXT.length);
        vm.expectRevert(DeadManSwitch.InvalidSwitchId.selector);
        _submit(dms, alice, 0, BOUNTY, ct, h, proof);
        assertEq(uint8(dms.getState(alice, 0)), uint8(DeadManSwitch.State.NONE));
    }

    function test_Create_RevertsInvalidIntervalOutsideBounds() public {
        uint64 minI = uint64(dms.MIN_PING_INTERVAL());
        uint64 maxI = uint64(dms.MAX_PING_INTERVAL());
        (externalEuint256 h, bytes memory proof) = _encKey(alice, 1);
        bytes memory ct = _ciphertext(PLAINTEXT.length);
        bytes32 commitment = _defaultCommitment();

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.InvalidInterval.selector);
        dms.createSwitch{value: BOUNTY}(_params(ID, minI - 1, commitment), ct, h, proof);

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.InvalidInterval.selector);
        dms.createSwitch{value: BOUNTY}(_params(ID, maxI + 1, commitment), ct, h, proof);

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.InvalidInterval.selector);
        dms.createSwitch{value: BOUNTY}(_params(ID, 0, commitment), ct, h, proof);
    }

    function test_Create_AcceptsIntervalBoundsExactly() public {
        uint64 minI = uint64(dms.MIN_PING_INTERVAL());
        uint64 maxI = uint64(dms.MAX_PING_INTERVAL());
        assertEq(minI, 60);
        assertEq(maxI, 365 days);
        bytes memory ct = _ciphertext(PLAINTEXT.length);

        _create(alice, 1, minI, BOUNTY, _defaultCommitment(), ct);
        _create(alice, 2, maxI, BOUNTY, _defaultCommitment(), ct);

        assertEq(dms.getSwitchInfo(alice, 1).pingInterval, minI);
        assertEq(dms.expirationTime(alice, 1), T0 + minI);
        assertEq(dms.getSwitchInfo(alice, 2).pingInterval, maxI);
        assertEq(dms.expirationTime(alice, 2), T0 + maxI);
        assertTrue(dms.isAlive(alice, 1));
        assertTrue(dms.isAlive(alice, 2));
    }

    function test_Create_RevertsCiphertextTooSmall() public {
        uint256 overhead = dms.CIPHERTEXT_OVERHEAD();
        assertEq(overhead, 61);
        (externalEuint256 h, bytes memory proof) = _encKey(alice, 1);
        bytes memory empty = "";
        bytes memory oneShort = _rawCiphertext(overhead - 1);

        vm.expectRevert(DeadManSwitch.CiphertextTooSmall.selector);
        _submit(dms, alice, ID, BOUNTY, empty, h, proof);

        vm.expectRevert(DeadManSwitch.CiphertextTooSmall.selector);
        _submit(dms, alice, ID, BOUNTY, oneShort, h, proof);
    }

    function test_Create_AcceptsMinimumCiphertext() public {
        bytes memory ct = _rawCiphertext(dms.CIPHERTEXT_OVERHEAD()); // empty plaintext
        _create(alice, ID, INTERVAL, BOUNTY, _defaultCommitment(), ct);
        assertEq(dms.getSwitchInfo(alice, ID).ciphertextLength, 61);
        assertEq(dms.getCiphertext(alice, ID), ct);
    }

    function test_Create_RevertsCiphertextTooLarge() public {
        uint256 maxSize = dms.MAX_CIPHERTEXT_SIZE();
        assertEq(maxSize, 2048 + 61);
        (externalEuint256 h, bytes memory proof) = _encKey(alice, 1);
        bytes memory ct = _rawCiphertext(maxSize + 1);

        vm.expectRevert(DeadManSwitch.CiphertextTooLarge.selector);
        _submit(dms, alice, ID, BOUNTY, ct, h, proof);
    }

    function test_Create_AcceptsMaximumCiphertext() public {
        bytes memory ct = _ciphertext(dms.MAX_PAYLOAD_SIZE()); // == MAX_CIPHERTEXT_SIZE bytes
        assertEq(ct.length, dms.MAX_CIPHERTEXT_SIZE());
        _create(alice, ID, INTERVAL, BOUNTY, _defaultCommitment(), ct);
        assertEq(dms.getSwitchInfo(alice, ID).ciphertextLength, ct.length);
        assertEq(dms.getCiphertext(alice, ID), ct, "every byte stored");
    }

    function test_Create_RevertsEmptyCommitment() public {
        (externalEuint256 h, bytes memory proof) = _encKey(alice, 1);
        bytes memory ct = _ciphertext(PLAINTEXT.length);
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.EmptyCommitment.selector);
        dms.createSwitch{value: BOUNTY}(_params(ID, INTERVAL, bytes32(0)), ct, h, proof);
    }

    /// @dev The selector is unambiguous: with an empty proof `FHE.fromExternal` never reaches the
    ///      InputVerifier (whose own `EmptyInputProof()` shares the selector) — it would either map
    ///      the zero handle to a trivial encryption of 0 or revert `SenderNotAllowedToUseHandle`.
    function test_Create_RevertsEmptyInputProof() public {
        bytes memory ct = _ciphertext(PLAINTEXT.length);
        bytes memory noProof = "";

        // The zero handle: without the guard this would seal a public trivial encryption of 0.
        vm.expectRevert(DeadManSwitch.EmptyInputProof.selector);
        _submit(dms, alice, ID, BOUNTY, ct, externalEuint256.wrap(bytes32(0)), noProof);

        // A genuine handle with its proof stripped.
        (externalEuint256 h,) = _encKey(alice, 1);
        vm.expectRevert(DeadManSwitch.EmptyInputProof.selector);
        _submit(dms, alice, ID, BOUNTY, ct, h, noProof);

        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.NONE));
    }

    // ---------- Uniqueness ---------- //

    function test_Create_RevertsAlreadyExistsForSameOwnerAndId() public {
        bytes32 firstHandle = dms.getEncKeyHandle(alice, ID);
        assertEq(firstHandle, bytes32(0));
        _create();
        firstHandle = dms.getEncKeyHandle(alice, ID);

        (externalEuint256 h, bytes memory proof) = _encKey(alice, 999);
        bytes memory ct = _ciphertext(1);
        vm.expectRevert(DeadManSwitch.AlreadyExists.selector);
        _submit(dms, alice, ID, BOUNTY, ct, h, proof);

        // The original switch is untouched and the fresh handle is still unbound.
        assertEq(dms.getEncKeyHandle(alice, ID), firstHandle);
        assertEq(dms.getBounty(alice, ID), BOUNTY);
        assertFalse(dms.keyHandleUsed(externalEuint256.unwrap(h)));
    }

    function test_Create_RevertsAlreadyExistsAfterCancel() public {
        _create();
        vm.prank(alice);
        dms.cancel(ID);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.CANCELLED));

        // A cancelled id is never reusable: it must not resurrect into a live switch.
        (externalEuint256 h, bytes memory proof) = _encKey(alice, 999);
        bytes memory ct = _ciphertext(PLAINTEXT.length);
        vm.expectRevert(DeadManSwitch.AlreadyExists.selector);
        _submit(dms, alice, ID, BOUNTY, ct, h, proof);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.CANCELLED));
    }

    function test_Create_SameIdForDifferentOwnerSucceeds() public {
        bytes32 keyA = _create(alice, ID);
        bytes32 keyB = _create(bob, ID, 2 days, 0.02 ether, _commitment(SALT, "bob"), _ciphertext(5));

        assertTrue(keyA != keyB, "keys are per owner");
        assertEq(keyB, keccak256(abi.encodePacked(bob, ID)));
        assertEq(dms.getSwitchInfo(alice, ID).owner, alice);
        assertEq(dms.getSwitchInfo(bob, ID).owner, bob);
        assertEq(dms.getOwnerStake(alice, ID), BOUNTY);
        assertEq(dms.getOwnerStake(bob, ID), 0.02 ether);
        assertEq(dms.expirationTime(alice, ID), T0 + INTERVAL);
        assertEq(dms.expirationTime(bob, ID), T0 + 2 days);
        assertTrue(dms.getEncKeyHandle(alice, ID) != dms.getEncKeyHandle(bob, ID));
        assertEq(address(dms).balance, BOUNTY + 0.02 ether);
    }

    function test_Create_RevertsKeyHandleReusedForSecondId() public {
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, 1));
        bytes memory ct = _ciphertext(PLAINTEXT.length);
        _submit(dms, alice, 1, BOUNTY, ct, h, proof);

        // Identical encrypted input + proof replayed for a second switch.
        vm.expectRevert(DeadManSwitch.KeyHandleReused.selector);
        _submit(dms, alice, 2, BOUNTY, ct, h, proof);

        assertEq(uint8(dms.getState(alice, 2)), uint8(DeadManSwitch.State.NONE));
        assertEq(dms.getOwnerStake(alice, 2), 0);
    }

    /// @dev Even a *validly signed* proof binding an already-used handle to a different owner is
    ///      rejected: otherwise marking either switch dark would publish the other's key.
    function test_Create_RevertsKeyHandleReusedAcrossOwners() public {
        (externalEuint256 h, bytes memory proofA) = _encKey(alice, _dekFor(alice, ID));
        bytes32 handle = externalEuint256.unwrap(h);
        bytes memory ct = _ciphertext(PLAINTEXT.length);
        // Sanity: the signing helper reproduces the harness's genuine proof byte for byte.
        assertEq(_signInputProof(handle, alice, address(dms)), proofA);
        _submit(dms, alice, ID, BOUNTY, ct, h, proofA);

        bytes memory proofForBob = _signInputProof(handle, bob, address(dms));
        vm.expectRevert(DeadManSwitch.KeyHandleReused.selector);
        _submit(dms, bob, ID, BOUNTY, ct, h, proofForBob);
        assertEq(uint8(dms.getState(bob, ID)), uint8(DeadManSwitch.State.NONE));
    }

    // ---------- Input-proof binding (InputVerifier) ---------- //

    function test_Create_RevertsInputProofBoundToAnotherUser() public {
        // Bob's encryption, submitted by alice.
        (externalEuint256 h, bytes memory proof) = encryptUint256(_dekFor(bob, ID), bob, address(dms));
        bytes memory ct = _ciphertext(PLAINTEXT.length);

        _expectInvalidSigner(proof, alice, address(dms));
        _submit(dms, alice, ID, BOUNTY, ct, h, proof);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.NONE));
        assertFalse(dms.keyHandleUsed(externalEuint256.unwrap(h)));

        // Control: the same input is valid for the user it was encrypted for.
        _submit(dms, bob, ID, BOUNTY, ct, h, proof);
        assertEq(dms.getEncKeyHandle(bob, ID), externalEuint256.unwrap(h));
    }

    function test_Create_RevertsInputProofBoundToAnotherContract() public {
        DeadManSwitch other = new DeadManSwitch(address(feed), MIN_USD, MAX_PRICE_AGE);
        (externalEuint256 h, bytes memory proof) = encryptUint256(_dekFor(alice, ID), alice, address(other));
        bytes memory ct = _ciphertext(PLAINTEXT.length);

        _expectInvalidSigner(proof, alice, address(dms));
        _submit(dms, alice, ID, BOUNTY, ct, h, proof);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.NONE));

        // Control: the same input is valid on the contract it was encrypted for.
        _submit(other, alice, ID, BOUNTY, ct, h, proof);
        assertEq(other.getEncKeyHandle(alice, ID), externalEuint256.unwrap(h));
    }

    function test_Create_RevertsProofForDifferentHandle() public {
        (externalEuint256 h1,) = _encKey(alice, 1);
        (, bytes memory proof2) = _encKey(alice, 2);
        bytes memory ct = _ciphertext(PLAINTEXT.length);

        vm.expectRevert(IInputVerifier.InvalidInputHandle.selector);
        _submit(dms, alice, ID, BOUNTY, ct, h1, proof2);
    }

    function test_Create_RevertsWhenInputIsNotEuint256() public {
        (externalEuint64 h64, bytes memory proof) = encryptUint64(123, alice, address(dms));
        externalEuint256 h = externalEuint256.wrap(externalEuint64.unwrap(h64));
        bytes memory ct = _ciphertext(PLAINTEXT.length);

        vm.expectRevert(IFHEVMExecutor.InvalidType.selector);
        _submit(dms, alice, ID, BOUNTY, ct, h, proof);
    }

    // ---------- Bounty floor and oracle ---------- //

    function test_Create_RevertsBountyTooLowAndAcceptsExactMinimum() public {
        uint256 min = dms.minBounty();
        assertEq(min, MIN_BOUNTY_WEI, "$10 at $2,000/ETH");
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, ID));
        bytes memory ct = _ciphertext(PLAINTEXT.length);

        vm.expectRevert(DeadManSwitch.BountyTooLow.selector);
        _submit(dms, alice, ID, min - 1, ct, h, proof);

        uint256 dmsBefore = address(dms).balance;
        _submit(dms, alice, ID, min, ct, h, proof);
        assertEq(dms.getBounty(alice, ID), min);
        assertEq(dms.getOwnerStake(alice, ID), min);
        assertEq(address(dms).balance, dmsBefore + min);
    }

    function test_Create_StalePriceFailsOpenAndBoundaryEnforcesFloor() public {
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, ID));
        bytes memory ct = _ciphertext(PLAINTEXT.length);

        // Exactly maxPriceAge old is still fresh: the floor applies.
        feed.setUpdatedAt(T0 - MAX_PRICE_AGE);
        (bool ok, uint256 price) = dms.oraclePrice();
        assertTrue(ok);
        assertEq(price, uint256(ETH_USD));
        assertEq(dms.minBounty(), 0.005 ether);
        vm.expectRevert(DeadManSwitch.BountyTooLow.selector);
        _submit(dms, alice, ID, 0, ct, h, proof);

        // One second older: the oracle is unusable and the floor fails open to 0.
        feed.setUpdatedAt(T0 - MAX_PRICE_AGE - 1);
        (ok,) = dms.oraclePrice();
        assertFalse(ok);
        assertEq(dms.minBounty(), 0);
        _submit(dms, alice, ID, 0, ct, h, proof);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.ALIVE));
        assertEq(dms.getBounty(alice, ID), 0);
    }

    function test_Create_FutureUpdatedAtFailsOpen() public {
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, ID));
        bytes memory ct = _ciphertext(PLAINTEXT.length);

        feed.setUpdatedAt(T0 + 1);
        (bool ok,) = dms.oraclePrice();
        assertFalse(ok);
        assertEq(dms.minBounty(), 0);
        _submit(dms, alice, ID, 0, ct, h, proof);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.ALIVE));
    }

    function test_Create_ZeroOrNegativePriceFailsOpen() public {
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, ID));
        bytes memory ct = _ciphertext(PLAINTEXT.length);

        feed.setPrice(0);
        (bool ok,) = dms.oraclePrice();
        assertFalse(ok);
        assertEq(dms.minBounty(), 0);

        feed.setPrice(-1);
        (ok,) = dms.oraclePrice();
        assertFalse(ok);
        assertEq(dms.minBounty(), 0);
        _submit(dms, alice, ID, 0, ct, h, proof);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.ALIVE));
    }

    function test_Create_FloorDisabledWithoutFeedAcceptsZeroValue() public {
        DeadManSwitch noFloor = new DeadManSwitch(address(0), 0, 0);
        assertEq(address(noFloor.ethUsdPriceFeed()), address(0));
        assertEq(noFloor.minBountyUsd(), 0);
        assertEq(noFloor.minBounty(), 0);

        (externalEuint256 h, bytes memory proof) = encryptUint256(_dekFor(alice, ID), alice, address(noFloor));
        uint256 aliceBefore = alice.balance;
        _submit(noFloor, alice, ID, 0, _ciphertext(PLAINTEXT.length), h, proof);

        DeadManSwitch.SwitchInfo memory info = noFloor.getSwitchInfo(alice, ID);
        assertEq(uint8(info.state), uint8(DeadManSwitch.State.ALIVE));
        assertEq(info.bounty, 0);
        assertEq(info.ownerStake, 0);
        assertEq(info.encKeyHandle, externalEuint256.unwrap(h));
        assertEq(alice.balance, aliceBefore);
        assertEq(address(noFloor).balance, 0);
    }

    function test_Create_FloorDisabledByAdminIgnoresBrokenFeed() public {
        dms.setMinBountyUsd(0); // this test contract deployed `dms`, so it is admin
        feed.setPrice(0); // the oracle is down; it must not be consulted
        assertEq(dms.minBounty(), 0);

        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, ID));
        _submit(dms, alice, ID, 0, _ciphertext(PLAINTEXT.length), h, proof);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.ALIVE));
        assertEq(dms.getBounty(alice, ID), 0);
    }
}
