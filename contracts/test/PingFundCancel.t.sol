// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DMSTestBase, NonReceiver} from "./utils/DMSTestBase.sol";
import {DeadManSwitch} from "../src/DeadManSwitch.sol";

/// @notice ping, fundBounty, cancel, and reclaimContribution after a cancel.
contract PingFundCancelTest is DMSTestBase {
    // ---------- local helpers ---------- //

    /// @dev Under via_ir the optimizer may treat `block.timestamp` as constant for the
    ///      whole test function and ignore `vm.warp`; always read the live value.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _fund(address funder, address owner, uint256 id, uint256 amount) internal {
        vm.prank(funder);
        dms.fundBounty{value: amount}(owner, id);
    }

    function _cancel(address owner, uint256 id) internal {
        vm.prank(owner);
        dms.cancel(id);
    }

    function _assertState(address owner, uint256 id, DeadManSwitch.State expected) internal view {
        assertEq(uint8(dms.getState(owner, id)), uint8(expected), "state");
    }

    // ===================================================================== //
    //                                  ping                                 //
    // ===================================================================== //

    function test_Ping_UpdatesLastPingAndExpiresAtAndEmits() public {
        bytes32 key = _create();
        uint256 createdAt = _now();
        vm.warp(createdAt + 10 hours);
        uint64 nowTs = uint64(_now());

        vm.expectEmit(address(dms));
        emit DeadManSwitch.Pinged(key, nowTs, nowTs + INTERVAL);
        vm.prank(alice);
        dms.ping(ID);

        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(alice, ID);
        assertEq(info.lastPing, nowTs, "lastPing");
        assertEq(info.expiresAt, nowTs + INTERVAL, "expiresAt");
        assertEq(dms.expirationTime(alice, ID), nowTs + INTERVAL, "expirationTime");
        assertEq(info.createdAt, createdAt, "createdAt untouched");
        assertEq(info.pingInterval, INTERVAL, "interval untouched");
        assertEq(info.bounty, BOUNTY, "bounty untouched");
        assertEq(info.ownerStake, BOUNTY, "ownerStake untouched");
        _assertState(alice, ID, DeadManSwitch.State.ALIVE);
    }

    function test_Ping_OneSecondBeforeDeadlineExtends() public {
        bytes32 key = _create();
        uint64 oldDeadline = dms.expirationTime(alice, ID);
        vm.warp(oldDeadline - 1);

        vm.expectEmit(address(dms));
        emit DeadManSwitch.Pinged(key, oldDeadline - 1, oldDeadline - 1 + INTERVAL);
        vm.prank(alice);
        dms.ping(ID);
        assertEq(dms.expirationTime(alice, ID), oldDeadline - 1 + INTERVAL);

        // The old deadline no longer counts: still alive, cannot be marked dark.
        vm.warp(oldDeadline);
        _assertState(alice, ID, DeadManSwitch.State.ALIVE);
        assertFalse(dms.isDark(alice, ID));
        vm.expectRevert(DeadManSwitch.NotDark.selector);
        dms.markDark(alice, ID);

        // The new deadline does.
        vm.warp(oldDeadline - 1 + INTERVAL);
        _assertState(alice, ID, DeadManSwitch.State.DARK);
    }

    function test_Ping_AtDeadlineRevertsExpired() public {
        _create();
        uint64 lastPing = dms.getSwitchInfo(alice, ID).lastPing;
        _warpToDark(alice, ID);

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.Expired.selector);
        dms.ping(ID);

        assertEq(dms.getSwitchInfo(alice, ID).lastPing, lastPing, "lastPing unchanged");
        _assertState(alice, ID, DeadManSwitch.State.DARK);
    }

    function test_Ping_RevertsExpiredOnceDarkMarkedAndAfterRescueDelay() public {
        _create();
        _darkAndMark(alice, ID);

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.Expired.selector);
        dms.ping(ID);

        vm.warp(_now() + dms.RESCUE_DELAY());
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.Expired.selector);
        dms.ping(ID);
        _assertState(alice, ID, DeadManSwitch.State.DARK_MARKED);
    }

    function test_Ping_NonOwnerGetsDoesNotExist() public {
        _create();
        uint64 lastPing = dms.getSwitchInfo(alice, ID).lastPing;
        vm.warp(_now() + 1 hours);

        // ping derives the key from msg.sender: bob has no switch under ID.
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        dms.ping(ID);

        assertEq(dms.getSwitchInfo(alice, ID).lastPing, lastPing, "alice's switch untouched");
    }

    function test_Ping_KeyedByCallerOnly() public {
        _create(alice, ID);
        bytes32 bobKey = _create(bob, ID);
        uint64 aliceLastPing = dms.getSwitchInfo(alice, ID).lastPing;
        vm.warp(_now() + 1 hours);
        uint64 nowTs = uint64(_now());

        vm.expectEmit(address(dms));
        emit DeadManSwitch.Pinged(bobKey, nowTs, nowTs + INTERVAL);
        vm.prank(bob);
        dms.ping(ID);

        assertEq(dms.getSwitchInfo(bob, ID).lastPing, nowTs, "bob pinged");
        assertEq(dms.getSwitchInfo(alice, ID).lastPing, aliceLastPing, "same id, other owner untouched");
    }

    function test_Ping_AfterCancelRevertsNotActive() public {
        _create();
        _cancel(alice, ID);

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.ping(ID);

        // Status is checked before the deadline: still NotActive once past it.
        _warpToDark(alice, ID);
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.ping(ID);
    }

    function test_Ping_AfterRevealRevertsNotActive() public {
        _create();
        _reveal(alice, ID, bob);
        _assertState(alice, ID, DeadManSwitch.State.REVEALED);

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.ping(ID);
    }

    /// @dev For any interval, a ping strictly inside the window extends it by exactly
    ///      one interval from now; a ping at the extended deadline is too late.
    function testFuzz_Ping_ExtendsWithinIntervalRevertsAtDeadline(uint64 interval, uint256 elapsed) public {
        interval = uint64(bound(interval, dms.MIN_PING_INTERVAL(), dms.MAX_PING_INTERVAL()));
        elapsed = bound(elapsed, 0, interval - 1);
        _create(alice, ID, interval, BOUNTY, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));

        vm.warp(_now() + elapsed);
        uint64 nowTs = uint64(_now());
        vm.prank(alice);
        dms.ping(ID);
        assertEq(dms.expirationTime(alice, ID), nowTs + interval);

        vm.warp(uint256(nowTs) + interval);
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.Expired.selector);
        dms.ping(ID);
    }

    /// @dev `lastPing` and `pingInterval` are packed narrower than the uint64 views and events:
    ///      past the uint32 timestamp range and at the maximum interval nothing is truncated.
    function test_Ping_PackedTimestampsBeyondUint32RoundTrip() public {
        uint64 maxI = uint64(dms.MAX_PING_INTERVAL());
        uint64 t0 = uint64(type(uint32).max) + 1_000; // year 2106+
        vm.warp(t0);
        bytes32 key = _create(alice, ID, maxI, BOUNTY, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));
        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(alice, ID);
        assertEq(info.lastPing, t0, "lastPing");
        assertEq(info.pingInterval, maxI, "pingInterval");
        assertEq(info.expiresAt, t0 + maxI, "expiresAt");

        uint64 t1 = t0 + maxI - 1;
        vm.warp(t1);
        vm.expectEmit(address(dms));
        emit DeadManSwitch.Pinged(key, t1, t1 + maxI);
        vm.prank(alice);
        dms.ping(ID);
        assertEq(dms.expirationTime(alice, ID), t1 + maxI, "expirationTime");

        vm.warp(t1 + maxI - 1);
        _assertState(alice, ID, DeadManSwitch.State.ALIVE);
        vm.warp(t1 + maxI);
        _assertState(alice, ID, DeadManSwitch.State.DARK);
    }

    // ===================================================================== //
    //                               fundBounty                              //
    // ===================================================================== //

    function test_FundBounty_RevertsZeroValue() public {
        _create();
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.ZeroValue.selector);
        dms.fundBounty{value: 0}(alice, ID);
        assertEq(dms.getBounty(alice, ID), BOUNTY);
    }

    function test_FundBounty_RevertsDoesNotExist() public {
        _create();
        uint256 bobBefore = bob.balance;

        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        dms.fundBounty{value: 1 ether}(carol, ID); // right id, wrong owner

        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        dms.fundBounty{value: 1 ether}(alice, ID + 1); // right owner, wrong id

        assertEq(bob.balance, bobBefore);
        assertEq(address(dms).balance, BOUNTY);
    }

    function test_FundBounty_RevertsExpiredFromDeadline() public {
        _create();
        uint64 deadline = dms.expirationTime(alice, ID);

        vm.warp(deadline - 1);
        _fund(bob, alice, ID, 1 ether); // last second still accepted

        vm.warp(deadline);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Expired.selector);
        dms.fundBounty{value: 1 ether}(alice, ID);

        dms.markDark(alice, ID);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Expired.selector);
        dms.fundBounty{value: 1 ether}(alice, ID);

        assertEq(dms.getFunderStake(alice, ID, bob), 1 ether);
        assertEq(dms.getBounty(alice, ID), BOUNTY + 1 ether);
    }

    function test_FundBounty_RevertsNotActiveAfterCancel() public {
        _create();
        _cancel(alice, ID);

        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.fundBounty{value: 1 ether}(alice, ID);
        assertEq(dms.getFunderStake(alice, ID, bob), 0);
        assertEq(dms.getBounty(alice, ID), 0);
    }

    function test_FundBounty_RevertsNotActiveAfterReveal() public {
        _create();
        _reveal(alice, ID, bob);

        vm.prank(carol);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.fundBounty{value: 1 ether}(alice, ID);
        assertEq(dms.getBounty(alice, ID), 0);
    }

    function test_FundBounty_AccumulatesPerFunderAndEmitsNewTotal() public {
        bytes32 key = _create();
        uint64 deadline = dms.expirationTime(alice, ID);
        uint256 bobBefore = bob.balance;
        uint256 carolBefore = carol.balance;

        vm.expectEmit(address(dms));
        emit DeadManSwitch.BountyFunded(key, bob, 1 ether, BOUNTY + 1 ether);
        _fund(bob, alice, ID, 1 ether);

        vm.expectEmit(address(dms));
        emit DeadManSwitch.BountyFunded(key, carol, 0.25 ether, BOUNTY + 1.25 ether);
        _fund(carol, alice, ID, 0.25 ether);

        vm.expectEmit(address(dms));
        emit DeadManSwitch.BountyFunded(key, bob, 0.5 ether, BOUNTY + 1.75 ether);
        _fund(bob, alice, ID, 0.5 ether);

        assertEq(dms.getFunderStake(alice, ID, bob), 1.5 ether, "bob stake");
        assertEq(dms.getFunderStake(alice, ID, carol), 0.25 ether, "carol stake");
        assertEq(dms.getFunderStake(alice, ID, eve), 0, "eve stake");
        assertEq(dms.getFunderStake(alice, ID, alice), 0, "owner has no funder stake");
        assertEq(dms.getOwnerStake(alice, ID), BOUNTY, "owner stake untouched");
        assertEq(dms.getBounty(alice, ID), BOUNTY + 1.75 ether, "bounty");
        assertEq(address(dms).balance, BOUNTY + 1.75 ether, "contract balance");
        assertEq(bobBefore - bob.balance, 1.5 ether, "bob paid");
        assertEq(carolBefore - carol.balance, 0.25 ether, "carol paid");
        // Funding is not a ping.
        assertEq(dms.expirationTime(alice, ID), deadline, "deadline untouched");
    }

    // ===================================================================== //
    //                                 cancel                                //
    // ===================================================================== //

    function test_Cancel_RefundsOnlyOwnerStake() public {
        bytes32 key = _create();
        _fund(bob, alice, ID, 1 ether);
        _fund(carol, alice, ID, 0.5 ether);
        vm.warp(_now() + 1 hours);
        uint256 aliceBefore = alice.balance;

        vm.expectEmit(address(dms));
        emit DeadManSwitch.SwitchCancelled(key, alice, BOUNTY, uint64(_now()));
        _cancel(alice, ID);

        assertEq(alice.balance - aliceBefore, BOUNTY, "owner refunded own stake only");
        assertEq(address(dms).balance, 1.5 ether, "funder money stays");
        assertEq(dms.getBounty(alice, ID), 1.5 ether, "bounty == sum of funder stakes");
        assertEq(dms.getOwnerStake(alice, ID), 0, "owner stake zeroed");
        assertEq(dms.getFunderStake(alice, ID, bob), 1 ether, "bob stake intact");
        assertEq(dms.getFunderStake(alice, ID, carol), 0.5 ether, "carol stake intact");
        _assertState(alice, ID, DeadManSwitch.State.CANCELLED);
        DeadManSwitch.SwitchInfo memory info = dms.getSwitchInfo(alice, ID);
        assertFalse(info.rescuable);
        assertFalse(dms.isAlive(alice, ID));
        assertFalse(dms.isDark(alice, ID));
    }

    function test_Cancel_RevertsExpiredFromDeadline() public {
        _create(alice, 1);
        _create(alice, 2); // same creation time, same deadline
        uint64 deadline = dms.expirationTime(alice, 1);
        assertEq(dms.expirationTime(alice, 2), deadline);

        vm.warp(deadline - 1);
        _cancel(alice, 2); // last second still cancellable
        _assertState(alice, 2, DeadManSwitch.State.CANCELLED);

        vm.warp(deadline);
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.Expired.selector);
        dms.cancel(1);

        dms.markDark(alice, 1);
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.Expired.selector);
        dms.cancel(1);

        assertEq(alice.balance, aliceBefore, "no refund");
        assertEq(dms.getOwnerStake(alice, 1), BOUNTY, "stake still escrowed");
        _assertState(alice, 1, DeadManSwitch.State.DARK_MARKED);
    }

    function test_Cancel_RevertsNotActiveOnSecondCancel() public {
        _create();
        _fund(bob, alice, ID, 1 ether);
        uint256 aliceBefore = alice.balance;
        _cancel(alice, ID);

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.cancel(ID);

        assertEq(alice.balance - aliceBefore, BOUNTY, "refunded exactly once");
        assertEq(address(dms).balance, 1 ether);
    }

    function test_Cancel_RevertsDoesNotExistForNonOwner() public {
        _create();
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        dms.cancel(ID);
        _assertState(alice, ID, DeadManSwitch.State.ALIVE);
        assertEq(dms.getOwnerStake(alice, ID), BOUNTY);
    }

    function test_Cancel_RevertsNotActiveAfterReveal() public {
        _create();
        _reveal(alice, ID, bob);
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.cancel(ID);
    }

    /// @dev The whole point of cancel: the DEK handle must never become publicly
    ///      decryptable, no matter how much time passes or who calls what.
    function test_Cancel_KeepsKeySealedForever() public {
        _create();
        bytes32 handle = dms.getEncKeyHandle(alice, ID);
        assertTrue(handle != bytes32(0));
        assertFalse(_isPubliclyDecryptable(handle), "sealed at creation");

        _cancel(alice, ID);
        assertFalse(_isPubliclyDecryptable(handle), "sealed after cancel");

        // Past the deadline: markDark refuses, the switch never reads as dark.
        _warpToDark(alice, ID);
        assertFalse(dms.isDark(alice, ID));
        _assertState(alice, ID, DeadManSwitch.State.CANCELLED);
        vm.prank(eve);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.markDark(alice, ID);
        assertFalse(_isPubliclyDecryptable(handle), "sealed after markDark attempt at deadline");

        // Long after the rescue delay: still refused, still sealed.
        vm.warp(_now() + dms.RESCUE_DELAY() + 365 days);
        vm.prank(eve);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.markDark(alice, ID);
        assertFalse(_isPubliclyDecryptable(handle), "sealed long after");
        assertFalse(dms.getSwitchInfo(alice, ID).rescuable);

        // Even a KMS-signed proof of the true DEK cannot put the key on-chain.
        bytes32 dek = bytes32(_dekFor(alice, ID));
        bytes memory proof = buildDecryptionProof(handle, abi.encode(dek));
        vm.prank(eve);
        vm.expectRevert(DeadManSwitch.NotActive.selector);
        dms.revealKey(alice, ID, dek, proof);
        assertEq(dms.getRevealedKey(alice, ID), bytes32(0));
        assertFalse(_isPubliclyDecryptable(handle), "sealed at the end");
    }

    function test_Cancel_DoesNotAffectOtherSwitches() public {
        _create(alice, 1);
        _create(alice, 2); // same owner, other id
        _create(bob, 1); // same id, other owner
        _fund(carol, alice, 1, 1 ether);
        _fund(carol, alice, 2, 2 ether);
        _fund(carol, bob, 1, 3 ether);
        uint256 balBefore = address(dms).balance;
        assertEq(balBefore, 3 * BOUNTY + 6 ether);

        _cancel(alice, 1);

        assertEq(balBefore - address(dms).balance, BOUNTY, "only alice#1 owner stake left the contract");
        // alice#2
        assertEq(dms.getBounty(alice, 2), BOUNTY + 2 ether);
        assertEq(dms.getOwnerStake(alice, 2), BOUNTY);
        assertEq(dms.getFunderStake(alice, 2, carol), 2 ether);
        _assertState(alice, 2, DeadManSwitch.State.ALIVE);
        // bob#1
        assertEq(dms.getBounty(bob, 1), BOUNTY + 3 ether);
        assertEq(dms.getOwnerStake(bob, 1), BOUNTY);
        assertEq(dms.getFunderStake(bob, 1, carol), 3 ether);
        _assertState(bob, 1, DeadManSwitch.State.ALIVE);

        // alice#2 still releases and pays its full pot, untouched by the cancel.
        uint256 eveBefore = eve.balance;
        bytes32 dataKey = _reveal(alice, 2, eve);
        assertEq(dataKey, bytes32(_dekFor(alice, 2)));
        assertEq(eve.balance - eveBefore, BOUNTY + 2 ether, "alice#2 pot paid in full");
        assertEq(address(dms).balance, 1 ether + BOUNTY + 3 ether, "alice#1 funder money + bob#1 pot remain");
        // and the cancelled sibling's key stays sealed.
        assertFalse(_isPubliclyDecryptable(dms.getEncKeyHandle(alice, 1)));
    }

    function test_Cancel_NonReceiverOwnerRevertsTransferFailed() public {
        NonReceiver nr = new NonReceiver();
        vm.deal(address(nr), 1 ether);
        _create(address(nr), ID); // pranked as nr, which pays BOUNTY from its own balance
        uint256 balBefore = address(dms).balance;

        vm.expectRevert(DeadManSwitch.TransferFailed.selector);
        nr.call(address(dms), abi.encodeCall(DeadManSwitch.cancel, (ID)));

        // Atomic: nothing moved, the switch is still live.
        _assertState(address(nr), ID, DeadManSwitch.State.ALIVE);
        assertEq(dms.getOwnerStake(address(nr), ID), BOUNTY);
        assertEq(dms.getBounty(address(nr), ID), BOUNTY);
        assertEq(address(dms).balance, balBefore);
        assertEq(address(nr).balance, 1 ether - BOUNTY);
    }

    /// @dev Zero refunds skip the transfer, so a non-receiving owner with no stake can cancel.
    function test_Cancel_ZeroStakeSkipsTransfer() public {
        dms.setMinBountyUsd(0); // this test contract deployed dms, so it is admin
        NonReceiver nr = new NonReceiver();
        bytes32 key = _create(address(nr), ID, INTERVAL, 0, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));

        vm.expectEmit(address(dms));
        emit DeadManSwitch.SwitchCancelled(key, address(nr), 0, uint64(_now()));
        nr.call(address(dms), abi.encodeCall(DeadManSwitch.cancel, (ID)));

        _assertState(address(nr), ID, DeadManSwitch.State.CANCELLED);
        assertFalse(_isPubliclyDecryptable(dms.getEncKeyHandle(address(nr), ID)));
    }

    // ===================================================================== //
    //                     reclaimContribution after cancel                  //
    // ===================================================================== //

    function test_ReclaimContribution_AfterCancelRefundsExactAmount() public {
        bytes32 key = _create();
        _fund(bob, alice, ID, 1 ether);
        _fund(bob, alice, ID, 0.5 ether);
        _fund(carol, alice, ID, 0.25 ether);
        _cancel(alice, ID);
        uint256 bobBefore = bob.balance;

        vm.expectEmit(address(dms));
        emit DeadManSwitch.ContributionReclaimed(key, bob, 1.5 ether);
        vm.prank(bob);
        dms.reclaimContribution(alice, ID);

        assertEq(bob.balance - bobBefore, 1.5 ether, "bob refunded his total");
        assertEq(dms.getFunderStake(alice, ID, bob), 0);
        assertEq(dms.getFunderStake(alice, ID, carol), 0.25 ether, "carol untouched");
        assertEq(dms.getBounty(alice, ID), 0.25 ether);
        assertEq(address(dms).balance, 0.25 ether);

        uint256 carolBefore = carol.balance;
        vm.expectEmit(address(dms));
        emit DeadManSwitch.ContributionReclaimed(key, carol, 0.25 ether);
        vm.prank(carol);
        dms.reclaimContribution(alice, ID);

        assertEq(carol.balance - carolBefore, 0.25 ether);
        assertEq(dms.getBounty(alice, ID), 0, "pot drained exactly");
        assertEq(address(dms).balance, 0, "no dust left behind");
        _assertState(alice, ID, DeadManSwitch.State.CANCELLED);
    }

    function test_ReclaimContribution_RevertsNothingToReclaimForNonFunder() public {
        _create();
        _fund(bob, alice, ID, 1 ether);
        _cancel(alice, ID);

        vm.prank(eve);
        vm.expectRevert(DeadManSwitch.NothingToReclaim.selector);
        dms.reclaimContribution(alice, ID);

        // The owner's escrow is not a contribution (and was already refunded by cancel).
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NothingToReclaim.selector);
        dms.reclaimContribution(alice, ID);

        assertEq(dms.getBounty(alice, ID), 1 ether);
        assertEq(address(dms).balance, 1 ether);
    }

    function test_ReclaimContribution_RevertsNothingToReclaimOnDoubleReclaim() public {
        _create();
        _fund(bob, alice, ID, 1 ether);
        _fund(carol, alice, ID, 2 ether);
        _cancel(alice, ID);
        uint256 bobBefore = bob.balance;

        vm.prank(bob);
        dms.reclaimContribution(alice, ID);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.NothingToReclaim.selector);
        dms.reclaimContribution(alice, ID);

        assertEq(bob.balance - bobBefore, 1 ether, "paid once");
        assertEq(dms.getFunderStake(alice, ID, carol), 2 ether, "carol's money not touched");
        assertEq(address(dms).balance, 2 ether);
    }

    function test_ReclaimContribution_RevertsNotRescuableWhileAlive() public {
        _create();
        _fund(bob, alice, ID, 1 ether);

        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimContribution(alice, ID);
        assertEq(dms.getFunderStake(alice, ID, bob), 1 ether);
    }

    function test_ReclaimContribution_RevertsNotRescuableWhileDarkBeforeRescueDelay() public {
        _create();
        _fund(bob, alice, ID, 1 ether);
        uint64 deadline = dms.expirationTime(alice, ID);

        _warpToDark(alice, ID);
        _assertState(alice, ID, DeadManSwitch.State.DARK);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimContribution(alice, ID);

        dms.markDark(alice, ID);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimContribution(alice, ID);

        vm.warp(uint256(deadline) + dms.RESCUE_DELAY() - 1);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimContribution(alice, ID);

        assertEq(dms.getFunderStake(alice, ID, bob), 1 ether);
        assertEq(dms.getBounty(alice, ID), BOUNTY + 1 ether);
    }

    function test_ReclaimContribution_RevertsAlreadyRevealedAfterReveal() public {
        _create();
        _fund(bob, alice, ID, 1 ether);
        _reveal(alice, ID, eve);

        // The contribution went to the revealer with the rest of the pot.
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.AlreadyRevealed.selector);
        dms.reclaimContribution(alice, ID);
        assertEq(address(dms).balance, 0);
    }

    function test_ReclaimContribution_RevertsDoesNotExist() public {
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        dms.reclaimContribution(alice, ID);
    }

    function test_ReclaimContribution_ScopedToCancelledSwitch() public {
        _create(alice, 1);
        _create(alice, 2);
        _fund(bob, alice, 1, 1 ether);
        _fund(bob, alice, 2, 2 ether);
        _cancel(alice, 1);
        uint256 bobBefore = bob.balance;

        vm.prank(bob);
        dms.reclaimContribution(alice, 1);
        assertEq(bob.balance - bobBefore, 1 ether, "only the cancelled switch's stake");

        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimContribution(alice, 2);
        assertEq(dms.getFunderStake(alice, 2, bob), 2 ether);
        assertEq(dms.getBounty(alice, 2), BOUNTY + 2 ether);
    }

    /// @dev An owner who also funds via fundBounty holds two separate ledgers:
    ///      cancel refunds only the escrow; the contribution is reclaimed separately.
    function test_ReclaimContribution_OwnerSelfFundingRefundedSeparately() public {
        bytes32 key = _create();
        _fund(alice, alice, ID, 1 ether);
        assertEq(dms.getOwnerStake(alice, ID), BOUNTY);
        assertEq(dms.getFunderStake(alice, ID, alice), 1 ether);
        uint256 aliceBefore = alice.balance;

        vm.expectEmit(address(dms));
        emit DeadManSwitch.SwitchCancelled(key, alice, BOUNTY, uint64(_now()));
        _cancel(alice, ID);
        assertEq(alice.balance - aliceBefore, BOUNTY, "cancel refunds escrow only");
        assertEq(dms.getBounty(alice, ID), 1 ether);

        vm.expectEmit(address(dms));
        emit DeadManSwitch.ContributionReclaimed(key, alice, 1 ether);
        vm.prank(alice);
        dms.reclaimContribution(alice, ID);
        assertEq(alice.balance - aliceBefore, BOUNTY + 1 ether);
        assertEq(address(dms).balance, 0);
    }

    function test_ReclaimContribution_NonReceiverFunderRevertsTransferFailed() public {
        _create();
        NonReceiver nr = new NonReceiver();
        vm.deal(address(nr), 1 ether);
        _fund(address(nr), alice, ID, 1 ether);
        _cancel(alice, ID);

        vm.expectRevert(DeadManSwitch.TransferFailed.selector);
        nr.call(address(dms), abi.encodeCall(DeadManSwitch.reclaimContribution, (alice, ID)));

        assertEq(dms.getFunderStake(alice, ID, address(nr)), 1 ether, "stake preserved for a later retry");
        assertEq(address(dms).balance, 1 ether);
    }

    /// @dev Conservation across cancel + reclaim: every depositor gets back exactly
    ///      what they put in and the contract ends empty.
    function testFuzz_Cancel_ConservesFunds(uint256 a, uint256 b, uint256 elapsed) public {
        a = bound(a, 1, 50 ether);
        b = bound(b, 1, 50 ether);
        elapsed = bound(elapsed, 0, INTERVAL - 1);
        _create();
        _fund(bob, alice, ID, a);
        _fund(carol, alice, ID, b);
        vm.warp(_now() + elapsed);
        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        uint256 carolBefore = carol.balance;

        _cancel(alice, ID);
        vm.prank(carol);
        dms.reclaimContribution(alice, ID);
        vm.prank(bob);
        dms.reclaimContribution(alice, ID);

        assertEq(alice.balance - aliceBefore, BOUNTY);
        assertEq(bob.balance - bobBefore, a);
        assertEq(carol.balance - carolBefore, b);
        assertEq(dms.getBounty(alice, ID), 0);
        assertEq(address(dms).balance, 0);
    }
}
