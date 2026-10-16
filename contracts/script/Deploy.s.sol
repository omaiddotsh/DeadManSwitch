// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DeadManSwitch} from "../src/DeadManSwitch.sol";

/**
 * @notice Deploys the DeadManSwitch contract. One deploy per chain; every switch
 *         lives in its mapping. Supported chains are those `ZamaEthereumConfig`
 *         knows: Ethereum mainnet (1), Sepolia (11155111) and a local Anvil
 *         node running the forge-fhevm host stack (31337). Any other chain id
 *         reverts in the constructor with `ZamaProtocolUnsupported`.
 *
 *         Signer: pass `--account <keystore>` or `--ledger` (plus `--sender <addr>`)
 *         to forge script. On chain 1 the script refuses the PRIVATE_KEY env var
 *         and requires NEW_ADMIN and an explicit MIN_BOUNTY_USD. It cannot see
 *         signer flags such as --private-key or --mnemonics passed on the command
 *         line: never use those for mainnet.
 *
 *         Environment. An empty variable counts as unset. Any other value must
 *         parse, or the script reverts before anything is broadcast; a malformed
 *         value never falls back to the default.
 *           PRIVATE_KEY          optional raw key, 0x + 64 hex digits (local / Sepolia rehearsal only).
 *                                forge also reads it from contracts/.env. When a --sender is given
 *                                (or one --account / --ledger), the key must be that sender's, or
 *                                the run stops: a stray key never signs in place of the keystore.
 *           ETH_USD_PRICE_FEED   Chainlink ETH/USD feed; unset disables the bounty floor
 *           MIN_BOUNTY_USD       minimum bounty, USD with 8 decimals, digits only (1000000000 = $10);
 *                                0 disables. Default 0; required on mainnet.
 *           MAX_PRICE_AGE        max feed answer age in seconds (default 7200)
 *           NEW_ADMIN            starts a two-step admin transfer to this address
 *                                (required on mainnet: point it at a multisig)
 *         Addresses written in mixed case must carry a valid EIP-55 checksum.
 *
 *         Chainlink ETH/USD feeds:
 *           Ethereum mainnet  0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419
 *           Sepolia           0x694AA1769357215DE4FAC081bf1f309aDC325306
 */
contract Deploy is Script {
    uint256 internal constant DEFAULT_MAX_PRICE_AGE = 7200;

    /// @notice The raw environment strings ("" = unset).
    struct Env {
        string privateKey;
        string priceFeed;
        string minBountyUsd;
        string maxPriceAge;
        string newAdmin;
    }

    struct Config {
        uint256 pk;
        address priceFeed;
        uint256 minBountyUsd;
        bool minBountyUsdSet;
        uint256 maxPriceAge;
        address newAdmin;
    }

    function run() external returns (DeadManSwitch) {
        return deploy(parse(readEnv()));
    }

    function readEnv() public view returns (Env memory e) {
        e.privateKey = vm.envOr("PRIVATE_KEY", string(""));
        e.priceFeed = vm.envOr("ETH_USD_PRICE_FEED", string(""));
        e.minBountyUsd = vm.envOr("MIN_BOUNTY_USD", string(""));
        e.maxPriceAge = vm.envOr("MAX_PRICE_AGE", string(""));
        e.newAdmin = vm.envOr("NEW_ADMIN", string(""));
    }

    function parse(Env memory e) public pure returns (Config memory c) {
        c.pk = _parsePrivateKey(e.privateKey);
        c.priceFeed = _parseAddress("ETH_USD_PRICE_FEED", e.priceFeed);
        (c.minBountyUsd, c.minBountyUsdSet) = _parseUint("MIN_BOUNTY_USD", e.minBountyUsd, 0);
        (c.maxPriceAge,) = _parseUint("MAX_PRICE_AGE", e.maxPriceAge, DEFAULT_MAX_PRICE_AGE);
        c.newAdmin = _parseAddress("NEW_ADMIN", e.newAdmin);
    }

    function deploy(Config memory c) public returns (DeadManSwitch dms) {
        if (block.chainid == 1) {
            require(c.pk == 0, "mainnet: use --account or --ledger, not PRIVATE_KEY");
            require(c.newAdmin != address(0), "mainnet: set NEW_ADMIN to a multisig");
            require(c.minBountyUsdSet, "mainnet: set MIN_BOUNTY_USD explicitly (0 disables the floor)");
        }
        // forge reads PRIVATE_KEY from contracts/.env as well as the environment, where a key meant for
        // something else can sit. Used here, it would sign instead of the --account / --ledger signer and
        // become admin. msg.sender is the --sender (or the one wallet given); it is forge's default sender
        // only when none was given, as in a run with PRIVATE_KEY alone.
        if (c.pk != 0 && msg.sender != DEFAULT_SENDER) {
            address keyAddr = vm.addr(c.pk);
            require(
                keyAddr == msg.sender,
                string.concat(
                    "PRIVATE_KEY signs as ",
                    vm.toString(keyAddr),
                    ", not as the chosen sender ",
                    vm.toString(msg.sender),
                    ": unset PRIVATE_KEY (environment or contracts/.env) to sign with --account / --ledger"
                )
            );
        }
        uint256 maxPriceAge = c.priceFeed == address(0) ? 0 : c.maxPriceAge;

        if (c.pk != 0) vm.startBroadcast(c.pk);
        else vm.startBroadcast();
        dms = new DeadManSwitch(c.priceFeed, c.minBountyUsd, maxPriceAge);
        if (c.newAdmin != address(0)) dms.transferAdmin(c.newAdmin);
        vm.stopBroadcast();

        // The deployed contract must hold exactly what was asked for.
        require(address(dms.ethUsdPriceFeed()) == c.priceFeed, "post-deploy: ethUsdPriceFeed mismatch");
        require(dms.minBountyUsd() == c.minBountyUsd, "post-deploy: minBountyUsd mismatch");
        require(dms.maxPriceAge() == maxPriceAge, "post-deploy: maxPriceAge mismatch");
        require(dms.pendingAdmin() == c.newAdmin, "post-deploy: pendingAdmin mismatch");
        require(dms.admin() != address(0), "post-deploy: no admin");

        console2.log("DeadManSwitch deployed at:", address(dms));
        console2.log("  chainId:            ", block.chainid);
        console2.log("  ETH_USD_PRICE_FEED: ", c.priceFeed);
        console2.log("  minBountyUsd:       ", dms.minBountyUsd());
        console2.log("  maxPriceAge:        ", dms.maxPriceAge());
        console2.log("  admin:              ", dms.admin());
        console2.log("  pendingAdmin:       ", dms.pendingAdmin());
    }

    // ---------- Strict parsing ---------- //

    function _parseUint(string memory key, string memory raw, uint256 dflt)
        internal
        pure
        returns (uint256 value, bool set)
    {
        if (bytes(raw).length == 0) return (dflt, false);
        try vm.parseUint(raw) returns (uint256 v) {
            return (v, true);
        } catch {
            revert(string.concat(key, ': not an unsigned integer: "', raw, '"'));
        }
    }

    function _parseAddress(string memory key, string memory raw) internal pure returns (address a) {
        if (bytes(raw).length == 0) return address(0);
        try vm.parseAddress(raw) returns (address v) {
            a = v;
        } catch {
            revert(string.concat(key, ': not an address: "', raw, '"'));
        }
        // All-lowercase or all-uppercase hex carries no checksum; mixed case must be EIP-55.
        if (_hasMixedCase(raw)) {
            require(
                keccak256(bytes(vm.toString(a))) == keccak256(bytes(raw)),
                string.concat(key, ': bad EIP-55 checksum: "', raw, '"')
            );
        }
    }

    /// @dev Never puts the value in a revert reason or a cheatcode argument (forge prints
    ///      those in its failure trace; env reads it redacts): a near-miss is still most
    ///      of a key. So the hex is decoded here rather than with vm.parseUint.
    function _parsePrivateKey(string memory raw) internal pure returns (uint256 pk) {
        bytes memory b = bytes(raw);
        if (b.length == 0) return 0;
        string memory err = "PRIVATE_KEY: expected 0x followed by 64 hex digits (value not shown)";
        require(b.length == 66 && b[0] == "0" && b[1] == "x", err);
        for (uint256 i = 2; i < 66; ++i) {
            uint8 c = uint8(b[i]);
            uint256 digit;
            if (c >= 0x30 && c <= 0x39) digit = c - 0x30; // '0'-'9'
            else if (c >= 0x61 && c <= 0x66) digit = c - 0x61 + 10; // 'a'-'f'
            else if (c >= 0x41 && c <= 0x46) digit = c - 0x41 + 10; // 'A'-'F'
            else revert(err);
            pk = (pk << 4) | digit;
        }
    }

    function _hasMixedCase(string memory raw) internal pure returns (bool) {
        bytes memory b = bytes(raw);
        bool upper;
        bool lower;
        // Skip a leading "0x": its 'x' is not a hex digit.
        uint256 start = b.length >= 2 && b[0] == "0" && (b[1] == "x" || b[1] == "X") ? 2 : 0;
        for (uint256 i = start; i < b.length; ++i) {
            if (b[i] >= "A" && b[i] <= "F") upper = true;
            else if (b[i] >= "a" && b[i] <= "f") lower = true;
        }
        return upper && lower;
    }
}
