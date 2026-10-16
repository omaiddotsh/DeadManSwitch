// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeadManSwitch} from "../src/DeadManSwitch.sol";
import {MockPriceFeed} from "./utils/DMSTestBase.sol";

/// @notice Deploy.s.sol reads its environment through `run()`. Environment variables are
///         process-wide and forge runs tests in parallel, so this is the only test in the
///         suite that sets them; it sets all five itself and clears them again at the end.
contract DeployScriptEnvTest is Test {
    address internal constant SAFE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;

    function _clearEnv() internal {
        vm.setEnv("PRIVATE_KEY", "");
        vm.setEnv("ETH_USD_PRICE_FEED", "");
        vm.setEnv("MIN_BOUNTY_USD", "");
        vm.setEnv("MAX_PRICE_AGE", "");
        vm.setEnv("NEW_ADMIN", "");
    }

    function test_Run_ParsesEnvStrictlyAndTreatsEmptyAsUnset() public {
        Deploy script = new Deploy();
        MockPriceFeed feed = new MockPriceFeed(2000e8, 8);

        // Every variable empty: the defaults (no feed, no floor, no admin hand-over).
        _clearEnv();
        DeadManSwitch dms = script.run();
        assertEq(address(dms.ethUsdPriceFeed()), address(0), "empty feed = unset");
        assertEq(dms.minBountyUsd(), 0, "empty floor = unset");
        assertEq(dms.maxPriceAge(), 0, "feedless: maxPriceAge 0");
        assertEq(dms.pendingAdmin(), address(0), "empty NEW_ADMIN = unset");

        // Well-formed values are used exactly.
        vm.setEnv("ETH_USD_PRICE_FEED", vm.toString(address(feed)));
        vm.setEnv("MIN_BOUNTY_USD", "1000000000");
        vm.setEnv("MAX_PRICE_AGE", "3600");
        vm.setEnv("NEW_ADMIN", vm.toString(SAFE));
        dms = script.run();
        assertEq(address(dms.ethUsdPriceFeed()), address(feed), "feed");
        assertEq(dms.minBountyUsd(), 1000000000, "minBountyUsd");
        assertEq(dms.maxPriceAge(), 3600, "maxPriceAge");
        assertEq(dms.pendingAdmin(), SAFE, "pendingAdmin");

        // A malformed value reverts instead of silently becoming the default.
        vm.setEnv("MIN_BOUNTY_USD", "25_00000000");
        vm.expectRevert(bytes('MIN_BOUNTY_USD: not an unsigned integer: "25_00000000"'));
        script.run();
        vm.setEnv("MIN_BOUNTY_USD", "1000000000");

        vm.setEnv("MAX_PRICE_AGE", "2h");
        vm.expectRevert(bytes('MAX_PRICE_AGE: not an unsigned integer: "2h"'));
        script.run();
        vm.setEnv("MAX_PRICE_AGE", "3600");

        vm.setEnv("NEW_ADMIN", "0x70997970C51812dc3A010C7d01b50e0d17dc79C"); // one digit short
        vm.expectRevert(bytes('NEW_ADMIN: not an address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C"'));
        script.run();
        vm.setEnv("NEW_ADMIN", vm.toString(SAFE));

        vm.setEnv("ETH_USD_PRICE_FEED", "0x694AA1769357215DE4FAC081bf1f309aDC32530"); // one digit short
        vm.expectRevert(bytes('ETH_USD_PRICE_FEED: not an address: "0x694AA1769357215DE4FAC081bf1f309aDC32530"'));
        script.run();
        vm.setEnv("ETH_USD_PRICE_FEED", vm.toString(address(feed)));

        // A malformed key is refused without echoing it.
        vm.setEnv("PRIVATE_KEY", "nothex");
        vm.expectRevert(bytes("PRIVATE_KEY: expected 0x followed by 64 hex digits (value not shown)"));
        script.run();

        _clearEnv();
    }
}

/// @notice Parsing and deployment rules, driven through `parse` / `deploy` without
///         touching the process environment.
contract DeployScriptTest is Test {
    address internal constant SAFE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    // anvil dev account #0, local only
    string internal constant ANVIL_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    string internal constant PK_ERR = "PRIVATE_KEY: expected 0x followed by 64 hex digits (value not shown)";
    // anvil dev account #1, local only
    uint256 internal constant OTHER_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    Deploy internal script;
    MockPriceFeed internal feed;

    function setUp() public {
        script = new Deploy();
        feed = new MockPriceFeed(2000e8, 8);
    }

    function _env() internal pure returns (Deploy.Env memory e) {
        e = Deploy.Env({privateKey: "", priceFeed: "", minBountyUsd: "", maxPriceAge: "", newAdmin: ""});
    }

    function _config(uint256 minBountyUsd, address newAdmin) internal view returns (Deploy.Config memory c) {
        c = Deploy.Config({
            pk: 0,
            priceFeed: address(feed),
            minBountyUsd: minBountyUsd,
            minBountyUsdSet: true,
            maxPriceAge: 7200,
            newAdmin: newAdmin
        });
    }

    // ---------- parse ---------- //

    function test_Parse_EmptyMeansUnset() public view {
        Deploy.Config memory c = script.parse(_env());
        assertEq(c.pk, 0, "pk");
        assertEq(c.priceFeed, address(0), "feed");
        assertEq(c.minBountyUsd, 0, "minBountyUsd");
        assertFalse(c.minBountyUsdSet, "minBountyUsdSet");
        assertEq(c.maxPriceAge, 7200, "maxPriceAge default");
        assertEq(c.newAdmin, address(0), "newAdmin");
    }

    function test_Parse_UsesWellFormedValuesExactly() public view {
        Deploy.Env memory e = _env();
        e.privateKey = ANVIL_PK;
        e.priceFeed = "0x694aa1769357215de4fac081bf1f309adc325306"; // lowercase: no checksum to check
        e.minBountyUsd = "0";
        e.maxPriceAge = "3600";
        e.newAdmin = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // valid EIP-55
        Deploy.Config memory c = script.parse(e);
        assertEq(c.pk, 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80, "pk");
        assertEq(c.priceFeed, 0x694AA1769357215DE4FAC081bf1f309aDC325306, "feed");
        assertEq(c.minBountyUsd, 0, "explicit 0");
        assertTrue(c.minBountyUsdSet, "explicit 0 counts as set");
        assertEq(c.maxPriceAge, 3600, "maxPriceAge");
        assertEq(c.newAdmin, SAFE, "newAdmin");

        e.privateKey = "0xAC0974BEC39A17E36BA4A6B4D238FF944BACB478CBED5EFCAE784D7BF4F2FF80";
        assertEq(script.parse(e).pk, c.pk, "uppercase hex key");
    }

    function test_Parse_RevertsOnMalformedUnsignedIntegers() public {
        string[6] memory bad = ["25_00000000", "1000000000.0", "$10", " 1000000000", "abc", "-1"];
        for (uint256 i; i < bad.length; ++i) {
            Deploy.Env memory e = _env();
            e.minBountyUsd = bad[i];
            vm.expectRevert(bytes(string.concat('MIN_BOUNTY_USD: not an unsigned integer: "', bad[i], '"')));
            script.parse(e);
        }
        Deploy.Env memory e2 = _env();
        e2.maxPriceAge = "2h";
        vm.expectRevert(bytes('MAX_PRICE_AGE: not an unsigned integer: "2h"'));
        script.parse(e2);
    }

    function test_Parse_RevertsOnMalformedAddresses() public {
        string[4] memory bad = [
            "0x70997970C51812dc3A010C7d01b50e0d17dc79C", // 39 hex digits
            "0x70997970C51812dc3A010C7d01b50e0d17dc79C88", // 41 hex digits
            "0x0",
            "safe.eth"
        ];
        for (uint256 i; i < bad.length; ++i) {
            Deploy.Env memory e = _env();
            e.newAdmin = bad[i];
            vm.expectRevert(bytes(string.concat('NEW_ADMIN: not an address: "', bad[i], '"')));
            script.parse(e);
        }
        Deploy.Env memory e2 = _env();
        e2.priceFeed = "0x694AA1769357215DE4FAC081bf1f309aDC32530g";
        vm.expectRevert(bytes('ETH_USD_PRICE_FEED: not an address: "0x694AA1769357215DE4FAC081bf1f309aDC32530g"'));
        script.parse(e2);
    }

    function test_Parse_RevertsOnBadChecksum() public {
        // SAFE with one letter's case flipped (c instead of C): a typo EIP-55 catches.
        Deploy.Env memory e = _env();
        e.newAdmin = "0x70997970c51812dc3A010C7d01b50e0d17dc79C8";
        vm.expectRevert(bytes('NEW_ADMIN: bad EIP-55 checksum: "0x70997970c51812dc3A010C7d01b50e0d17dc79C8"'));
        script.parse(e);
    }

    function test_Parse_RevertsOnMalformedPrivateKeyWithoutEchoingIt() public {
        string[5] memory bad = [
            "nothex",
            "12345", // decimal
            "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // no 0x
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff8", // 63 digits
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ffg" // not hex
        ];
        for (uint256 i; i < bad.length; ++i) {
            Deploy.Env memory e = _env();
            e.privateKey = bad[i];
            vm.expectRevert(bytes(PK_ERR));
            script.parse(e);
        }
    }

    // ---------- deploy ---------- //

    function test_Deploy_MainnetRefusesPrivateKey() public {
        vm.chainId(1);
        Deploy.Config memory c = _config(1000000000, SAFE);
        c.pk = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
        vm.expectRevert(bytes("mainnet: use --account or --ledger, not PRIVATE_KEY"));
        script.deploy(c);
    }

    function test_Deploy_MainnetRequiresNewAdmin() public {
        vm.chainId(1);
        vm.expectRevert(bytes("mainnet: set NEW_ADMIN to a multisig"));
        script.deploy(_config(1000000000, address(0)));
    }

    function test_Deploy_MainnetRequiresExplicitMinBountyUsd() public {
        vm.chainId(1);
        Deploy.Config memory c = _config(0, SAFE);
        c.minBountyUsdSet = false;
        vm.expectRevert(bytes("mainnet: set MIN_BOUNTY_USD explicitly (0 disables the floor)"));
        script.deploy(c);
    }

    function test_Deploy_MainnetDeploysWithFloorAndPendingAdmin() public {
        vm.chainId(1);
        DeadManSwitch dms = script.deploy(_config(1000000000, SAFE));
        assertEq(address(dms.ethUsdPriceFeed()), address(feed), "feed");
        assertEq(dms.minBountyUsd(), 1000000000, "minBountyUsd");
        assertEq(dms.maxPriceAge(), 7200, "maxPriceAge");
        assertEq(dms.pendingAdmin(), SAFE, "pendingAdmin");
        assertGt(dms.minBounty(), 0, "floor live");
    }

    function test_Deploy_SepoliaHandsOverAdminAndKeepsConfig() public {
        vm.chainId(11155111);
        DeadManSwitch dms = script.deploy(_config(1000000000, SAFE));
        assertEq(dms.minBountyUsd(), 1000000000, "minBountyUsd");
        assertEq(dms.pendingAdmin(), SAFE, "pendingAdmin");
        assertTrue(dms.admin() != address(0), "admin is the deployer until acceptAdmin");
    }

    /// A forwarder at `sender`: calls through it reach `script.deploy` with msg.sender = `sender`, as forge
    /// script runs from --sender (or its default sender). vm.prank cannot be used: the script's
    /// vm.startBroadcast refuses an active prank.
    function _from(address sender) internal returns (DeployCaller) {
        vm.etch(sender, address(new DeployCaller()).code);
        return DeployCaller(sender);
    }

    // A PRIVATE_KEY that forge picked up (the environment or contracts/.env) while the run was meant to
    // sign with --account / --ledger and --sender, which makes msg.sender that sender.
    function test_Deploy_RefusesPrivateKeyThatIsNotTheChosenSender() public {
        Deploy.Config memory c = _config(1000000000, address(0));
        c.pk = OTHER_PK;
        address chosen = makeAddr("keystore signer");
        DeployCaller caller = _from(chosen);
        vm.expectRevert(
            bytes(
                string.concat(
                    "PRIVATE_KEY signs as ",
                    vm.toString(vm.addr(OTHER_PK)),
                    ", not as the chosen sender ",
                    vm.toString(chosen),
                    ": unset PRIVATE_KEY (environment or contracts/.env) to sign with --account / --ledger"
                )
            )
        );
        caller.deploy(script, c);
    }

    function test_Deploy_PrivateKeySignsWhenItIsTheSender() public {
        Deploy.Config memory c = _config(1000000000, address(0));
        c.pk = OTHER_PK;
        assertEq(_from(vm.addr(OTHER_PK)).deploy(script, c).admin(), vm.addr(OTHER_PK), "admin is the key's address");
    }

    function test_Deploy_PrivateKeySignsWhenNoSenderWasGiven() public {
        Deploy.Config memory c = _config(1000000000, address(0));
        c.pk = OTHER_PK;
        // forge script with PRIVATE_KEY and no --sender runs as forge's default sender
        assertEq(_from(DEFAULT_SENDER).deploy(script, c).admin(), vm.addr(OTHER_PK), "admin is the key's address");
    }

    function test_Deploy_FeedlessZeroesMaxPriceAge() public {
        Deploy.Config memory c = _config(0, address(0));
        c.priceFeed = address(0);
        DeadManSwitch dms = script.deploy(c);
        assertEq(address(dms.ethUsdPriceFeed()), address(0), "feed");
        assertEq(dms.maxPriceAge(), 0, "maxPriceAge");
        assertEq(dms.pendingAdmin(), address(0), "no hand-over");
    }
}

/// Forwards a deploy so that the script sees this contract's address as msg.sender.
contract DeployCaller {
    function deploy(Deploy script, Deploy.Config memory c) external returns (DeadManSwitch) {
        return script.deploy(c);
    }
}
