// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DMSTestBase, NonReceiver} from "./utils/DMSTestBase.sol";
import {DeadManSwitch} from "../src/DeadManSwitch.sol";
import {FHE} from "@fhevm/solidity/lib/FHE.sol";
import {externalEuint256} from "encrypted-types/EncryptedTypes.sol";
import {IKMSVerifier} from "forge-fhevm/generated/interfaces/IKMSVerifier.sol";
import {KMSDecryptionProofHelper} from "forge-fhevm/KMSDecryptionProofHelper.sol";

/**
 * @notice A revealer whose `receive()` re-enters the contract while it is being paid.
 *         It also owns a live switch and holds a reclaimable contribution on a
 *         cancelled switch, so the reentrant `cancel` / `reclaimContribution` would
 *         succeed if the transient lock were not there.
 */
contract ReentrantRevealer {
    DeadManSwitch internal immutable dms;

    // revealKey / publishPlaintext target
    address internal tOwner;
    uint256 internal tId;
    bytes32 internal tKey;
    bytes internal tProof;
    bytes32 internal tSalt;
    bytes internal tPayload;

    // the attacker's own live switch, and a cancelled switch it funded
    uint256 internal ownId;
    address internal fundedOwner;
    uint256 internal fundedId;

    bool internal armed;
    uint256 public receiveCount;

    // observed from inside the payout callback
    DeadManSwitch.State public stateSeen;
    uint256 public bountySeen;
    bytes32 public revealedKeySeen;

    bool public revealOk;
    bytes public revealErr;
    bool public cancelOk;
    bytes public cancelErr;
    bool public reclaimOk;
    bytes public reclaimErr;
    bool public publishOk;
    bytes public publishErr;

    constructor(DeadManSwitch _dms) {
        dms = _dms;
    }

    function createOwn(
        DeadManSwitch.CreateParams calldata p,
        bytes calldata ct,
        externalEuint256 h,
        bytes calldata inputProof
    ) external payable {
        ownId = p.id;
        dms.createSwitch{value: msg.value}(p, ct, h, inputProof);
    }

    function fund(address owner, uint256 id) external payable {
        fundedOwner = owner;
        fundedId = id;
        dms.fundBounty{value: msg.value}(owner, id);
    }

    function attack(
        address owner,
        uint256 id,
        bytes32 dataKey,
        bytes calldata proof,
        bytes32 salt,
        bytes calldata payload
    ) external {
        tOwner = owner;
        tId = id;
        tKey = dataKey;
        tProof = proof;
        tSalt = salt;
        tPayload = payload;
        armed = true;
        dms.revealKey(owner, id, dataKey, proof);
    }

    function cancelOwn() external {
        dms.cancel(ownId);
    }

    function reclaimFunded() external {
        dms.reclaimContribution(fundedOwner, fundedId);
    }

    receive() external payable {
        receiveCount++;
        if (!armed) return;
        armed = false;

        stateSeen = dms.getState(tOwner, tId);
        bountySeen = dms.getBounty(tOwner, tId);
        revealedKeySeen = dms.getRevealedKey(tOwner, tId);

        try dms.revealKey(tOwner, tId, tKey, tProof) {
            revealOk = true;
        } catch (bytes memory e) {
            revealErr = e;
        }
        try dms.cancel(ownId) {
            cancelOk = true;
        } catch (bytes memory e) {
            cancelErr = e;
        }
        try dms.reclaimContribution(fundedOwner, fundedId) {
            reclaimOk = true;
        } catch (bytes memory e) {
            reclaimErr = e;
        }
        try dms.publishPlaintext(tOwner, tId, tSalt, tPayload) {
            publishOk = true;
        } catch (bytes memory e) {
            publishErr = e;
        }
    }
}

/// @notice markDark, revealKey and publishPlaintext.
contract ReleaseTest is DMSTestBase {
    uint256 internal constant ROGUE_KMS_PK = uint256(keccak256("rogue kms signer"));

    // ---------- local helpers ---------- //

    /// @dev Under via_ir the optimizer may treat `block.timestamp` as constant for the
    ///      whole test function and ignore `vm.warp`; always read the live value.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _assertState(address owner, uint256 id, DeadManSwitch.State expected) internal view {
        assertEq(uint8(dms.getState(owner, id)), uint8(expected), "state");
    }

    function _fund(address funder, address owner, uint256 id, uint256 amount) internal {
        vm.prank(funder);
        dms.fundBounty{value: amount}(owner, id);
    }

    function _handle(address owner, uint256 id) internal view returns (bytes32) {
        return dms.getEncKeyHandle(owner, id);
    }

    function _dek(address owner, uint256 id) internal pure returns (bytes32) {
        return bytes32(_dekFor(owner, id));
    }

    function _bytes(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i++) {
            b[i] = bytes1(uint8(i % 251) + 1);
        }
    }

    /// @dev Create alice#ID committing to `payload` under SALT, with a ciphertext of matching size
    ///      (capped at the contract's maximum; the contract never parses it).
    function _createWithPayload(bytes memory payload) internal returns (bytes32) {
        uint256 ctLen = payload.length > dms.MAX_PAYLOAD_SIZE() ? dms.MAX_PAYLOAD_SIZE() : payload.length;
        return _create(alice, ID, INTERVAL, BOUNTY, _commitment(SALT, payload), _ciphertext(ctLen));
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

    /// @dev The address the verifier recovers when single-signature `proof` is checked
    ///      against (handle, dataKey). Lets tests assert the exact KMSInvalidSigner revert.
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

    function _expectInvalidSigner(address signer) internal {
        vm.expectRevert(abi.encodeWithSelector(IKMSVerifier.KMSInvalidSigner.selector, signer));
    }

    /// @dev Asserts that a failed reveal left (owner, id) exactly as markDark left it.
    function _assertStillDarkMarked(address owner, uint256 id, uint256 bounty) internal view {
        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(owner, id);
        assertEq(uint8(info.state), uint8(DeadManSwitch.State.DARK_MARKED), "state");
        assertEq(info.bounty, bounty, "bounty");
        assertEq(info.revealedKey, bytes32(0), "revealedKey");
        assertEq(info.revealedAt, 0, "revealedAt");
    }

    // ===================================================================== //
    //                                markDark                               //
    // ===================================================================== //

    function test_MarkDark_RevertsNotDarkBeforeDeadline() public {
        _create();
        uint256 originalDeadline = dms.expirationTime(alice, ID);
        vm.warp(_now() + 10 hours);
        vm.prank(alice);
        dms.ping(ID);
        uint256 deadline = dms.expirationTime(alice, ID);
        assertEq(deadline, _now() + INTERVAL, "ping moved the deadline");

        // The pre-ping deadline no longer counts.
        vm.warp(originalDeadline);
        vm.expectRevert(DeadManSwitch.NotDark.selector);
        dms.markDark(alice, ID);

        vm.warp(deadline - 1);
        vm.expectRevert(DeadManSwitch.NotDark.selector);
        vm.prank(eve);
        dms.markDark(alice, ID);

        _assertState(alice, ID, DeadManSwitch.State.ALIVE);
        assertEq(dms.getSwitchInfo(alice, ID).darkMarkedAt, 0, "darkMarkedAt");
        assertFalse(_isPubliclyDecryptable(_handle(alice, ID)), "decryptable");
    }

    function test_MarkDark_SucceedsExactlyAtDeadline() public {
        bytes32 key = _create();
        bytes32 handle = _handle(alice, ID);
        _warpToDark(alice, ID);
        uint64 nowTs = uint64(_now());
        _assertState(alice, ID, DeadManSwitch.State.DARK);
        assertFalse(_isPubliclyDecryptable(handle), "decryptable before mark");
        uint256 dmsBefore = address(dms).balance;
        uint256 eveBefore = eve.balance;

        vm.expectEmit(address(dms));
        emit DeadManSwitch.SwitchDarkMarked(key, eve, handle, nowTs);
        vm.prank(eve); // not the owner
        dms.markDark(alice, ID);

        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(alice, ID);
        assertEq(uint8(info.state), uint8(DeadManSwitch.State.DARK_MARKED), "state");
        assertEq(info.darkMarkedAt, nowTs, "darkMarkedAt");
        assertEq(info.encKeyHandle, handle, "handle unchanged");
        assertEq(info.bounty, BOUNTY, "bounty untouched");
        assertEq(info.ownerStake, BOUNTY, "ownerStake untouched");
        assertEq(info.revealedKey, bytes32(0), "revealedKey");
        assertEq(info.revealedAt, 0, "revealedAt");
        assertFalse(info.rescuable, "rescuable");
        assertTrue(dms.isDark(alice, ID), "isDark");
        assertEq(address(dms).balance, dmsBefore, "no ETH moved");
        assertEq(eve.balance, eveBefore, "caller unpaid");

        assertTrue(_isPubliclyDecryptable(handle), "decryptable after mark");
        (bytes32 clear,) = _kmsDecrypt(alice, ID);
        assertEq(clear, _dek(alice, ID), "KMS serves the DEK");
    }

    function testFuzz_MarkDark_AnyCallerCanMark(address caller) public {
        assumeNotForgeAddress(caller);
        bytes32 key = _create();
        _warpToDark(alice, ID);

        vm.expectEmit(address(dms));
        emit DeadManSwitch.SwitchDarkMarked(key, caller, _handle(alice, ID), uint64(_now()));
        vm.prank(caller);
        dms.markDark(alice, ID);

        _assertState(alice, ID, DeadManSwitch.State.DARK_MARKED);
        assertTrue(_isPubliclyDecryptable(_handle(alice, ID)));
    }

    function test_MarkDark_RevertsAlreadyDarkMarked() public {
        _create();
        _darkAndMark(alice, ID);
        uint64 markedAt = uint64(_now());

        vm.warp(_now() + 1 days);
        vm.expectRevert(DeadManSwitch.AlreadyDarkMarked.selector);
        vm.prank(eve);
        dms.markDark(alice, ID);

        assertEq(dms.getSwitchInfo(alice, ID).darkMarkedAt, markedAt, "darkMarkedAt keeps the first mark");
        _assertState(alice, ID, DeadManSwitch.State.DARK_MARKED);
    }

    function test_MarkDark_RevertsNotActiveWhenCancelled() public {
        _create();
        vm.prank(alice);
        dms.cancel(ID);

        _warpToDark(alice, ID);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.markDark(alice, ID);

        // Still refused long after the deadline: a cancelled DEK is sealed forever.
        vm.warp(_now() + dms.RESCUE_DELAY() + 365 days);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        vm.prank(eve);
        dms.markDark(alice, ID);

        _assertState(alice, ID, DeadManSwitch.State.CANCELLED);
        assertEq(dms.getSwitchInfo(alice, ID).darkMarkedAt, 0, "darkMarkedAt");
        assertFalse(_isPubliclyDecryptable(_handle(alice, ID)), "decryptable");
    }

    function test_MarkDark_RevertsNotActiveWhenRevealed() public {
        _create();
        _reveal(alice, ID, eve);
        uint64 markedAt = dms.getSwitchInfo(alice, ID).darkMarkedAt;

        vm.warp(_now() + 1 hours);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.markDark(alice, ID);

        _assertState(alice, ID, DeadManSwitch.State.REVEALED);
        assertEq(dms.getSwitchInfo(alice, ID).darkMarkedAt, markedAt, "darkMarkedAt");
    }

    function test_MarkDark_RevertsDoesNotExist() public {
        _create();
        _warpToDark(alice, ID);

        // Switches are keyed by (owner, id): neither a different id nor a different owner exists.
        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        dms.markDark(alice, ID + 1);
        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        dms.markDark(bob, ID);

        _assertState(alice, ID, DeadManSwitch.State.DARK);
    }

    function test_MarkDark_OwnerCannotPingFundOrCancelAfterwards() public {
        _create();
        _darkAndMark(alice, ID);
        uint256 dmsBefore = address(dms).balance;

        vm.expectRevert(DeadManSwitch.Expired.selector);
        vm.prank(alice);
        dms.ping(ID);

        vm.expectRevert(DeadManSwitch.Expired.selector);
        vm.prank(alice);
        dms.cancel(ID);

        vm.expectRevert(DeadManSwitch.Expired.selector);
        vm.prank(bob);
        dms.fundBounty{value: 1 ether}(alice, ID);

        _assertState(alice, ID, DeadManSwitch.State.DARK_MARKED);
        assertTrue(_isPubliclyDecryptable(_handle(alice, ID)), "still decryptable");
        assertEq(dms.getBounty(alice, ID), BOUNTY, "bounty");
        assertEq(address(dms).balance, dmsBefore, "no ETH moved");
    }

    // ===================================================================== //
    //                                revealKey                              //
    // ===================================================================== //

    function test_RevealKey_PaysWholePotToRevealer() public {
        bytes32 key = _create();
        _fund(bob, alice, ID, 1 ether);
        _fund(carol, alice, ID, 0.25 ether);
        _fund(bob, alice, ID, 0.1 ether);
        uint256 pot = BOUNTY + 1.35 ether;
        assertEq(dms.getBounty(alice, ID), pot, "pot");

        _darkAndMark(alice, ID);
        uint64 markedAt = uint64(_now());
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);
        assertEq(dek, _dek(alice, ID), "KMS cleartext");

        vm.warp(_now() + 10 minutes);
        uint64 nowTs = uint64(_now());
        uint256 eveBefore = eve.balance;
        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        uint256 carolBefore = carol.balance;
        uint256 dmsBefore = address(dms).balance;

        bytes32[] memory hs = new bytes32[](1);
        hs[0] = _handle(alice, ID);
        vm.expectEmit(address(dms));
        emit FHE.PublicDecryptionVerified(hs, abi.encode(dek));
        vm.expectEmit(address(dms));
        emit DeadManSwitch.KeyRevealed(key, eve, dek, pot, nowTs);
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, proof);

        assertEq(eve.balance - eveBefore, pot, "revealer paid the whole pot");
        assertEq(dmsBefore - address(dms).balance, pot, "contract paid out exactly the pot");
        assertEq(address(dms).balance, 0, "nothing left behind");
        assertEq(alice.balance, aliceBefore, "owner gets nothing");
        assertEq(bob.balance, bobBefore, "funder gets nothing");
        assertEq(carol.balance, carolBefore, "funder gets nothing");

        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(alice, ID);
        assertEq(uint8(info.state), uint8(DeadManSwitch.State.REVEALED), "state");
        assertEq(info.bounty, 0, "bounty zeroed");
        assertEq(info.revealedKey, dek, "revealedKey");
        assertEq(dms.getRevealedKey(alice, ID), dek, "getRevealedKey");
        assertEq(info.revealedAt, nowTs, "revealedAt");
        assertEq(info.darkMarkedAt, markedAt, "darkMarkedAt untouched");
        assertFalse(info.published, "published");
        assertFalse(info.rescuable, "rescuable");
        assertFalse(dms.isDark(alice, ID), "isDark");
        assertFalse(dms.isAlive(alice, ID), "isAlive");
    }

    function test_RevealKey_ZeroBountySwitchReveals() public {
        dms.setMinBountyUsd(0); // this test contract deployed dms, so it is admin
        bytes32 key = _create(alice, ID, INTERVAL, 0, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));
        _darkAndMark(alice, ID);
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);

        // A revealer that rejects ETH succeeds: no transfer is attempted for a zero pot.
        NonReceiver nr = new NonReceiver();
        vm.expectEmit(address(dms));
        emit DeadManSwitch.KeyRevealed(key, address(nr), dek, 0, uint64(_now()));
        nr.call(address(dms), abi.encodeCall(DeadManSwitch.revealKey, (alice, ID, dek, proof)));

        _assertState(alice, ID, DeadManSwitch.State.REVEALED);
        assertEq(dms.getRevealedKey(alice, ID), dek, "revealedKey");
        assertEq(dms.getSwitchInfo(alice, ID).revealedAt, _now(), "revealedAt");
        assertEq(address(nr).balance, 0, "nothing paid");
    }

    function test_RevealKey_RevertsNotDarkMarkedWhenUnmarked() public {
        _create();
        _fund(bob, alice, ID, 1 ether);
        bytes32 dek = _dek(alice, ID);
        // A genuinely KMS-signed proof for the right key: only the missing mark stops it.
        bytes memory proof = buildDecryptionProof(_handle(alice, ID), abi.encode(dek));

        vm.expectRevert(DeadManSwitch.NotDarkMarked.selector);
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, proof);

        _warpToDark(alice, ID);
        _assertState(alice, ID, DeadManSwitch.State.DARK);
        vm.expectRevert(DeadManSwitch.NotDarkMarked.selector);
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, proof);

        _assertState(alice, ID, DeadManSwitch.State.DARK);
        assertEq(dms.getBounty(alice, ID), BOUNTY + 1 ether, "bounty");
        assertEq(dms.getRevealedKey(alice, ID), bytes32(0), "revealedKey");
        assertFalse(_isPubliclyDecryptable(_handle(alice, ID)), "decryptable");
    }

    function test_RevealKey_RevertsDoesNotExist() public {
        _create();
        _darkAndMark(alice, ID);
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);

        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        vm.prank(eve);
        dms.revealKey(alice, ID + 1, dek, proof);
        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        vm.prank(eve);
        dms.revealKey(bob, ID, dek, proof);

        _assertStillDarkMarked(alice, ID, BOUNTY);
    }

    function test_RevealKey_RevertsWithWrongDataKey() public {
        _create();
        _darkAndMark(alice, ID);
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);
        bytes32 handle = _handle(alice, ID);
        bytes32 wrong = dek ^ bytes32(uint256(1));

        // The genuine KMS signature recovers to an unrelated address over the wrong cleartext.
        address recovered = _recoveredSigner(proof, handle, wrong);
        assertNotEq(recovered, mockKmsSigner);
        _expectInvalidSigner(recovered);
        vm.prank(eve);
        dms.revealKey(alice, ID, wrong, proof);

        // Nor does the "unrevealed" sentinel value.
        _expectInvalidSigner(_recoveredSigner(proof, handle, bytes32(0)));
        vm.prank(eve);
        dms.revealKey(alice, ID, bytes32(0), proof);

        _assertStillDarkMarked(alice, ID, BOUNTY);

        // The switch is still revealable with the right key.
        uint256 eveBefore = eve.balance;
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, proof);
        assertEq(eve.balance - eveBefore, BOUNTY, "paid");
        _assertState(alice, ID, DeadManSwitch.State.REVEALED);
    }

    function test_RevealKey_RevertsWithNonKmsSigner() public {
        _create();
        _darkAndMark(alice, ID);
        bytes32 handle = _handle(alice, ID);
        bytes32 dek = _dek(alice, ID);

        // Right handle, right cleartext, right domain and wire format — wrong signer.
        bytes memory forged = _signProof(ROGUE_KMS_PK, handle, dek);
        _expectInvalidSigner(vm.addr(ROGUE_KMS_PK));
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, forged);

        _assertStillDarkMarked(alice, ID, BOUNTY);
    }

    function test_RevealKey_RevertsWithEmptyProof() public {
        _create();
        _darkAndMark(alice, ID);

        vm.expectRevert(IKMSVerifier.EmptyDecryptionProof.selector);
        vm.prank(eve);
        dms.revealKey(alice, ID, _dek(alice, ID), "");

        _assertStillDarkMarked(alice, ID, BOUNTY);
    }

    function test_RevealKey_RevertsWithMalformedProof() public {
        _create();
        _darkAndMark(alice, ID);
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);
        assertEq(proof.length, 67, "1 count + 65 sig + 1 extraData");

        // Zero signatures.
        vm.expectRevert(IKMSVerifier.KMSZeroSignature.selector);
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, hex"00");

        // Truncated signature.
        bytes memory truncated = new bytes(65);
        for (uint256 i; i < 65; i++) {
            truncated[i] = proof[i];
        }
        vm.expectRevert(IKMSVerifier.DeserializingDecryptionProofFail.selector);
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, truncated);

        // Tampered extraData.
        bytes memory tampered = bytes.concat(proof);
        tampered[66] = 0x02;
        vm.expectRevert(abi.encodeWithSelector(IKMSVerifier.UnsupportedExtraDataVersion.selector, uint8(2)));
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, tampered);

        _assertStillDarkMarked(alice, ID, BOUNTY);
    }

    function test_RevealKey_RevertsWithProofForAnotherSwitch() public {
        _create(alice, ID);
        _create(bob, ID);
        _darkAndMark(alice, ID);
        dms.markDark(bob, ID); // same deadline
        bytes32 bobHandle = _handle(bob, ID);
        assertNotEq(_handle(alice, ID), bobHandle, "distinct handles");

        (bytes32 aliceDek, bytes memory aliceProof) = _kmsDecrypt(alice, ID);

        // Alice's genuine (key, proof) pair does not open bob's switch...
        _expectInvalidSigner(_recoveredSigner(aliceProof, bobHandle, aliceDek));
        vm.prank(eve);
        dms.revealKey(bob, ID, aliceDek, aliceProof);

        // ...nor does alice's proof paired with bob's real key.
        bytes32 bobDek = _dek(bob, ID);
        _expectInvalidSigner(_recoveredSigner(aliceProof, bobHandle, bobDek));
        vm.prank(eve);
        dms.revealKey(bob, ID, bobDek, aliceProof);

        _assertStillDarkMarked(alice, ID, BOUNTY);
        _assertStillDarkMarked(bob, ID, BOUNTY);
    }

    function test_RevealKey_RevertsAlreadyRevealed() public {
        _create();
        _darkAndMark(alice, ID);
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, proof);
        uint64 revealedAt = uint64(_now());

        vm.warp(_now() + 1 hours);
        uint256 carolBefore = carol.balance;
        vm.expectRevert(DeadManSwitch.AlreadyRevealed.selector);
        vm.prank(carol);
        dms.revealKey(alice, ID, dek, proof);

        assertEq(carol.balance, carolBefore, "no second payout");
        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(alice, ID);
        assertEq(uint8(info.state), uint8(DeadManSwitch.State.REVEALED), "state");
        assertEq(info.revealedAt, revealedAt, "revealedAt keeps the first reveal");
        assertEq(info.revealedKey, dek, "revealedKey");
    }

    function test_RevealKey_RevertsNotActiveWhenCancelled() public {
        _create();
        _fund(bob, alice, ID, 1 ether);
        vm.prank(alice);
        dms.cancel(ID);
        _warpToDark(alice, ID);

        bytes32 dek = _dek(alice, ID);
        bytes memory proof = buildDecryptionProof(_handle(alice, ID), abi.encode(dek));
        uint256 eveBefore = eve.balance;
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, proof);

        assertEq(eve.balance, eveBefore, "unpaid");
        _assertState(alice, ID, DeadManSwitch.State.CANCELLED);
        assertEq(dms.getRevealedKey(alice, ID), bytes32(0), "revealedKey");
        assertEq(dms.getFunderStake(alice, ID, bob), 1 ether, "funder stake still reclaimable");
        assertFalse(_isPubliclyDecryptable(_handle(alice, ID)), "decryptable");
    }

    function test_RevealKey_NonReceiverRevertsTransferFailedAndOthersCanStillReveal() public {
        bytes32 key = _create();
        _fund(carol, alice, ID, 1 ether);
        uint256 pot = BOUNTY + 1 ether;
        _darkAndMark(alice, ID);
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);

        NonReceiver nr = new NonReceiver();
        vm.expectRevert(DeadManSwitch.TransferFailed.selector);
        nr.call(address(dms), abi.encodeCall(DeadManSwitch.revealKey, (alice, ID, dek, proof)));

        // The whole transaction rolled back: the key is not recorded, the pot is intact.
        _assertStillDarkMarked(alice, ID, pot);
        assertEq(address(dms).balance, pot, "pot still held");
        assertEq(address(nr).balance, 0, "nothing paid");

        uint256 bobBefore = bob.balance;
        vm.expectEmit(address(dms));
        emit DeadManSwitch.KeyRevealed(key, bob, dek, pot, uint64(_now()));
        vm.prank(bob);
        dms.revealKey(alice, ID, dek, proof);
        assertEq(bob.balance - bobBefore, pot, "next revealer paid");
        _assertState(alice, ID, DeadManSwitch.State.REVEALED);
    }

    function test_RevealKey_ReentrancyIsBlocked() public {
        ReentrantRevealer attacker = new ReentrantRevealer(dms);

        // The attacker's own long-lived switch: a reentrant cancel would refund it.
        (externalEuint256 h, bytes memory inputProof) =
            encryptUint256(_dekFor(address(attacker), ID), address(attacker), address(dms));
        attacker.createOwn{value: BOUNTY}(
            _params(ID, 30 days, _commitment(SALT, PLAINTEXT)), _ciphertext(PLAINTEXT.length), h, inputProof
        );

        // A cancelled switch the attacker funded: a reentrant reclaim would refund it.
        _create(bob, ID);
        attacker.fund{value: 0.3 ether}(bob, ID);
        vm.prank(bob);
        dms.cancel(ID);

        // The target.
        _create(alice, ID);
        _fund(carol, alice, ID, 1 ether);
        uint256 pot = BOUNTY + 1 ether;
        _darkAndMark(alice, ID);
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);
        _assertState(address(attacker), ID, DeadManSwitch.State.ALIVE);

        uint256 attackerBefore = address(attacker).balance;
        attacker.attack(alice, ID, dek, proof, SALT, PLAINTEXT);

        // Paid exactly once, exactly the pot.
        assertEq(attacker.receiveCount(), 1, "one payout callback");
        assertEq(address(attacker).balance - attackerBefore, pot, "paid the pot once");

        // Checks-effects-interactions: the switch was already final when ETH left.
        assertEq(uint8(attacker.stateSeen()), uint8(DeadManSwitch.State.REVEALED), "state seen in callback");
        assertEq(attacker.bountySeen(), 0, "bounty seen in callback");
        assertEq(attacker.revealedKeySeen(), dek, "key seen in callback");

        // Every nonReentrant entry point hit the transient lock.
        bytes memory reentrancy = abi.encodeWithSelector(DeadManSwitch.Reentrancy.selector);
        assertFalse(attacker.revealOk(), "reentrant revealKey");
        assertEq(attacker.revealErr(), reentrancy, "revealKey error");
        assertFalse(attacker.cancelOk(), "reentrant cancel");
        assertEq(attacker.cancelErr(), reentrancy, "cancel error");
        assertFalse(attacker.reclaimOk(), "reentrant reclaimContribution");
        assertEq(attacker.reclaimErr(), reentrancy, "reclaimContribution error");
        // publishPlaintext is not lock-guarded and moves no value; the switch is already
        // REVEALED, so a commitment-matching publish from the callback is legitimate.
        assertTrue(attacker.publishOk(), "publishPlaintext from callback");
        assertTrue(dms.getSwitchInfo(alice, ID).published, "published");

        _assertState(alice, ID, DeadManSwitch.State.REVEALED);
        assertEq(dms.getRevealedKey(alice, ID), dek, "revealedKey");
        assertEq(dms.getBounty(alice, ID), 0, "target bounty");
        _assertState(address(attacker), ID, DeadManSwitch.State.ALIVE);
        assertEq(dms.getOwnerStake(address(attacker), ID), BOUNTY, "attacker owner stake intact");
        assertEq(dms.getFunderStake(bob, ID, address(attacker)), 0.3 ether, "attacker funder stake intact");
        assertEq(address(dms).balance, BOUNTY + 0.3 ether, "only the target's pot left the contract");

        // The lock was released at the end of the reveal: the same calls now succeed.
        attacker.cancelOwn();
        attacker.reclaimFunded();
        assertEq(address(attacker).balance - attackerBefore, pot + BOUNTY + 0.3 ether, "later refunds");
        _assertState(address(attacker), ID, DeadManSwitch.State.CANCELLED);
        assertEq(address(dms).balance, 0, "contract drained correctly");
    }

    function test_RevealKey_StakeViewsReadZeroAfterReveal() public {
        _create();
        _fund(bob, alice, ID, 1 ether);
        _fund(carol, alice, ID, 2 ether);
        assertEq(dms.getOwnerStake(alice, ID), BOUNTY);
        assertEq(dms.getFunderStake(alice, ID, bob), 1 ether);

        _reveal(alice, ID, eve);

        assertEq(dms.getBounty(alice, ID), 0, "bounty");
        assertEq(dms.getOwnerStake(alice, ID), 0, "ownerStake");
        assertEq(dms.getSwitchInfo(alice, ID).ownerStake, 0, "info.ownerStake");
        assertEq(dms.getFunderStake(alice, ID, bob), 0, "bob");
        assertEq(dms.getFunderStake(alice, ID, carol), 0, "carol");
    }

    function test_RevealKey_DepositorsCannotReclaimAfterReveal() public {
        _create();
        _fund(bob, alice, ID, 1 ether);
        _reveal(alice, ID, eve);
        assertEq(address(dms).balance, 0, "pot paid out");

        vm.warp(dms.expirationTime(alice, ID) + dms.RESCUE_DELAY() + 1);
        assertFalse(dms.getSwitchInfo(alice, ID).rescuable, "rescuable");

        vm.expectRevert(DeadManSwitch.AlreadyRevealed.selector);
        vm.prank(bob);
        dms.reclaimContribution(alice, ID);

        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        vm.prank(alice);
        dms.reclaimOwnerStake(ID);

        vm.expectRevert(DeadManSwitch.NotActive.selector);
        vm.prank(alice);
        dms.cancel(ID);

        _assertState(alice, ID, DeadManSwitch.State.REVEALED);
    }

    // ===================================================================== //
    //                            publishPlaintext                           //
    // ===================================================================== //

    function test_PublishPlaintext_AnyoneCanPublish() public {
        bytes32 key = _create();
        _reveal(alice, ID, bob);
        uint256 dmsBefore = address(dms).balance;
        uint256 eveBefore = eve.balance;

        vm.expectEmit(address(dms));
        emit DeadManSwitch.PlaintextPublished(key, eve, PLAINTEXT);
        vm.prank(eve); // neither owner nor revealer
        dms.publishPlaintext(alice, ID, SALT, PLAINTEXT);

        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(alice, ID);
        assertTrue(info.published, "published");
        assertEq(uint8(info.state), uint8(DeadManSwitch.State.REVEALED), "state");
        assertEq(info.revealedKey, _dek(alice, ID), "revealedKey");
        assertEq(address(dms).balance, dmsBefore, "no ETH moved");
        assertEq(eve.balance, eveBefore, "publisher unpaid");
    }

    function test_PublishPlaintext_RevertsNotRevealedUnlessRevealed() public {
        _create(alice, ID);
        _create(alice, ID + 1);
        vm.prank(alice);
        dms.cancel(ID + 1);

        vm.expectRevert(DeadManSwitch.NotRevealed.selector);
        dms.publishPlaintext(alice, ID, SALT, PLAINTEXT); // ALIVE

        _warpToDark(alice, ID);
        vm.expectRevert(DeadManSwitch.NotRevealed.selector);
        dms.publishPlaintext(alice, ID, SALT, PLAINTEXT); // DARK

        dms.markDark(alice, ID);
        vm.expectRevert(DeadManSwitch.NotRevealed.selector);
        dms.publishPlaintext(alice, ID, SALT, PLAINTEXT); // DARK_MARKED

        vm.expectRevert(DeadManSwitch.NotRevealed.selector);
        vm.prank(alice);
        dms.publishPlaintext(alice, ID + 1, SALT, PLAINTEXT); // CANCELLED, even by the owner

        assertFalse(dms.getSwitchInfo(alice, ID).published, "published");
        assertFalse(dms.getSwitchInfo(alice, ID + 1).published, "published (cancelled)");
    }

    function test_PublishPlaintext_RevertsDoesNotExist() public {
        _create();
        _reveal(alice, ID, eve);

        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        dms.publishPlaintext(alice, ID + 1, SALT, PLAINTEXT);
        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        dms.publishPlaintext(bob, ID, SALT, PLAINTEXT);
    }

    function test_PublishPlaintext_RevertsCommitmentMismatch() public {
        _create();
        _reveal(alice, ID, eve);

        vm.expectRevert(DeadManSwitch.CommitmentMismatch.selector);
        dms.publishPlaintext(alice, ID, bytes32(uint256(SALT) + 1), PLAINTEXT); // wrong salt

        vm.expectRevert(DeadManSwitch.CommitmentMismatch.selector);
        dms.publishPlaintext(alice, ID, SALT, bytes("the secret payloaD")); // wrong payload

        vm.expectRevert(DeadManSwitch.CommitmentMismatch.selector);
        dms.publishPlaintext(alice, ID, SALT, bytes.concat(PLAINTEXT, hex"00")); // trailing byte

        vm.expectRevert(DeadManSwitch.CommitmentMismatch.selector);
        dms.publishPlaintext(alice, ID, SALT, ""); // empty

        bytes32 dek = dms.getRevealedKey(alice, ID);
        vm.expectRevert(DeadManSwitch.CommitmentMismatch.selector);
        dms.publishPlaintext(alice, ID, dek, PLAINTEXT); // the DEK is not the salt

        assertFalse(dms.getSwitchInfo(alice, ID).published, "failed attempts do not publish");
        dms.publishPlaintext(alice, ID, SALT, PLAINTEXT);
        assertTrue(dms.getSwitchInfo(alice, ID).published, "correct preimage publishes");
    }

    function test_PublishPlaintext_RevertsPayloadTooLarge() public {
        bytes memory payload = _bytes(dms.MAX_PAYLOAD_SIZE() + 1);
        _createWithPayload(payload);
        _reveal(alice, ID, eve);
        assertEq(dms.getSwitchInfo(alice, ID).plaintextCommitment, _commitment(SALT, payload), "commitment matches");

        vm.expectRevert(DeadManSwitch.PayloadTooLarge.selector);
        dms.publishPlaintext(alice, ID, SALT, payload);

        assertFalse(dms.getSwitchInfo(alice, ID).published, "published");
    }

    function test_PublishPlaintext_AcceptsMaxSizePayload() public {
        bytes memory payload = _bytes(dms.MAX_PAYLOAD_SIZE());
        bytes32 key = _createWithPayload(payload);
        _reveal(alice, ID, eve);

        vm.expectEmit(address(dms));
        emit DeadManSwitch.PlaintextPublished(key, carol, payload);
        vm.prank(carol);
        dms.publishPlaintext(alice, ID, SALT, payload);

        assertTrue(dms.getSwitchInfo(alice, ID).published, "published");
    }

    function test_PublishPlaintext_AcceptsEmptyPayloadWhenCommitted() public {
        bytes32 key = _createWithPayload("");
        assertEq(dms.getSwitchInfo(alice, ID).ciphertextLength, dms.CIPHERTEXT_OVERHEAD(), "minimal ciphertext");
        _reveal(alice, ID, eve);

        vm.expectEmit(address(dms));
        emit DeadManSwitch.PlaintextPublished(key, carol, "");
        vm.prank(carol);
        dms.publishPlaintext(alice, ID, SALT, "");

        assertTrue(dms.getSwitchInfo(alice, ID).published, "published");
    }

    function test_PublishPlaintext_RevertsAlreadyPublished() public {
        _create();
        _reveal(alice, ID, eve);
        vm.prank(carol);
        dms.publishPlaintext(alice, ID, SALT, PLAINTEXT);

        vm.expectRevert(DeadManSwitch.AlreadyPublished.selector);
        vm.prank(eve);
        dms.publishPlaintext(alice, ID, SALT, PLAINTEXT);

        assertTrue(dms.getSwitchInfo(alice, ID).published, "published");
    }

    // ===================================================================== //
    //                               isolation                               //
    // ===================================================================== //

    function test_Release_MarkAndRevealTouchOnlyTheirOwnSwitch() public {
        _create(alice, ID);
        _create(bob, ID, 2 * INTERVAL, BOUNTY, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));
        bytes32 aliceHandle = _handle(alice, ID);
        bytes32 bobHandle = _handle(bob, ID);
        assertNotEq(aliceHandle, bobHandle, "distinct handles");

        _darkAndMark(alice, ID);
        assertTrue(_isPubliclyDecryptable(aliceHandle), "alice decryptable");
        assertFalse(_isPubliclyDecryptable(bobHandle), "bob sealed after alice's mark");

        _reveal(alice, ID, eve);
        assertFalse(_isPubliclyDecryptable(bobHandle), "bob sealed after alice's reveal");
        assertEq(address(dms).balance, BOUNTY, "only alice's pot paid out");

        DeadManSwitch.SwitchInfo memory b = dms.getSwitchInfo(bob, ID);
        assertEq(uint8(b.state), uint8(DeadManSwitch.State.ALIVE), "bob state");
        assertEq(b.bounty, BOUNTY, "bob bounty");
        assertEq(b.ownerStake, BOUNTY, "bob stake");
        assertEq(b.darkMarkedAt, 0, "bob darkMarkedAt");
        assertEq(b.revealedKey, bytes32(0), "bob revealedKey");
        assertEq(b.encKeyHandle, bobHandle, "bob handle");

        // Bob going dark does not by itself expose his key; only his own mark does.
        _warpToDark(bob, ID);
        _assertState(bob, ID, DeadManSwitch.State.DARK);
        assertFalse(_isPubliclyDecryptable(bobHandle), "bob sealed while unmarked");
        dms.markDark(bob, ID);
        assertTrue(_isPubliclyDecryptable(bobHandle), "bob decryptable after his mark");
        (bytes32 bobDek,) = _kmsDecrypt(bob, ID);
        assertEq(bobDek, _dek(bob, ID), "bob's DEK");
        assertNotEq(bobDek, dms.getRevealedKey(alice, ID), "distinct DEKs");

        _assertState(alice, ID, DeadManSwitch.State.REVEALED);
        assertEq(dms.getRevealedKey(alice, ID), _dek(alice, ID), "alice revealedKey untouched");
    }
}
