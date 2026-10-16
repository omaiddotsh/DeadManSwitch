// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FHE, euint256, externalEuint256} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/**
 * @title DeadManSwitch
 * @notice Ping-extendable dead-man switch on Zama fhEVM. PUBLIC RELEASE ONLY.
 *
 *         A secret is AES-256-GCM encrypted in the owner's browser under a fresh
 *         32-byte data key (DEK). The ciphertext is stored here; the DEK is stored
 *         here too, but as an FHE ciphertext (`euint256`) that only Zama's
 *         threshold KMS can decrypt — and only after this contract asks it to.
 *
 *         This contract is the condition evaluator. "Has the owner gone dark?" is
 *         answered by Ethereum consensus (`block.timestamp` vs `lastPing`), not by
 *         any off-chain node reading an RPC:
 *
 *           1. createSwitch  — store ciphertext + encrypted DEK, escrow the bounty.
 *           2. ping          — owner proves they are alive; extends the deadline.
 *           3. markDark      — anyone, once the deadline has passed: the contract
 *                              calls FHE.makePubliclyDecryptable(DEK). Irreversible.
 *           4. revealKey     — anyone: submits the DEK plus the KMS threshold
 *                              signatures. The contract verifies them, records the
 *                              DEK on-chain and pays the whole bounty.
 *           5. publishPlaintext — optional, anyone: posts the plaintext, checked
 *                              against the commitment made at creation.
 *
 *         After step 4 the secret is public forever from on-chain state alone:
 *         `getCiphertext` + `getRevealedKey` → AES-GCM decrypt.
 *
 *         A cancelled switch is never marked dark, so its DEK is never decryptable.
 *
 *         Trust: confidentiality before `markDark` rests on Zama's KMS threshold
 *         (and FHE). Liveness and reveal integrity also rest on Zama's host
 *         governance: the ACL owner/pausers can pause or deny-list this contract
 *         (markDark then reverts; depositors recover funds via the rescue path),
 *         and the ACL owner can change the KMS signer set that `checkSignatures`
 *         trusts. Clients should verify a revealed DEK against the ciphertext's
 *         AES-GCM tag. See ARCHITECTURE.md and docs/fhevm-api-pins.md.
 */
contract DeadManSwitch is ZamaEthereumConfig {
    // ---------- Constants ---------- //

    uint256 public constant MIN_PING_INTERVAL = 60;
    uint256 public constant MAX_PING_INTERVAL = 365 days;

    /// @notice Maximum plaintext size in bytes (the secret, excluding salt).
    uint256 public constant MAX_PAYLOAD_SIZE = 2048;

    /// @notice Fixed ciphertext overhead: version (1) + nonce (12) + salt (32) + GCM tag (16).
    ///         Ciphertext layout: version ‖ nonce ‖ AES-256-GCM(DEK, nonce, salt ‖ plaintext) ‖ tag.
    uint256 public constant CIPHERTEXT_OVERHEAD = 61;
    uint256 public constant MAX_CIPHERTEXT_SIZE = MAX_PAYLOAD_SIZE + CIPHERTEXT_OVERHEAD;

    /**
     * @notice How long after going dark a still-unrevealed switch's depositors may
     *         recover their own principal. With the KMS working, a reveal lands
     *         minutes after `markDark`; reaching this delay means the key was never
     *         served. It must dwarf any honest reveal latency so the rescue can never
     *         outrun a legitimate revealer. The switch stays ACTIVE, so a late
     *         `revealKey` still lands and collects whatever remains.
     */
    uint256 public constant RESCUE_DELAY = 30 days;

    /// @notice Upper bound on the admin-settable minimum bounty ($10,000, 8 decimals).
    uint256 public constant MAX_MIN_BOUNTY_USD = 10_000e8;

    /// @dev Transient-storage slot for the reentrancy lock.
    ///      keccak256("deadmanswitch.reentrancy.lock") - 1
    uint256 private constant _LOCK_SLOT = 0xd0915afcee584ee0dbaeedcf52195d0c2933522c7170793ddbfb7a67d7921018;

    /// @dev Gas forwarded to the price feed: ~10x a cold Chainlink proxy read. A feed that
    ///      fails by consuming all its gas must not starve the rest of `createSwitch`.
    uint256 private constant _ORACLE_GAS = 200_000;

    // ---------- Immutables / config ---------- //

    /// @notice Chainlink ETH/USD feed used to price `minBounty`. Zero disables the floor.
    AggregatorV3Interface public immutable ethUsdPriceFeed;
    /// @notice Maximum accepted age of a price-feed answer.
    uint256 public immutable maxPriceAge;
    /// @dev 10 ** (10 + feed decimals): converts USD (8 dp) / price (feed dp) to wei.
    uint256 private immutable _priceScale;

    /// @notice Minimum bounty in USD with 8 decimals. Zero disables the floor.
    uint256 public minBountyUsd;
    /// @notice May update `minBountyUsd`. Renounceable; two-step transfer.
    address public admin;
    address public pendingAdmin;

    // ---------- Storage ---------- //

    /**
     * @notice Terminal states are distinct. CANCELLED must not read as REVEALED:
     *         funder contributions are reclaimable only after a cancel, and
     *         conflating the two would either strand that ETH or pay it twice.
     */
    enum Status {
        ACTIVE,
        CANCELLED,
        REVEALED
    }

    /// @notice Derived lifecycle state, for UIs and indexers.
    enum State {
        NONE,
        ALIVE,
        DARK,
        DARK_MARKED,
        REVEALED,
        CANCELLED
    }

    struct Switch {
        // slot 0: 20 + 5 + 4 + 1 + 1 + 1 = 32 bytes — everything ping, fundBounty,
        // cancel, publishPlaintext and the rescue checks read, so they touch one slot.
        // A uint40 timestamp lasts until year 36,812; pingInterval ≤ MAX_PING_INTERVAL.
        address owner;
        uint40 lastPing;
        uint32 pingInterval;
        Status status;
        bool darkMarked;
        bool published;
        // slot 1: 3 × 8 = 24 bytes
        uint64 createdAt;
        uint64 darkMarkedAt;
        uint64 revealedAt;
        // own slots
        uint256 bounty;
        bytes32 plaintextCommitment;
        euint256 encKey;
        bytes32 revealedKey;
        bytes ciphertext;
    }

    mapping(bytes32 => Switch) private switches;

    // Per-depositor accounting for the shared bounty pot.
    //
    // INVARIANT (while ACTIVE or CANCELLED): s.bounty == ownerStake[key] + Σ funderStake[key][*]
    //
    // This contract holds every switch's ETH in one balance, so `cancel` MUST
    // refund only what the owner escrowed. Refunding the whole pot would let an
    // owner advertise a switch, accept funding meant to incentivise revelation,
    // and withdraw it.
    mapping(bytes32 => uint256) private ownerStake;
    mapping(bytes32 => mapping(address => uint256)) private funderStake;

    /// @notice FHE handles already bound to a switch. One encrypted DEK can back
    ///         at most one switch: if two switches shared a handle, marking either
    ///         dark would make the other's key public while its owner is alive.
    mapping(bytes32 => bool) public keyHandleUsed;

    // ---------- Events ---------- //

    event SwitchCreated(
        bytes32 indexed switchKey,
        address indexed owner,
        uint256 indexed switchId,
        uint64 pingInterval,
        uint64 timestamp,
        uint256 bounty,
        bytes32 plaintextCommitment,
        bytes32 encKeyHandle,
        bytes ciphertext
    );
    event Pinged(bytes32 indexed switchKey, uint64 lastPing, uint64 expiresAt);
    event BountyFunded(bytes32 indexed switchKey, address indexed funder, uint256 amount, uint256 newTotal);
    event SwitchCancelled(bytes32 indexed switchKey, address indexed owner, uint256 refund, uint64 timestamp);
    event ContributionReclaimed(bytes32 indexed switchKey, address indexed funder, uint256 amount);
    event OwnerStakeReclaimed(bytes32 indexed switchKey, address indexed owner, uint256 amount);
    event SwitchDarkMarked(bytes32 indexed switchKey, address indexed caller, bytes32 encKeyHandle, uint64 timestamp);
    event KeyRevealed(
        bytes32 indexed switchKey, address indexed revealer, bytes32 dataKey, uint256 bountyPaid, uint64 timestamp
    );
    event PlaintextPublished(bytes32 indexed switchKey, address indexed publisher, bytes payload);
    event MinBountyUsdUpdated(uint256 oldValue, uint256 newValue);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ---------- Errors ---------- //

    error InvalidSwitchId();
    error AlreadyExists();
    error DoesNotExist();
    error InvalidInterval();
    error CiphertextTooSmall();
    error CiphertextTooLarge();
    error PayloadTooLarge();
    error EmptyCommitment();
    error EmptyInputProof();
    error KeyHandleReused();
    error BountyTooLow();
    error ZeroValue();
    error Unauthorized();
    error NotActive();
    error Expired();
    error NotDark();
    error AlreadyDarkMarked();
    error NotDarkMarked();
    error AlreadyRevealed();
    error NotRevealed();
    error AlreadyPublished();
    error CommitmentMismatch();
    error NotRescuable();
    error NothingToReclaim();
    error TransferFailed();
    error InvalidConfig();
    error MinBountyUsdTooHigh();
    error Reentrancy();

    // ---------- Constructor ---------- //

    /**
     * @param _ethUsdPriceFeed Chainlink ETH/USD feed; zero only when `_minBountyUsd` is zero.
     * @param _minBountyUsd    Minimum bounty in USD with 8 decimals (e.g. $10 = 10e8); zero disables.
     * @param _maxPriceAge     Maximum age of a feed answer in seconds (e.g. 7200 for a 3600 s heartbeat).
     */
    constructor(address _ethUsdPriceFeed, uint256 _minBountyUsd, uint256 _maxPriceAge) {
        if (_minBountyUsd > MAX_MIN_BOUNTY_USD) revert MinBountyUsdTooHigh();
        uint256 scale;
        if (_ethUsdPriceFeed == address(0)) {
            if (_minBountyUsd != 0) revert InvalidConfig();
        } else {
            if (_maxPriceAge == 0) revert InvalidConfig();
            uint8 dec = AggregatorV3Interface(_ethUsdPriceFeed).decimals();
            if (dec > 36) revert InvalidConfig();
            scale = 10 ** (10 + uint256(dec));
        }
        ethUsdPriceFeed = AggregatorV3Interface(_ethUsdPriceFeed);
        maxPriceAge = _maxPriceAge;
        _priceScale = scale;
        minBountyUsd = _minBountyUsd;
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    // ---------- Modifiers ---------- //

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    /// @dev Transient-storage reentrancy lock (EIP-1153).
    modifier nonReentrant() {
        bool locked;
        assembly ("memory-safe") {
            locked := tload(_LOCK_SLOT)
        }
        if (locked) revert Reentrancy();
        assembly ("memory-safe") {
            tstore(_LOCK_SLOT, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(_LOCK_SLOT, 0)
        }
    }

    // ---------- Admin ---------- //

    /// @notice Update the minimum bounty (USD, 8 decimals). Applies to new switches only.
    function setMinBountyUsd(uint256 _minBountyUsd) external onlyAdmin {
        if (_minBountyUsd > MAX_MIN_BOUNTY_USD) revert MinBountyUsdTooHigh();
        if (_minBountyUsd != 0 && address(ethUsdPriceFeed) == address(0)) revert InvalidConfig();
        emit MinBountyUsdUpdated(minBountyUsd, _minBountyUsd);
        minBountyUsd = _minBountyUsd;
    }

    /// @notice Start a two-step admin transfer. `address(0)` cancels a pending transfer.
    function transferAdmin(address newAdmin) external onlyAdmin {
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(msg.sender, newAdmin);
    }

    /// @notice Complete a two-step admin transfer.
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin || msg.sender == address(0)) revert Unauthorized();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// @notice Renounce the admin role. `minBountyUsd` is then fixed forever.
    function renounceAdmin() external onlyAdmin {
        emit AdminTransferred(msg.sender, address(0));
        admin = address(0);
        pendingAdmin = address(0);
    }

    /**
     * @notice Current minimum bounty in wei. Zero when the floor is disabled.
     *
     *         Fails OPEN: if the feed reverts, runs out of gas, has no code, returns
     *         a non-positive answer, or is older than `maxPriceAge`, the floor is
     *         zero rather than a revert. The floor is a guard against switches whose
     *         bounty cannot pay for a reveal, not a safety property; an immutable
     *         feed that is later deprecated must never be able to brick `createSwitch`
     *         (which would be permanent after `renounceAdmin`). Only `createSwitch`
     *         reads this; existing switches never depend on the oracle.
     */
    function minBounty() public view returns (uint256) {
        uint256 usd = minBountyUsd;
        if (usd == 0) return 0;
        (bool ok, uint256 price) = oraclePrice();
        if (!ok) return 0;
        return (usd * _priceScale) / price;
    }

    /**
     * @notice The ETH/USD answer `minBounty` would use, and whether it is usable
     *         (call succeeded, positive, not in the future, within `maxPriceAge`).
     *         Lets frontends tell "floor disabled" from "oracle down".
     */
    function oraclePrice() public view returns (bool ok, uint256 price) {
        address feed = address(ethUsdPriceFeed);
        if (feed == address(0)) return (false, 0);
        // Low-level call: a high-level call would revert on a code-less feed or a
        // short return payload, which try/catch cannot intercept. Capped gas: an
        // uncapped read that burns its gas leaves 1/64 for the caller, and no
        // transaction under the EIP-7825 cap (2^24 gas) could then finish a create.
        (bool success, bytes memory ret) =
            feed.staticcall{gas: _ORACLE_GAS}(abi.encodeCall(AggregatorV3Interface.latestRoundData, ()));
        if (!success || ret.length < 160) return (false, 0);
        // Decode as full-width words so out-of-range uint80 fields cannot revert.
        (, int256 answer,, uint256 updatedAt,) = abi.decode(ret, (uint256, int256, uint256, uint256, uint256));
        if (answer <= 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxPriceAge) return (false, 0);
        // casting to 'uint256' is safe because answer > 0 was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return (true, uint256(answer));
    }

    // ---------- Create ---------- //

    struct CreateParams {
        uint256 id;
        uint64 pingInterval;
        bytes32 plaintextCommitment; // keccak256(salt ‖ plaintext)
    }

    /**
     * @notice Create a switch. `msg.value` is the owner's bounty escrow.
     * @param p           id (non-zero, unique per owner), ping interval, plaintext commitment.
     * @param ciphertext  version ‖ nonce ‖ AES-256-GCM(DEK, salt ‖ plaintext) ‖ tag.
     * @param encKey      The DEK encrypted for this contract with the Zama relayer SDK.
     * @param inputProof  The input proof for `encKey`; binds it to (msg.sender, this contract).
     */
    function createSwitch(
        CreateParams calldata p,
        bytes calldata ciphertext,
        externalEuint256 encKey,
        bytes calldata inputProof
    ) external payable returns (bytes32 key) {
        if (p.id == 0) revert InvalidSwitchId();
        if (p.pingInterval < MIN_PING_INTERVAL || p.pingInterval > MAX_PING_INTERVAL) revert InvalidInterval();
        if (ciphertext.length < CIPHERTEXT_OVERHEAD) revert CiphertextTooSmall();
        if (ciphertext.length > MAX_CIPHERTEXT_SIZE) revert CiphertextTooLarge();
        if (p.plaintextCommitment == bytes32(0)) revert EmptyCommitment();
        // An empty proof would take fromExternal's "already-allowed handle" path,
        // which maps the zero handle to a public trivial encryption of 0.
        if (inputProof.length == 0) revert EmptyInputProof();
        if (msg.value < minBounty()) revert BountyTooLow();

        key = _key(msg.sender, p.id);
        Switch storage s = switches[key];
        if (s.owner != address(0)) revert AlreadyExists();

        euint256 k = FHE.fromExternal(encKey, inputProof);
        bytes32 handle = euint256.unwrap(k);
        if (keyHandleUsed[handle]) revert KeyHandleReused();
        keyHandleUsed[handle] = true;
        FHE.allowThis(k);

        uint64 nowTs = uint64(block.timestamp);
        s.owner = msg.sender;
        s.lastPing = uint40(block.timestamp);
        s.status = Status.ACTIVE;
        s.pingInterval = uint32(p.pingInterval); // ≤ MAX_PING_INTERVAL, checked above
        s.createdAt = nowTs;
        s.bounty = msg.value;
        s.plaintextCommitment = p.plaintextCommitment;
        s.encKey = k;
        s.ciphertext = ciphertext;
        ownerStake[key] = msg.value;

        emit SwitchCreated(
            key, msg.sender, p.id, p.pingInterval, nowTs, msg.value, p.plaintextCommitment, handle, ciphertext
        );
    }

    // ---------- Ping ---------- //

    /// @notice Prove you are alive. Owner only; reverts once the switch is dark.
    function ping(uint256 id) external {
        bytes32 key = _key(msg.sender, id);
        Switch storage s = switches[key];
        if (s.owner == address(0)) revert DoesNotExist();
        if (s.status != Status.ACTIVE) revert NotActive();
        if (_isDark(s)) revert Expired();

        uint64 nowTs = uint64(block.timestamp);
        s.lastPing = uint40(block.timestamp);
        emit Pinged(key, nowTs, nowTs + s.pingInterval);
    }

    // ---------- Bounty ---------- //

    /**
     * @notice Anyone can top up the bounty of a live switch. The contribution is
     *         tracked per funder: it is not refunded to the owner by `cancel`, and
     *         the funder can reclaim it after a cancel or on a stuck switch.
     */
    function fundBounty(address owner, uint256 id) external payable {
        if (msg.value == 0) revert ZeroValue();
        bytes32 key = _key(owner, id);
        Switch storage s = switches[key];
        if (s.owner == address(0)) revert DoesNotExist();
        if (s.status != Status.ACTIVE) revert NotActive();
        if (_isDark(s)) revert Expired();
        funderStake[key][msg.sender] += msg.value;
        s.bounty += msg.value;
        emit BountyFunded(key, msg.sender, msg.value, s.bounty);
    }

    /**
     * @notice Owner-only escape hatch while ALIVE: disables the switch forever and
     *         refunds the owner's own escrow. The DEK is never made decryptable, so
     *         the secret stays sealed. Funders reclaim via `reclaimContribution`.
     */
    function cancel(uint256 id) external nonReentrant {
        bytes32 key = _key(msg.sender, id);
        Switch storage s = switches[key];
        if (s.owner == address(0)) revert DoesNotExist();
        if (s.status != Status.ACTIVE) revert NotActive();
        if (_isDark(s)) revert Expired();

        s.status = Status.CANCELLED;
        uint256 refund = ownerStake[key];
        ownerStake[key] = 0;
        s.bounty -= refund;
        emit SwitchCancelled(key, msg.sender, refund, uint64(block.timestamp));
        _send(msg.sender, refund);
    }

    /**
     * @notice Reclaim your own `fundBounty` contribution after the owner cancelled,
     *         or on a switch stuck for `RESCUE_DELAY` past going dark. On a reveal the
     *         whole pot goes to the revealer, which is what funders paid for, so a
     *         revealed switch reverts `AlreadyRevealed`; an ACTIVE switch that is not
     *         yet rescuable reverts `NotRescuable`.
     */
    function reclaimContribution(address owner, uint256 id) external nonReentrant {
        bytes32 key = _key(owner, id);
        Switch storage s = switches[key];
        if (s.owner == address(0)) revert DoesNotExist();
        if (s.status == Status.REVEALED) revert AlreadyRevealed();
        if (s.status == Status.ACTIVE && !_rescuable(s)) revert NotRescuable();
        uint256 amt = funderStake[key][msg.sender];
        if (amt == 0) revert NothingToReclaim();
        funderStake[key][msg.sender] = 0;
        s.bounty -= amt;
        emit ContributionReclaimed(key, msg.sender, amt);
        _send(msg.sender, amt);
    }

    /**
     * @notice Owner-side rescue: recover your own escrow from a switch stuck for
     *         `RESCUE_DELAY` past going dark. Deliberately not folded into `cancel`:
     *         the switch stays ACTIVE so a late `revealKey` still lands, and a
     *         post-dark cancel would give whoever holds the owner's key a way to
     *         front-run a pending reveal.
     */
    function reclaimOwnerStake(uint256 id) external nonReentrant {
        bytes32 key = _key(msg.sender, id);
        Switch storage s = switches[key];
        if (s.owner == address(0)) revert DoesNotExist();
        if (!_rescuable(s)) revert NotRescuable();
        uint256 amt = ownerStake[key];
        if (amt == 0) revert NothingToReclaim();
        ownerStake[key] = 0;
        s.bounty -= amt;
        emit OwnerStakeReclaimed(key, msg.sender, amt);
        _send(msg.sender, amt);
    }

    // ---------- Release ---------- //

    /**
     * @notice Ask the Zama KMS to make this switch's DEK publicly decryptable.
     *         Callable by anyone once the owner has missed their deadline.
     *         Irreversible by design: `ping` already reverts once dark, so there is
     *         no state in which this is premature.
     */
    function markDark(address owner, uint256 id) external {
        bytes32 key = _key(owner, id);
        Switch storage s = switches[key];
        if (s.owner == address(0)) revert DoesNotExist();
        if (s.status != Status.ACTIVE) revert NotActive();
        if (!_isDark(s)) revert NotDark();
        if (s.darkMarked) revert AlreadyDarkMarked();

        s.darkMarked = true;
        s.darkMarkedAt = uint64(block.timestamp);
        FHE.makePubliclyDecryptable(s.encKey);
        emit SwitchDarkMarked(key, msg.sender, euint256.unwrap(s.encKey), uint64(block.timestamp));
    }

    /**
     * @notice Publish the DEK and claim the bounty.
     * @param dataKey          The decrypted DEK (the KMS cleartext, as bytes32).
     * @param decryptionProof  The KMS public-decryption proof for this switch's DEK handle.
     * @dev    `FHE.checkSignatures` verifies a KMS threshold signature over
     *         (this switch's handle, abi.encode(dataKey)). A proof for any other handle
     *         or value reverts, so a revealer cannot claim a bounty with a wrong key.
     *         The submission is public calldata and can be front-run; that race is
     *         the delivery mechanism (see ARCHITECTURE.md).
     */
    function revealKey(address owner, uint256 id, bytes32 dataKey, bytes calldata decryptionProof)
        external
        nonReentrant
    {
        bytes32 key = _key(owner, id);
        Switch storage s = switches[key];
        if (s.owner == address(0)) revert DoesNotExist();
        if (s.status == Status.REVEALED) revert AlreadyRevealed();
        if (s.status != Status.ACTIVE) revert NotActive();
        if (!s.darkMarked) revert NotDarkMarked();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint256.unwrap(s.encKey);
        FHE.checkSignatures(handles, abi.encode(dataKey), decryptionProof);

        s.status = Status.REVEALED;
        s.revealedKey = dataKey;
        s.revealedAt = uint64(block.timestamp);
        // The whole pot goes to the revealer, owner escrow and funder contributions
        // alike.
        uint256 bounty = s.bounty;
        s.bounty = 0;
        // Funder entries cannot be cleared per funder here; the views report 0 for
        // every stake once REVEALED, and no write path reads them again.
        ownerStake[key] = 0;
        emit KeyRevealed(key, msg.sender, dataKey, bounty, uint64(block.timestamp));
        _send(msg.sender, bounty);
    }

    /**
     * @notice Optional convenience: post the plaintext on-chain, verified against
     *         the creation-time commitment. Not required for the secret to be
     *         public — anyone can decrypt `getCiphertext` with `getRevealedKey`.
     *         The payload is emitted, not stored.
     */
    function publishPlaintext(address owner, uint256 id, bytes32 salt, bytes calldata payload) external {
        bytes32 key = _key(owner, id);
        Switch storage s = switches[key];
        if (s.owner == address(0)) revert DoesNotExist();
        if (s.status != Status.REVEALED) revert NotRevealed();
        if (s.published) revert AlreadyPublished();
        if (payload.length > MAX_PAYLOAD_SIZE) revert PayloadTooLarge();
        if (keccak256(abi.encodePacked(salt, payload)) != s.plaintextCommitment) revert CommitmentMismatch();

        s.published = true;
        emit PlaintextPublished(key, msg.sender, payload);
    }

    // ---------- Views ---------- //

    struct SwitchInfo {
        address owner;
        State state;
        uint64 lastPing;
        uint64 pingInterval;
        uint64 createdAt;
        uint64 expiresAt;
        uint64 darkMarkedAt;
        uint64 revealedAt;
        uint256 bounty;
        uint256 ownerStake;
        bytes32 plaintextCommitment;
        bytes32 encKeyHandle;
        bytes32 revealedKey;
        uint256 ciphertextLength;
        bool published;
        bool rescuable;
    }

    function getSwitchInfo(address owner, uint256 id) external view returns (SwitchInfo memory info) {
        bytes32 key = _key(owner, id);
        Switch storage s = switches[key];
        info.owner = s.owner;
        info.state = _state(s);
        info.lastPing = s.lastPing;
        info.pingInterval = s.pingInterval;
        info.createdAt = s.createdAt;
        info.expiresAt = s.lastPing + s.pingInterval;
        info.darkMarkedAt = s.darkMarkedAt;
        info.revealedAt = s.revealedAt;
        info.bounty = s.bounty;
        info.ownerStake = ownerStake[key];
        info.plaintextCommitment = s.plaintextCommitment;
        info.encKeyHandle = euint256.unwrap(s.encKey);
        info.revealedKey = s.revealedKey;
        info.ciphertextLength = s.ciphertext.length;
        info.published = s.published;
        info.rescuable = s.owner != address(0) && _rescuable(s);
    }

    function getState(address owner, uint256 id) external view returns (State) {
        return _state(switches[_key(owner, id)]);
    }

    /// @notice True while the owner is within their ping interval.
    function isAlive(address owner, uint256 id) external view returns (bool) {
        return _state(switches[_key(owner, id)]) == State.ALIVE;
    }

    /// @notice True once the deadline has passed on an ACTIVE switch (marked or not).
    function isDark(address owner, uint256 id) external view returns (bool) {
        Switch storage s = switches[_key(owner, id)];
        return s.owner != address(0) && s.status == Status.ACTIVE && _isDark(s);
    }

    function getCiphertext(address owner, uint256 id) external view returns (bytes memory) {
        return switches[_key(owner, id)].ciphertext;
    }

    /// @notice The DEK once revealed; zero before.
    function getRevealedKey(address owner, uint256 id) external view returns (bytes32) {
        return switches[_key(owner, id)].revealedKey;
    }

    function getEncKeyHandle(address owner, uint256 id) external view returns (bytes32) {
        return euint256.unwrap(switches[_key(owner, id)].encKey);
    }

    function getBounty(address owner, uint256 id) external view returns (uint256) {
        return switches[_key(owner, id)].bounty;
    }

    function getOwnerStake(address owner, uint256 id) external view returns (uint256) {
        return ownerStake[_key(owner, id)];
    }

    /// @notice A funder's reclaimable contribution; 0 once the switch is revealed.
    function getFunderStake(address owner, uint256 id, address funder) external view returns (uint256) {
        bytes32 key = _key(owner, id);
        if (switches[key].status == Status.REVEALED) return 0;
        return funderStake[key][funder];
    }

    function expirationTime(address owner, uint256 id) external view returns (uint64) {
        Switch storage s = switches[_key(owner, id)];
        return s.lastPing + s.pingInterval;
    }

    function switchKey(address owner, uint256 id) external pure returns (bytes32) {
        return _key(owner, id);
    }

    // ---------- Internal ---------- //

    function _key(address owner, uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, id));
    }

    /// @dev Deadline passed. Callers check existence and status separately.
    function _isDark(Switch storage s) internal view returns (bool) {
        return block.timestamp >= uint256(s.lastPing) + uint256(s.pingInterval);
    }

    /// @dev Still ACTIVE (neither cancelled nor revealed) and RESCUE_DELAY past dark.
    function _rescuable(Switch storage s) internal view returns (bool) {
        return
            s.status == Status.ACTIVE && block.timestamp >= uint256(s.lastPing) + uint256(s.pingInterval) + RESCUE_DELAY;
    }

    function _state(Switch storage s) internal view returns (State) {
        if (s.owner == address(0)) return State.NONE;
        if (s.status == Status.CANCELLED) return State.CANCELLED;
        if (s.status == Status.REVEALED) return State.REVEALED;
        if (s.darkMarked) return State.DARK_MARKED;
        if (_isDark(s)) return State.DARK;
        return State.ALIVE;
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
