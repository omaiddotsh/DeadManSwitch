// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FhevmTest} from "forge-fhevm/FhevmTest.sol";
import {externalEuint256} from "encrypted-types/EncryptedTypes.sol";
import {DeadManSwitch} from "../../src/DeadManSwitch.sol";

/// @notice Chainlink-style ETH/USD feed. Answers are always "fresh" unless pinned.
contract MockPriceFeed {
    int256 public price;
    uint8 public immutable decimals;
    uint256 public pinnedUpdatedAt; // 0 = report block.timestamp

    constructor(int256 _price, uint8 _decimals) {
        price = _price;
        decimals = _decimals;
    }

    function setPrice(int256 _price) external {
        price = _price;
    }

    function setUpdatedAt(uint256 t) external {
        pinnedUpdatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 updatedAt = pinnedUpdatedAt == 0 ? block.timestamp : pinnedUpdatedAt;
        return (1, price, updatedAt, updatedAt, 1);
    }
}

/// @notice Rejects ETH — used to prove a non-receiving caller only griefs itself.
contract NonReceiver {
    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

/**
 * @notice Shared fixture for every DeadManSwitch test file.
 *
 * Two forge-fhevm rules every test must follow (learned the hard way in the
 * Phase 0 spike):
 *   1. The mock KMS builds its plaintext database from *recorded logs*. Never
 *      call `vm.getRecordedLogs()` / `vm.recordLogs()` yourself before a
 *      `publicDecrypt`, or the encryption logs are consumed and decrypt returns 0.
 *      Use `vm.expectEmit` to assert events.
 *   2. Never call `publicDecrypt` inside an external frame that reverts
 *      (e.g. under `vm.expectRevert`): the logs it consumes are not restored.
 *      To assert "not yet decryptable", call `isPubliclyDecryptable(handle)`.
 */
abstract contract DMSTestBase is FhevmTest {
    DeadManSwitch internal dms;
    MockPriceFeed internal feed;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal eve = makeAddr("eve");

    uint256 internal constant ID = 1;
    uint64 internal constant INTERVAL = 1 days;
    uint256 internal constant BOUNTY = 0.05 ether;
    // $2,000.00000000 ETH/USD with 8 decimals; $10 floor => 0.005 ETH
    int256 internal constant ETH_USD = 2000e8;
    uint256 internal constant MIN_USD = 10e8;
    uint256 internal constant MAX_PRICE_AGE = 7200;

    bytes internal constant PLAINTEXT = bytes("the secret payload");
    bytes32 internal constant SALT = bytes32(uint256(0xC0FFEE));

    /// @dev DEK used by `_create` for a given (owner, id). Distinct per switch.
    function _dekFor(address owner, uint256 id) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("dek", owner, id)));
    }

    function _commitment(bytes32 salt, bytes memory plaintext) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(salt, plaintext));
    }

    /// @dev Opaque ciphertext of the right shape. The contract never parses it.
    function _ciphertext(uint256 plaintextLen) internal pure returns (bytes memory c) {
        c = new bytes(plaintextLen + 61);
        c[0] = 0x01;
        for (uint256 i = 1; i < c.length; i++) {
            c[i] = bytes1(uint8(uint256(keccak256(abi.encode(i))) & 0xff));
        }
    }

    function setUp() public virtual override {
        super.setUp();
        feed = new MockPriceFeed(ETH_USD, 8);
        dms = new DeadManSwitch(address(feed), MIN_USD, MAX_PRICE_AGE);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(eve, 100 ether);
    }

    /// @dev Encrypt `dek` for `owner` → this contract, ready for createSwitch.
    function _encKey(address owner, uint256 dek) internal returns (externalEuint256 h, bytes memory proof) {
        return encryptUint256(dek, owner, address(dms));
    }

    function _params(uint256 id, uint64 interval, bytes32 commitment)
        internal
        pure
        returns (DeadManSwitch.CreateParams memory)
    {
        return DeadManSwitch.CreateParams({id: id, pingInterval: interval, plaintextCommitment: commitment});
    }

    /// @dev Full-control create. Uses `_dekFor(owner, id)` as the DEK.
    function _create(address owner, uint256 id, uint64 interval, uint256 bounty, bytes32 commitment, bytes memory ct)
        internal
        returns (bytes32 key)
    {
        (externalEuint256 h, bytes memory proof) = _encKey(owner, _dekFor(owner, id));
        vm.prank(owner);
        key = dms.createSwitch{value: bounty}(_params(id, interval, commitment), ct, h, proof);
    }

    /// @dev Default create: alice/ID/INTERVAL/BOUNTY with the default plaintext commitment.
    function _create() internal returns (bytes32) {
        return _create(alice, ID, INTERVAL, BOUNTY, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));
    }

    function _create(address owner, uint256 id) internal returns (bytes32) {
        return _create(owner, id, INTERVAL, BOUNTY, _commitment(SALT, PLAINTEXT), _ciphertext(PLAINTEXT.length));
    }

    /// @dev Warp to exactly the deadline of (owner, id).
    function _warpToDark(address owner, uint256 id) internal {
        vm.warp(dms.expirationTime(owner, id));
    }

    function _darkAndMark(address owner, uint256 id) internal {
        _warpToDark(owner, id);
        dms.markDark(owner, id);
    }

    /// @dev Public-decrypt the switch's DEK via the mock KMS. Requires markDark first.
    function _kmsDecrypt(address owner, uint256 id) internal returns (bytes32 dataKey, bytes memory proof) {
        bytes32[] memory hs = new bytes32[](1);
        hs[0] = dms.getEncKeyHandle(owner, id);
        (uint256[] memory clear, bytes memory p) = publicDecrypt(hs);
        return (bytes32(clear[0]), p);
    }

    /// @dev markDark (if needed) → KMS decrypt → revealKey as `revealer`. Returns the DEK.
    function _reveal(address owner, uint256 id, address revealer) internal returns (bytes32 dataKey) {
        if (dms.getState(owner, id) == DeadManSwitch.State.ALIVE) _warpToDark(owner, id);
        if (dms.getState(owner, id) == DeadManSwitch.State.DARK) dms.markDark(owner, id);
        bytes memory proof;
        (dataKey, proof) = _kmsDecrypt(owner, id);
        vm.prank(revealer);
        dms.revealKey(owner, id, dataKey, proof);
    }

    /// @dev The ACL's view of whether a handle is publicly decryptable.
    function _isPubliclyDecryptable(bytes32 handle) internal view returns (bool) {
        return _acl.isAllowedForDecryption(handle);
    }
}
