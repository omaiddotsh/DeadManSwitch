// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DMSTestBase} from "./utils/DMSTestBase.sol";
import {DeadManSwitch} from "../src/DeadManSwitch.sol";
import {externalEuint256} from "encrypted-types/EncryptedTypes.sol";
import {KMSDecryptionProofHelper} from "forge-fhevm/KMSDecryptionProofHelper.sol";

/// @notice Chainlink-shaped feed whose `latestRoundData()` answers with SIX words (192 bytes)
///         instead of five. `decimals()` is a normal function so the constructor accepts it.
contract ExtraReturnFeed {
    uint8 public constant decimals = 8;

    fallback() external {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, 1) // roundId
            mstore(add(p, 0x20), 200000000000) // answer: $2,000 with 8 dp
            mstore(add(p, 0x40), timestamp()) // startedAt
            mstore(add(p, 0x60), timestamp()) // updatedAt
            mstore(add(p, 0x80), 1) // answeredInRound
            mstore(add(p, 0xa0), 0xdeadbeef) // trailing junk word
            return(p, 0xc0)
        }
    }
}

/**
 * @notice Hardening probes from the 2026-10 review: properties the trust model relies on that
 *         the unit suites did not pin directly (a KMS proof before markDark, a proof signed under
 *         another chain's domain, a feed with trailing return data, the floor at its cap, the
 *         rescue clock, ETH conservation on a mixed self-fund path) and the one design limit it
 *         recorded (no top-ups once dark).
 */
contract HardeningTest is DMSTestBase {
    error KMSInvalidSigner(address invalidSigner);

    // ------------------------------------------------------------------ helpers

    /// @dev EIP-712 digest for (handle, abi.encode(dek), EMPTY_EXTRA_DATA) under an arbitrary
    ///      domain chain id, so a proof can be signed under the wrong domain on purpose.
    function _digestUnderChain(bytes32 handle, bytes32 dek, uint256 domainChainId) internal view returns (bytes32) {
        (, string memory name, string memory version,, address verifying,,) = _kmsVerifier.eip712Domain();
        bytes32 ds =
            KMSDecryptionProofHelper.computeKMSDecryptionDomainSeparator(name, version, domainChainId, verifying);
        bytes32[] memory hs = new bytes32[](1);
        hs[0] = handle;
        return KMSDecryptionProofHelper.computeDecryptionDigest(hs, abi.encode(dek), EMPTY_EXTRA_DATA, ds);
    }

    function _signWith(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(r, s, v);
        return KMSDecryptionProofHelper.assembleDecryptionProof(sigs, EMPTY_EXTRA_DATA);
    }

    function _realDomainChainId() internal view returns (uint256 cid) {
        (,,, cid,,,) = _kmsVerifier.eip712Domain();
    }

    function _fund(address funder, address owner, uint256 id, uint256 amt) internal {
        vm.prank(funder);
        dms.fundBounty{value: amt}(owner, id);
    }

    // ------------------------------------------------------------------ probes

    /// Design limit (documented in ARCHITECTURE.md): once the deadline passes nobody can top up
    /// the pot. A switch whose bounty is below hunters' cost sits DARK until the rescue window.
    /// Concrete: floor-level bounty 0.005 ETH, a funder with 1 ETH is refused with `Expired`.
    function test_FundBountyRefusedOnceDark_NoWayToReviveIncentive() public {
        uint256 floor = dms.minBounty(); // 0.005 ETH at $2,000 and the $10 floor
        assertEq(floor, 0.005 ether);
        _create(alice, ID, INTERVAL, floor, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));

        _warpToDark(alice, ID);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.DARK));

        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Expired.selector);
        dms.fundBounty{value: 1 ether}(alice, ID);

        // Still refused after markDark: the pot is frozen at 0.005 ETH for the whole release.
        dms.markDark(alice, ID);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Expired.selector);
        dms.fundBounty{value: 1 ether}(alice, ID);
        assertEq(dms.getBounty(alice, ID), floor);
    }

    /// Pins: even a proof correctly signed by the KMS signer set over the right (handle, DEK)
    /// cannot land before `markDark`. A colluding KMS can leak the DEK off-chain but cannot
    /// make the contract record a reveal (and pay) early.
    function test_ValidKmsSignatureIsUselessBeforeMarkDark() public {
        _create();
        bytes32 handle = dms.getEncKeyHandle(alice, ID);
        bytes32 dek = bytes32(_dekFor(alice, ID));
        bytes memory proof = _signWith(MOCK_KMS_SIGNER_PK, _digestUnderChain(handle, dek, _realDomainChainId()));

        // ALIVE
        vm.prank(eve);
        vm.expectRevert(DeadManSwitch.NotDarkMarked.selector);
        dms.revealKey(alice, ID, dek, proof);

        // DARK but not marked
        _warpToDark(alice, ID);
        vm.prank(eve);
        vm.expectRevert(DeadManSwitch.NotDarkMarked.selector);
        dms.revealKey(alice, ID, dek, proof);
        assertFalse(_isPubliclyDecryptable(handle), "key still sealed");

        // The same hand-signed proof is genuinely valid: it lands once marked.
        dms.markDark(alice, ID);
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, proof);
        assertEq(dms.getRevealedKey(alice, ID), dek);
    }

    /// Pins: a proof signed by a real KMS signer but under another chain's EIP-712 domain
    /// (cross-chain replay) recovers to a non-signer and reverts `KMSInvalidSigner`.
    function test_ProofFromAnotherDomainChainIdIsRejected() public {
        _create();
        _darkAndMark(alice, ID);
        bytes32 handle = dms.getEncKeyHandle(alice, ID);
        bytes32 dek = bytes32(_dekFor(alice, ID));

        uint256 otherChain = _realDomainChainId() + 1;
        bytes32 wrongDigest = _digestUnderChain(handle, dek, otherChain);
        bytes memory proof = _signWith(MOCK_KMS_SIGNER_PK, wrongDigest);

        // Who the verifier will recover when it hashes under its own domain.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MOCK_KMS_SIGNER_PK, wrongDigest);
        address recovered = ecrecover(_digestUnderChain(handle, dek, _realDomainChainId()), v, r, s);
        assertTrue(recovered != mockKmsSigner, "different domain => different recovered address");

        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(KMSInvalidSigner.selector, recovered));
        dms.revealKey(alice, ID, dek, proof);
        assertEq(dms.getBounty(alice, ID), BOUNTY, "pot intact");
    }

    /// Pins: `oraclePrice` tolerates a feed that returns MORE than 160 bytes (abi.decode
    /// ignores trailing data), so such a feed neither bricks nor disables the floor.
    function test_OracleAcceptsFeedWithExtraReturnData() public {
        ExtraReturnFeed f = new ExtraReturnFeed();
        DeadManSwitch d = new DeadManSwitch(address(f), MIN_USD, MAX_PRICE_AGE);
        (bool ok, uint256 price) = d.oraclePrice();
        assertTrue(ok, "usable");
        assertEq(price, 2000e8);
        assertEq(d.minBounty(), 0.005 ether);
    }

    /// Accepted design, with exact numbers: the rescue clock runs from
    /// the deadline, so a `markDark` sent 1 s before the window opens buys the hunter nothing.
    function test_MarkDarkOneSecondBeforeRescueWindowPaysNothing() public {
        _create();
        _fund(bob, alice, ID, 1 ether);
        uint256 deadline = dms.expirationTime(alice, ID);

        vm.warp(deadline + dms.RESCUE_DELAY() - 1);
        vm.prank(eve);
        dms.markDark(alice, ID); // eve pays ~80k gas here
        assertFalse(dms.getSwitchInfo(alice, ID).rescuable);

        vm.warp(deadline + dms.RESCUE_DELAY());
        assertTrue(dms.getSwitchInfo(alice, ID).rescuable);
        vm.prank(alice);
        dms.reclaimOwnerStake(ID);
        vm.prank(bob);
        dms.reclaimContribution(alice, ID);
        assertEq(dms.getBounty(alice, ID), 0);

        // eve's reveal still lands and records the key, but pays 0.
        (bytes32 dek, bytes memory proof) = _kmsDecrypt(alice, ID);
        uint256 before = eve.balance;
        vm.prank(eve);
        dms.revealKey(alice, ID, dek, proof);
        assertEq(eve.balance, before, "paid nothing");
        assertEq(dms.getRevealedKey(alice, ID), dek);
    }

    /// Pins: the admin's strongest lever. At the $10,000 cap and $2,000/ETH the floor is 5 ETH;
    /// a feed glitch reporting the price with 0 decimals pushes it to 5e8 ETH until the admin
    /// (if any) zeroes the floor. Neither moves escrowed funds.
    function test_FloorAtCapAndMisreportedPriceMagnitudes() public {
        dms.setMinBountyUsd(dms.MAX_MIN_BOUNTY_USD());
        assertEq(dms.minBounty(), 5 ether);

        feed.setPrice(2000); // "$2,000" reported without its 8 decimals
        assertEq(dms.minBounty(), 500_000_000 ether);

        (externalEuint256 h, bytes memory proof) = _encKey(bob, _dekFor(bob, ID));
        bytes memory ct = _ciphertext(PLAINTEXT.length);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.BountyTooLow.selector);
        dms.createSwitch{value: 99 ether}(_params(ID, INTERVAL, _commitment(SALT, PLAINTEXT)), ct, h, proof);

        dms.setMinBountyUsd(0);
        _create(bob, ID, INTERVAL, 0, _commitment(SALT, PLAINTEXT), ct);
        assertEq(dms.getBounty(bob, ID), 0);
    }

    /// Pins ETH conservation on a mixed path the unit tests do not combine: owner self-funds,
    /// a funder tops up, owner cancels (own stake only), both reclaim, and a late reveal is
    /// impossible (CANCELLED), so the contract ends at exactly 0.
    function test_SelfFundThenCancelConservesEveryWei() public {
        _create(); // alice stakes 0.05
        vm.prank(alice);
        dms.fundBounty{value: 0.2 ether}(alice, ID); // alice also "funds" 0.2
        _fund(bob, alice, ID, 0.3 ether);
        assertEq(address(dms).balance, 0.55 ether);

        uint256 a0 = alice.balance;
        vm.prank(alice);
        dms.cancel(ID);
        assertEq(alice.balance - a0, 0.05 ether, "cancel refunds the stake only");
        assertEq(dms.getFunderStake(alice, ID, alice), 0.2 ether);

        vm.prank(alice);
        dms.reclaimContribution(alice, ID);
        vm.prank(bob);
        dms.reclaimContribution(alice, ID);
        assertEq(address(dms).balance, 0);
        assertEq(dms.getBounty(alice, ID), 0);

        _warpToDark(alice, ID);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.markDark(alice, ID);
    }
}
