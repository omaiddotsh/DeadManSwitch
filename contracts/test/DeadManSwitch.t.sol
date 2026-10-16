// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DMSTestBase} from "./utils/DMSTestBase.sol";
import {DeadManSwitch} from "../src/DeadManSwitch.sol";

/// @notice End-to-end lifecycle smoke test. Area-specific suites live in sibling files.
contract DeadManSwitchLifecycleTest is DMSTestBase {
    function test_Lifecycle_HappyPath() public {
        bytes32 key = _create();
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.ALIVE));
        assertEq(dms.getBounty(alice, ID), BOUNTY);

        vm.warp(block.timestamp + INTERVAL / 2);
        vm.prank(alice);
        dms.ping(ID);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.ALIVE));

        _warpToDark(alice, ID);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.DARK));
        assertFalse(_isPubliclyDecryptable(dms.getEncKeyHandle(alice, ID)));

        dms.markDark(alice, ID);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.DARK_MARKED));
        assertTrue(_isPubliclyDecryptable(dms.getEncKeyHandle(alice, ID)));

        uint256 bobBefore = bob.balance;
        bytes32 dataKey = _reveal(alice, ID, bob);
        assertEq(dataKey, bytes32(_dekFor(alice, ID)));
        assertEq(dms.getRevealedKey(alice, ID), dataKey);
        assertEq(bob.balance - bobBefore, BOUNTY);
        assertEq(dms.getBounty(alice, ID), 0);
        assertEq(uint8(dms.getState(alice, ID)), uint8(DeadManSwitch.State.REVEALED));

        vm.prank(carol);
        dms.publishPlaintext(alice, ID, SALT, PLAINTEXT);
        assertTrue(dms.getSwitchInfo(alice, ID).published);
        assertEq(dms.switchKey(alice, ID), key);
    }
}
