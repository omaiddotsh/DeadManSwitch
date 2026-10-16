// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DMSTestBase, MockPriceFeed} from "./utils/DMSTestBase.sol";
import {DeadManSwitch, AggregatorV3Interface} from "../src/DeadManSwitch.sol";
import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {externalEuint256} from "encrypted-types/EncryptedTypes.sol";

/// @notice Rescue path (RESCUE_DELAY), admin role, oracle math, and constructor/deployment config.
contract RescueAdminTest is DMSTestBase {
    uint256 internal constant FUND = 1 ether;
    /// @dev $10 at $2,000/ETH.
    uint256 internal constant MIN_BOUNTY_WEI = 0.005 ether;

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

    /// @dev First timestamp at which (owner, id) is rescuable.
    function _rescueAt(address owner, uint256 id) internal view returns (uint256) {
        return uint256(dms.expirationTime(owner, id)) + dms.RESCUE_DELAY();
    }

    function _assertState(address owner, uint256 id, DeadManSwitch.State expected) internal view {
        assertEq(uint8(dms.getState(owner, id)), uint8(expected), "state");
    }

    function _rescuable(address owner, uint256 id) internal view returns (bool) {
        return dms.getSwitchInfo(owner, id).rescuable;
    }

    // ===================================================================== //
    //                                 Rescue                                //
    // ===================================================================== //

    function test_Rescue_BothRevertBeforeDelay() public {
        _create();
        _fund(bob, alice, ID, FUND);

        // Alive: the owner cannot pull their stake without cancelling.
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimOwnerStake(ID);

        // Dark and marked, one second short of the rescue delay.
        _darkAndMark(alice, ID);
        vm.warp(_rescueAt(alice, ID) - 1);
        assertFalse(_rescuable(alice, ID), "rescuable");

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimOwnerStake(ID);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimContribution(alice, ID);

        assertEq(dms.getOwnerStake(alice, ID), BOUNTY, "ownerStake");
        assertEq(dms.getFunderStake(alice, ID, bob), FUND, "funderStake");
        assertEq(dms.getBounty(alice, ID), BOUNTY + FUND, "bounty");
        assertEq(address(dms).balance, BOUNTY + FUND, "escrow");
    }

    function test_Rescue_AtExactDelayReclaimsExactAmounts() public {
        bytes32 key = _create();
        _fund(bob, alice, ID, FUND);
        _fund(carol, alice, ID, 2 * FUND);

        vm.warp(_rescueAt(alice, ID));
        assertTrue(_rescuable(alice, ID), "rescuable");
        _assertState(alice, ID, DeadManSwitch.State.DARK);

        uint256 aliceBefore = alice.balance;
        vm.expectEmit(address(dms));
        emit DeadManSwitch.OwnerStakeReclaimed(key, alice, BOUNTY);
        vm.prank(alice);
        dms.reclaimOwnerStake(ID);

        assertEq(alice.balance, aliceBefore + BOUNTY, "alice refunded");
        assertEq(dms.getOwnerStake(alice, ID), 0, "ownerStake cleared");
        assertEq(dms.getBounty(alice, ID), 3 * FUND, "bounty after owner rescue");
        assertEq(address(dms).balance, 3 * FUND, "escrow after owner rescue");

        uint256 bobBefore = bob.balance;
        vm.expectEmit(address(dms));
        emit DeadManSwitch.ContributionReclaimed(key, bob, FUND);
        vm.prank(bob);
        dms.reclaimContribution(alice, ID);

        assertEq(bob.balance, bobBefore + FUND, "bob refunded");
        assertEq(dms.getFunderStake(alice, ID, bob), 0, "bob stake cleared");
        assertEq(dms.getFunderStake(alice, ID, carol), 2 * FUND, "carol untouched");
        assertEq(dms.getBounty(alice, ID), 2 * FUND, "bounty after bob rescue");
        assertEq(address(dms).balance, 2 * FUND, "escrow after bob rescue");

        // The switch stays ACTIVE (not cancelled): a late reveal can still land.
        _assertState(alice, ID, DeadManSwitch.State.DARK);
        assertTrue(dms.isDark(alice, ID), "isDark");
        assertTrue(_rescuable(alice, ID), "still rescuable");
    }

    function test_Rescue_MarkDarkDoesNotBlockRescue() public {
        bytes32 key = _create();
        _fund(bob, alice, ID, FUND);
        _darkAndMark(alice, ID);
        bytes32 handle = dms.getEncKeyHandle(alice, ID);

        vm.warp(_rescueAt(alice, ID));
        assertTrue(_rescuable(alice, ID), "rescuable");
        _assertState(alice, ID, DeadManSwitch.State.DARK_MARKED);

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        vm.expectEmit(address(dms));
        emit DeadManSwitch.OwnerStakeReclaimed(key, alice, BOUNTY);
        vm.prank(alice);
        dms.reclaimOwnerStake(ID);
        vm.expectEmit(address(dms));
        emit DeadManSwitch.ContributionReclaimed(key, bob, FUND);
        vm.prank(bob);
        dms.reclaimContribution(alice, ID);

        assertEq(alice.balance, aliceBefore + BOUNTY, "alice refunded");
        assertEq(bob.balance, bobBefore + FUND, "bob refunded");
        assertEq(dms.getBounty(alice, ID), 0, "bounty");
        assertEq(address(dms).balance, 0, "escrow");
        // Rescue refunds deposits; it does not (and cannot) re-seal the key.
        _assertState(alice, ID, DeadManSwitch.State.DARK_MARKED);
        assertTrue(_isPubliclyDecryptable(handle), "key still decryptable");
    }

    function test_Rescue_LateRevealAfterPartialRescuePaysRemainder() public {
        bytes32 key = _create();
        _fund(bob, alice, ID, FUND);
        _fund(carol, alice, ID, 2 * FUND);
        _darkAndMark(alice, ID);
        vm.warp(_rescueAt(alice, ID));

        vm.prank(alice);
        dms.reclaimOwnerStake(ID);
        vm.prank(bob);
        dms.reclaimContribution(alice, ID);
        assertEq(dms.getBounty(alice, ID), 2 * FUND, "carol's stake remains");

        (bytes32 dataKey, bytes memory proof) = _kmsDecrypt(alice, ID);
        uint256 eveBefore = eve.balance;
        vm.expectEmit(address(dms));
        emit DeadManSwitch.KeyRevealed(key, eve, dataKey, 2 * FUND, uint64(_now()));
        vm.prank(eve);
        dms.revealKey(alice, ID, dataKey, proof);

        assertEq(dataKey, bytes32(_dekFor(alice, ID)), "dek");
        assertEq(eve.balance, eveBefore + 2 * FUND, "revealer paid remainder only");
        assertEq(dms.getBounty(alice, ID), 0, "bounty");
        assertEq(address(dms).balance, 0, "escrow");
        assertEq(dms.getRevealedKey(alice, ID), dataKey, "revealedKey");
        _assertState(alice, ID, DeadManSwitch.State.REVEALED);
        assertFalse(_rescuable(alice, ID), "rescuable");

        // Carol's unreclaimed contribution went to the revealer, as funders intend.
        vm.prank(carol);
        vm.expectRevert(DeadManSwitch.AlreadyRevealed.selector);
        dms.reclaimContribution(alice, ID);
    }

    function test_Rescue_LateRevealAfterFullRescuePaysZero() public {
        bytes32 key = _create();
        _fund(bob, alice, ID, FUND);
        vm.warp(_rescueAt(alice, ID));

        vm.prank(alice);
        dms.reclaimOwnerStake(ID);
        vm.prank(bob);
        dms.reclaimContribution(alice, ID);
        assertEq(dms.getBounty(alice, ID), 0, "pot drained");

        // Never marked before the rescue: marking still works afterwards.
        dms.markDark(alice, ID);
        (bytes32 dataKey, bytes memory proof) = _kmsDecrypt(alice, ID);
        uint256 eveBefore = eve.balance;
        vm.expectEmit(address(dms));
        emit DeadManSwitch.KeyRevealed(key, eve, dataKey, 0, uint64(_now()));
        vm.prank(eve);
        dms.revealKey(alice, ID, dataKey, proof);

        assertEq(eve.balance, eveBefore, "nothing to pay");
        assertEq(dms.getRevealedKey(alice, ID), bytes32(_dekFor(alice, ID)), "revealedKey");
        _assertState(alice, ID, DeadManSwitch.State.REVEALED);
        assertEq(address(dms).balance, 0, "escrow");
    }

    function test_Rescue_DoubleReclaimRevertsNothingToReclaim() public {
        _create();
        _fund(bob, alice, ID, FUND);
        vm.warp(_rescueAt(alice, ID));
        vm.prank(alice);
        dms.reclaimOwnerStake(ID);
        vm.prank(bob);
        dms.reclaimContribution(alice, ID);

        uint256 aliceBefore = alice.balance;
        uint256 bobBefore = bob.balance;
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NothingToReclaim.selector);
        dms.reclaimOwnerStake(ID);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.NothingToReclaim.selector);
        dms.reclaimContribution(alice, ID);
        // A non-funder has nothing to reclaim either.
        vm.prank(carol);
        vm.expectRevert(DeadManSwitch.NothingToReclaim.selector);
        dms.reclaimContribution(alice, ID);

        assertEq(alice.balance, aliceBefore, "alice");
        assertEq(bob.balance, bobBefore, "bob");
        assertEq(address(dms).balance, 0, "escrow");
    }

    function test_Rescue_OwnerStakeKeyedByCaller() public {
        _create(alice, ID);
        _fund(bob, alice, ID, FUND);
        vm.warp(_rescueAt(alice, ID));

        // `reclaimOwnerStake(id)` derives the key from msg.sender: a funder of
        // alice's switch addresses (bob, ID), which does not exist.
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.DoesNotExist.selector);
        dms.reclaimOwnerStake(ID);

        // Bob's own switch with the same id is distinct and still alive.
        _create(bob, ID);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimOwnerStake(ID);

        assertEq(dms.getOwnerStake(alice, ID), BOUNTY, "alice stake untouched");
        assertEq(dms.getOwnerStake(bob, ID), BOUNTY, "bob stake untouched");
        uint256 aliceBefore = alice.balance;
        vm.prank(alice);
        dms.reclaimOwnerStake(ID);
        assertEq(alice.balance, aliceBefore + BOUNTY, "alice rescued");
        assertEq(dms.getBounty(bob, ID), BOUNTY, "bob's switch unaffected");
    }

    function test_Rescue_UnavailableAfterCancel() public {
        _create();
        _fund(bob, alice, ID, FUND);
        uint256 rescueAt = _rescueAt(alice, ID);
        vm.prank(alice);
        dms.cancel(ID);

        vm.warp(rescueAt + 365 days);
        assertFalse(_rescuable(alice, ID), "rescuable");
        assertFalse(dms.isDark(alice, ID), "isDark");
        _assertState(alice, ID, DeadManSwitch.State.CANCELLED);

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimOwnerStake(ID);
        // The cancelled switch's key was never made decryptable.
        assertFalse(_isPubliclyDecryptable(dms.getEncKeyHandle(alice, ID)), "key sealed");
        assertEq(dms.getBounty(alice, ID), FUND, "only bob's stake left");
    }

    function test_Rescue_UnavailableAfterReveal() public {
        _create();
        _fund(bob, alice, ID, FUND);
        uint256 rescueAt = _rescueAt(alice, ID);
        _reveal(alice, ID, eve);

        vm.warp(rescueAt + 1 days);
        assertFalse(_rescuable(alice, ID), "rescuable");

        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.NotRescuable.selector);
        dms.reclaimOwnerStake(ID);
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.AlreadyRevealed.selector);
        dms.reclaimContribution(alice, ID);
        assertEq(dms.getBounty(alice, ID), 0, "bounty");
        assertEq(address(dms).balance, 0, "escrow");
    }

    function test_Rescue_RescuableFlagTracksLifecycle() public {
        assertFalse(_rescuable(alice, ID), "nonexistent");

        _create();
        uint256 originalRescueAt = _rescueAt(alice, ID);
        assertFalse(_rescuable(alice, ID), "alive");

        // A ping moves the rescue window with the deadline.
        vm.warp(_now() + INTERVAL / 2);
        vm.prank(alice);
        dms.ping(ID);
        uint256 rescueAt = _rescueAt(alice, ID);
        assertEq(rescueAt, originalRescueAt + INTERVAL / 2, "window moved");

        vm.warp(originalRescueAt);
        _assertState(alice, ID, DeadManSwitch.State.DARK);
        assertFalse(_rescuable(alice, ID), "old window no longer counts");
        vm.warp(rescueAt - 1);
        assertFalse(_rescuable(alice, ID), "one second early");
        vm.warp(rescueAt);
        assertTrue(_rescuable(alice, ID), "at delay");

        // The flag reflects the switch state, not remaining balances.
        vm.prank(alice);
        dms.reclaimOwnerStake(ID);
        assertTrue(_rescuable(alice, ID), "after owner rescue");
        dms.markDark(alice, ID);
        assertTrue(_rescuable(alice, ID), "after markDark");

        _reveal(alice, ID, eve);
        assertFalse(_rescuable(alice, ID), "after reveal");
    }

    /// @dev Whatever subset of depositors rescues first, each gets back exactly their own
    ///      deposit and a late revealer collects exactly what nobody reclaimed.
    function testFuzz_Rescue_LateRevealPaysExactlyUnreclaimedRemainder(
        uint256 ownerAmt,
        uint256 bobAmt,
        uint256 carolAmt,
        uint8 reclaimMask
    ) public {
        ownerAmt = bound(ownerAmt, MIN_BOUNTY_WEI, 10 ether);
        bobAmt = bound(bobAmt, 1, 10 ether);
        carolAmt = bound(carolAmt, 1, 10 ether);
        _create(alice, ID, INTERVAL, ownerAmt, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));
        _fund(bob, alice, ID, bobAmt);
        _fund(carol, alice, ID, carolAmt);
        vm.warp(_rescueAt(alice, ID));

        uint256 remainder = ownerAmt + bobAmt + carolAmt;
        if (reclaimMask & 1 != 0) {
            uint256 before = alice.balance;
            vm.prank(alice);
            dms.reclaimOwnerStake(ID);
            assertEq(alice.balance - before, ownerAmt, "alice");
            remainder -= ownerAmt;
        }
        if (reclaimMask & 2 != 0) {
            uint256 before = bob.balance;
            vm.prank(bob);
            dms.reclaimContribution(alice, ID);
            assertEq(bob.balance - before, bobAmt, "bob");
            remainder -= bobAmt;
        }
        if (reclaimMask & 4 != 0) {
            uint256 before = carol.balance;
            vm.prank(carol);
            dms.reclaimContribution(alice, ID);
            assertEq(carol.balance - before, carolAmt, "carol");
            remainder -= carolAmt;
        }
        assertEq(dms.getBounty(alice, ID), remainder, "bounty");
        assertEq(address(dms).balance, remainder, "escrow");

        uint256 eveBefore = eve.balance;
        _reveal(alice, ID, eve);
        assertEq(eve.balance - eveBefore, remainder, "revealer");
        assertEq(address(dms).balance, 0, "escrow drained");
    }

    // ===================================================================== //
    //                                 Admin                                 //
    // ===================================================================== //

    // `dms` is deployed by this test contract in setUp, so address(this) is admin.

    function test_Admin_SetMinBountyUsdUpdatesAndEmits() public {
        vm.expectEmit(address(dms));
        emit DeadManSwitch.MinBountyUsdUpdated(MIN_USD, 25e8);
        dms.setMinBountyUsd(25e8);
        assertEq(dms.minBountyUsd(), 25e8, "minBountyUsd");
        assertEq(dms.minBounty(), 0.0125 ether, "$25 at $2,000/ETH");

        // The cap itself is accepted.
        uint256 cap = dms.MAX_MIN_BOUNTY_USD();
        vm.expectEmit(address(dms));
        emit DeadManSwitch.MinBountyUsdUpdated(25e8, cap);
        dms.setMinBountyUsd(cap);
        assertEq(dms.minBountyUsd(), cap, "cap");
        assertEq(dms.minBounty(), 5 ether, "$10,000 at $2,000/ETH");

        // Zero disables the floor.
        vm.expectEmit(address(dms));
        emit DeadManSwitch.MinBountyUsdUpdated(cap, 0);
        dms.setMinBountyUsd(0);
        assertEq(dms.minBounty(), 0, "floor disabled");
    }

    function test_Admin_SetMinBountyUsdAppliesToNewSwitchesOnly() public {
        _create(alice, 1);
        dms.setMinBountyUsd(dms.MAX_MIN_BOUNTY_USD()); // floor is now 5 ether

        // The existing switch, created with a 0.05 ether bounty, keeps working.
        vm.prank(alice);
        dms.ping(1);
        _fund(bob, alice, 1, FUND);
        assertEq(dms.getBounty(alice, 1), BOUNTY + FUND, "bounty");

        // A new one must meet the raised floor.
        (bytes memory ct, bytes32 c) = (_ciphertext(PLAINTEXT.length), _commitment(SALT, PLAINTEXT));
        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, 2));
        vm.prank(alice);
        vm.expectRevert(DeadManSwitch.BountyTooLow.selector);
        dms.createSwitch{value: 5 ether - 1}(_params(2, INTERVAL, c), ct, h, proof);
        vm.prank(alice);
        dms.createSwitch{value: 5 ether}(_params(2, INTERVAL, c), ct, h, proof);
        assertEq(dms.getOwnerStake(alice, 2), 5 ether, "new switch stake");
    }

    function test_Admin_SetMinBountyUsdRevertsUnauthorized() public {
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.setMinBountyUsd(1e8);
        assertEq(dms.minBountyUsd(), MIN_USD);
    }

    function test_Admin_SetMinBountyUsdRevertsAboveMax() public {
        uint256 cap = dms.MAX_MIN_BOUNTY_USD();
        vm.expectRevert(DeadManSwitch.MinBountyUsdTooHigh.selector);
        dms.setMinBountyUsd(cap + 1);
        vm.expectRevert(DeadManSwitch.MinBountyUsdTooHigh.selector);
        dms.setMinBountyUsd(type(uint256).max);
        assertEq(dms.minBountyUsd(), MIN_USD);
    }

    function test_Admin_SetMinBountyUsdRevertsInvalidConfigWithoutFeed() public {
        DeadManSwitch noFeed = new DeadManSwitch(address(0), 0, 0);
        vm.expectRevert(DeadManSwitch.InvalidConfig.selector);
        noFeed.setMinBountyUsd(1);
        assertEq(noFeed.minBountyUsd(), 0);

        // Zero remains settable (a no-op update) on a feed-less deployment.
        vm.expectEmit(address(noFeed));
        emit DeadManSwitch.MinBountyUsdUpdated(0, 0);
        noFeed.setMinBountyUsd(0);
    }

    function test_Admin_TwoStepTransfer() public {
        vm.expectEmit(address(dms));
        emit DeadManSwitch.AdminTransferStarted(address(this), bob);
        dms.transferAdmin(bob);
        assertEq(dms.pendingAdmin(), bob, "pending");
        assertEq(dms.admin(), address(this), "admin unchanged until accepted");

        // Pending is not admin.
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.setMinBountyUsd(1e8);

        // Only the pending address may accept.
        vm.prank(carol);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.acceptAdmin();
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.acceptAdmin();

        vm.expectEmit(address(dms));
        emit DeadManSwitch.AdminTransferred(address(this), bob);
        vm.prank(bob);
        dms.acceptAdmin();
        assertEq(dms.admin(), bob, "admin");
        assertEq(dms.pendingAdmin(), address(0), "pending cleared");

        // The old admin is locked out; the new one has every admin power.
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.setMinBountyUsd(1e8);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.transferAdmin(address(this));
        vm.prank(bob);
        dms.setMinBountyUsd(1e8);
        assertEq(dms.minBountyUsd(), 1e8);

        // A second accept is impossible: nothing is pending.
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.acceptAdmin();
    }

    function test_Admin_TransferAdminRevertsUnauthorized() public {
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.transferAdmin(bob);
        assertEq(dms.pendingAdmin(), address(0));
    }

    function test_Admin_TransferAdminOverwritesPending() public {
        dms.transferAdmin(bob);
        dms.transferAdmin(carol);
        assertEq(dms.pendingAdmin(), carol);

        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.acceptAdmin();
        vm.prank(carol);
        dms.acceptAdmin();
        assertEq(dms.admin(), carol);
    }

    function test_Admin_TransferAdminToZeroCancelsPending() public {
        dms.transferAdmin(bob);

        vm.expectEmit(address(dms));
        emit DeadManSwitch.AdminTransferStarted(address(this), address(0));
        dms.transferAdmin(address(0));
        assertEq(dms.pendingAdmin(), address(0), "pending cleared");

        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.acceptAdmin();
        // pendingAdmin == 0 must not let the zero address "accept".
        vm.prank(address(0));
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.acceptAdmin();
        assertEq(dms.admin(), address(this), "admin unchanged");
    }

    function test_Admin_RenounceClearsAdminAndPendingAndBlocksAdminCalls() public {
        dms.transferAdmin(bob);

        vm.expectEmit(address(dms));
        emit DeadManSwitch.AdminTransferred(address(this), address(0));
        dms.renounceAdmin();
        assertEq(dms.admin(), address(0), "admin");
        assertEq(dms.pendingAdmin(), address(0), "pending");

        // A transfer started before renouncing can no longer complete.
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.acceptAdmin();

        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.setMinBountyUsd(0);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.transferAdmin(bob);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.renounceAdmin();
        assertEq(dms.minBountyUsd(), MIN_USD, "floor fixed forever");
    }

    function test_Admin_RenounceRevertsUnauthorized() public {
        vm.prank(bob);
        vm.expectRevert(DeadManSwitch.Unauthorized.selector);
        dms.renounceAdmin();
        assertEq(dms.admin(), address(this));
    }

    // ===================================================================== //
    //                                 Oracle                                //
    // ===================================================================== //

    function test_Oracle_MinBountyEightDecimalFeed() public {
        assertEq(dms.minBounty(), MIN_BOUNTY_WEI, "$10 at $2,000/ETH");

        // Rounds down: 10 * 1e18 / 3000 = 3333333333333333.33…
        feed.setPrice(3000e8);
        assertEq(dms.minBounty(), 3_333_333_333_333_333, "$10 at $3,000/ETH");

        feed.setPrice(1e8);
        assertEq(dms.minBounty(), 10 ether, "$10 at $1/ETH");
    }

    function test_Oracle_MinBountyEighteenDecimalFeed() public {
        MockPriceFeed feed18 = new MockPriceFeed(2000e18, 18);
        DeadManSwitch d18 = new DeadManSwitch(address(feed18), MIN_USD, MAX_PRICE_AGE);
        assertEq(d18.minBounty(), MIN_BOUNTY_WEI, "$10 at $2,000/ETH");
        assertEq(d18.minBounty(), dms.minBounty(), "same as 8-decimal feed");

        feed18.setPrice(3000e18);
        assertEq(d18.minBounty(), 3_333_333_333_333_333, "$10 at $3,000/ETH");
    }

    function test_Oracle_MinBountyZeroAndMaxDecimalFeeds() public {
        MockPriceFeed feed0 = new MockPriceFeed(2000, 0);
        DeadManSwitch d0 = new DeadManSwitch(address(feed0), MIN_USD, MAX_PRICE_AGE);
        assertEq(d0.minBounty(), MIN_BOUNTY_WEI, "0 decimals");

        MockPriceFeed feed36 = new MockPriceFeed(2000e36, 36);
        DeadManSwitch d36 = new DeadManSwitch(address(feed36), dms.MAX_MIN_BOUNTY_USD(), MAX_PRICE_AGE);
        assertEq(d36.minBounty(), 5 ether, "36 decimals, $10,000 at $2,000/ETH");
    }

    /// @dev minBounty is the floor of minBountyUsd / price in wei, for 8- and 18-decimal feeds.
    function testFuzz_Oracle_MinBountyIsFlooredUsdOverPrice(uint256 usd, uint256 priceUsd, bool eighteenDecimals)
        public
    {
        uint8 dec = eighteenDecimals ? 18 : 8;
        uint256 one = 10 ** dec;
        usd = bound(usd, 1, dms.MAX_MIN_BOUNTY_USD());
        // $0.01 .. $10,000,000 per ETH, at the feed's precision.
        priceUsd = bound(priceUsd, one / 100, 10_000_000 * one);
        MockPriceFeed f = new MockPriceFeed(int256(priceUsd), dec);
        DeadManSwitch d = new DeadManSwitch(address(f), usd, MAX_PRICE_AGE);

        uint256 mb = d.minBounty();
        // usd has 8 decimals, price `dec` decimals, result in wei (18 decimals).
        uint256 usdWeiScaled = usd * 10 ** (10 + dec);
        assertLe(mb * priceUsd, usdWeiScaled, "not above the USD floor");
        assertGt((mb + 1) * priceUsd, usdWeiScaled, "within 1 wei of it");
    }

    function test_Oracle_StalePriceBoundaryFailsOpen() public {
        vm.warp(1_000_000);
        uint256 t = _now();

        feed.setUpdatedAt(t - MAX_PRICE_AGE);
        assertEq(dms.minBounty(), MIN_BOUNTY_WEI, "exactly maxPriceAge old is fresh");

        feed.setUpdatedAt(t - MAX_PRICE_AGE - 1);
        assertEq(dms.minBounty(), 0, "stale answer: floor fails open");
        (bool ok,) = dms.oraclePrice();
        assertFalse(ok, "oracle reported unusable");

        // The same answer ages out as time passes.
        feed.setUpdatedAt(t);
        assertEq(dms.minBounty(), MIN_BOUNTY_WEI, "fresh");
        vm.warp(t + MAX_PRICE_AGE);
        assertEq(dms.minBounty(), MIN_BOUNTY_WEI, "aged to the limit");
        vm.warp(t + MAX_PRICE_AGE + 1);
        assertEq(dms.minBounty(), 0, "aged out");
    }

    function test_Oracle_FutureUpdatedAtFailsOpen() public {
        vm.warp(1_000_000);
        feed.setUpdatedAt(_now() + 1);
        assertEq(dms.minBounty(), 0);
        (bool ok, uint256 price) = dms.oraclePrice();
        assertFalse(ok);
        assertEq(price, 0);
    }

    function test_Oracle_RevertingFeedFailsOpen() public {
        vm.mockCallRevert(
            address(feed), abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector), "feed down"
        );
        assertEq(dms.minBounty(), 0);
        (bool ok,) = dms.oraclePrice();
        assertFalse(ok);
        _create(alice, ID, INTERVAL, 0, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));
        _assertState(alice, ID, DeadManSwitch.State.ALIVE);
    }

    function test_Oracle_CodelessFeedFailsOpen() public {
        // The feed contract self-destructed or was never there: no code at all.
        vm.etch(address(feed), "");
        assertEq(dms.minBounty(), 0);
        (bool ok,) = dms.oraclePrice();
        assertFalse(ok);
        _create(alice, ID, INTERVAL, 0, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));
        _assertState(alice, ID, DeadManSwitch.State.ALIVE);
    }

    function test_Oracle_ShortReturnDataFailsOpen() public {
        vm.mockCall(
            address(feed), abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector), abi.encode(1, 2)
        );
        assertEq(dms.minBounty(), 0);
        (bool ok,) = dms.oraclePrice();
        assertFalse(ok);
    }

    function test_Oracle_OutOfRangeRoundIdDoesNotRevert() public {
        // A feed returning a roundId wider than uint80 must not make minBounty revert.
        vm.mockCall(
            address(feed),
            abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector),
            abi.encode(type(uint256).max, ETH_USD, _now(), _now(), type(uint256).max)
        );
        assertEq(dms.minBounty(), MIN_BOUNTY_WEI);
    }

    /// @dev Regression: renounce with the floor on, then the
    ///      immutable feed dies. createSwitch must keep working forever.
    function test_Oracle_RenouncedAdminWithDeadFeedCanStillCreate() public {
        assertEq(dms.minBountyUsd(), MIN_USD, "floor on");
        dms.renounceAdmin();
        vm.etch(address(feed), "");
        vm.warp(_now() + 3650 days);
        _create(alice, ID, INTERVAL, 0, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));
        _assertState(alice, ID, DeadManSwitch.State.ALIVE);
    }

    /// @dev A feed that fails by consuming all the gas it is given (an `INVALID` opcode, an
    ///      old-Solidity `assert`, a loop) must fail open like a reverting one. Uncapped, the
    ///      feed read would burn 63/64 of the gas and leave too little for the FHE work, and
    ///      no transaction could supply 64x a create's gas under the EIP-7825 cap (2^24).
    function test_Oracle_GasBurningFeedFailsOpenWithinTxGasCap() public {
        dms.renounceAdmin();
        vm.etch(address(feed), hex"fe"); // every call hits INVALID and consumes all its gas

        (externalEuint256 h, bytes memory proof) = _encKey(alice, _dekFor(alice, ID));
        bytes memory ct = _ciphertext(dms.MAX_PAYLOAD_SIZE()); // the most expensive create
        vm.prank(alice);
        dms.createSwitch{value: 0, gas: 1 << 24}(_params(ID, INTERVAL, _commitment(SALT, PLAINTEXT)), ct, h, proof);

        _assertState(alice, ID, DeadManSwitch.State.ALIVE);
        assertEq(dms.minBounty(), 0, "floor fails open");
        (bool ok,) = dms.oraclePrice();
        assertFalse(ok, "oracle reported unusable");
    }

    function test_Oracle_DeadFeedDoesNotAffectExistingSwitches() public {
        bytes32 keyA = _create(alice, ID);
        _create(bob, ID);
        _create(carol, ID);

        // The feed is gone: every read reverts.
        vm.mockCallRevert(
            address(feed), abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector), "feed down"
        );
        assertEq(dms.minBounty(), 0, "floor fails open");

        // ALIVE operations: ping, fund, cancel.
        vm.warp(_now() + INTERVAL / 2);
        vm.prank(alice);
        dms.ping(ID);
        _fund(eve, alice, ID, FUND);
        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        dms.cancel(ID);
        assertEq(bob.balance, bobBefore + BOUNTY, "cancel refund");

        // markDark + reveal.
        _darkAndMark(alice, ID);
        (bytes32 dataKey, bytes memory proof) = _kmsDecrypt(alice, ID);
        uint256 eveBefore = eve.balance;
        vm.expectEmit(address(dms));
        emit DeadManSwitch.KeyRevealed(keyA, eve, dataKey, BOUNTY + FUND, uint64(_now()));
        vm.prank(eve);
        dms.revealKey(alice, ID, dataKey, proof);
        assertEq(eve.balance, eveBefore + BOUNTY + FUND, "reveal paid");
        _assertState(alice, ID, DeadManSwitch.State.REVEALED);

        // Rescue.
        vm.warp(_rescueAt(carol, ID));
        uint256 carolBefore = carol.balance;
        vm.prank(carol);
        dms.reclaimOwnerStake(ID);
        assertEq(carol.balance, carolBefore + BOUNTY, "rescue refund");

        assertEq(address(dms).balance, 0, "escrow");
    }

    // ===================================================================== //
    //                              Constructor                              //
    // ===================================================================== //

    function test_Constructor_StoresConfig() public view {
        assertEq(address(dms.ethUsdPriceFeed()), address(feed), "feed");
        assertEq(dms.maxPriceAge(), MAX_PRICE_AGE, "maxPriceAge");
        assertEq(dms.minBountyUsd(), MIN_USD, "minBountyUsd");
        assertEq(dms.admin(), address(this), "admin is deployer");
        assertEq(dms.pendingAdmin(), address(0), "no pending admin");
        assertEq(dms.RESCUE_DELAY(), 30 days, "RESCUE_DELAY");
        assertEq(dms.MAX_MIN_BOUNTY_USD(), 10_000e8, "MAX_MIN_BOUNTY_USD");
        assertEq(dms.confidentialProtocolId(), type(uint256).max, "local protocol id");
    }

    function test_Constructor_EmitsAdminTransferredToDeployer() public {
        address predicted = vm.computeCreateAddress(carol, vm.getNonce(carol));
        vm.expectEmit(predicted);
        emit DeadManSwitch.AdminTransferred(address(0), carol);
        vm.prank(carol);
        DeadManSwitch d = new DeadManSwitch(address(feed), MIN_USD, MAX_PRICE_AGE);
        assertEq(address(d), predicted, "address");
        assertEq(d.admin(), carol, "admin");
        assertEq(d.pendingAdmin(), address(0), "pending");
    }

    function test_Constructor_FeedlessDeployment() public {
        DeadManSwitch d = new DeadManSwitch(address(0), 0, 0);
        assertEq(address(d.ethUsdPriceFeed()), address(0), "feed");
        assertEq(d.maxPriceAge(), 0, "maxPriceAge");
        assertEq(d.minBountyUsd(), 0, "minBountyUsd");
        assertEq(d.minBounty(), 0, "minBounty");
        assertEq(d.admin(), address(this), "admin");
    }

    function test_Constructor_RevertsInvalidConfigFeedlessWithFloor() public {
        vm.expectRevert(DeadManSwitch.InvalidConfig.selector);
        new DeadManSwitch(address(0), 1, MAX_PRICE_AGE);
        vm.expectRevert(DeadManSwitch.InvalidConfig.selector);
        new DeadManSwitch(address(0), MIN_USD, 0);
    }

    function test_Constructor_RevertsInvalidConfigFeedWithZeroMaxAge() public {
        vm.expectRevert(DeadManSwitch.InvalidConfig.selector);
        new DeadManSwitch(address(feed), MIN_USD, 0);
        // Even with the floor disabled: a configured feed always needs a staleness bound.
        vm.expectRevert(DeadManSwitch.InvalidConfig.selector);
        new DeadManSwitch(address(feed), 0, 0);
    }

    function test_Constructor_RevertsInvalidConfigFeedDecimalsAbove36() public {
        MockPriceFeed feed37 = new MockPriceFeed(2000e36, 37);
        vm.expectRevert(DeadManSwitch.InvalidConfig.selector);
        new DeadManSwitch(address(feed37), MIN_USD, MAX_PRICE_AGE);
    }

    function test_Constructor_RevertsMinBountyUsdTooHigh() public {
        uint256 cap = dms.MAX_MIN_BOUNTY_USD();
        vm.expectRevert(DeadManSwitch.MinBountyUsdTooHigh.selector);
        new DeadManSwitch(address(feed), cap + 1, MAX_PRICE_AGE);
        // Checked before the feed-less rule.
        vm.expectRevert(DeadManSwitch.MinBountyUsdTooHigh.selector);
        new DeadManSwitch(address(0), cap + 1, 0);

        DeadManSwitch d = new DeadManSwitch(address(feed), cap, MAX_PRICE_AGE);
        assertEq(d.minBountyUsd(), cap, "cap accepted");
    }

    function test_Constructor_RevertsOnUnsupportedChain() public {
        vm.chainId(10);
        vm.expectRevert(ZamaConfig.ZamaProtocolUnsupported.selector);
        new DeadManSwitch(address(feed), MIN_USD, MAX_PRICE_AGE);
    }

    function test_Constructor_DeploysOnMainnetAndSepoliaChainIds() public {
        vm.chainId(1);
        assertEq(new DeadManSwitch(address(feed), MIN_USD, MAX_PRICE_AGE).confidentialProtocolId(), 1, "mainnet");
        vm.chainId(11155111);
        assertEq(new DeadManSwitch(address(feed), MIN_USD, MAX_PRICE_AGE).confidentialProtocolId(), 10001, "sepolia");
    }
}
