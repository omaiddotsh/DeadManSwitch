# Architecture — DeadManSwitch on Zama fhEVM

> **Status:** the contract is final and its 181 Foundry tests pass. It has had
> internal security reviews, but no external audit
> ([SECURITY.md](./SECURITY.md)). Client and frontend pass their unit tests,
> the CLI/watcher end-to-end run and the Playwright browser suite on Anvil with
> Zama's mock host. **Not deployed, not externally audited, not run against
> Zama's real relayer or KMS.** See [README.md](./README.md#status).

## 1. What it does

A ping-extendable dead-man switch on Ethereum. The owner stores an encrypted
secret and an ETH bounty, and pings to show they are alive. If they stop
pinging for one interval, anyone can trigger the release, and from then on the
secret is public forever, readable from chain state alone.

Release is **public only**: there is no recipient mode and no fixed-date vault.

| Piece | Where | Job |
| --- | --- | --- |
| `DeadManSwitch.sol` | Ethereum mainnet (1), Sepolia (11155111), local Anvil (31337) | Stores the ciphertext and the FHE-encrypted data key; decides "is the owner dark?" from `block.timestamp`; asks the KMS to decrypt; verifies the KMS proof; holds and pays bounties. |
| Zama fhEVM host + KMS | Zama's contracts on the same chain; KMS of 13 MPC nodes off-chain (per Zama) | Holds the data key as an `euint256`. Decrypts it publicly only after the contract calls `FHE.makePubliclyDecryptable`, and signs the result. |
| Zama relayer | HTTPS service | Input proofs at create time; public-decryption proofs at reveal time. Needs an API key on mainnet (1); the Sepolia relayer is open. |
| `client/` | Node 22 CLI + watcher daemon | Every user action; an unattended hunter that marks, reveals, decrypts and optionally publishes. |
| `frontend/` | Next.js 16 app + `/api/relayer` proxy | Create, ping, fund, hunt, read. The proxy keeps the relayer API key on the server. |

There is no other backend and no off-chain database. Everything a reader needs
is `(chainId, contract, owner, id)`.

## 2. Mechanism

```
owner (browser or CLI)
  dek  = 32 random bytes                       salt = 32 random bytes
  ct   = 0x01 ‖ nonce ‖ AES-256-GCM(dek, nonce, salt ‖ plaintext)
  com  = keccak256(salt ‖ plaintext)
  (handle, inputProof) = Zama SDK encrypt(dek as euint256, contract, owner)
  createSwitch({id, pingInterval, com}, ct, handle, inputProof) + bounty
  ping(id) ... ping(id) ...                    each ping moves the deadline to now + pingInterval

block.timestamp >= lastPing + pingInterval     (evaluated by Ethereum consensus, inside the contract)

anyone   markDark(owner, id)                   contract calls FHE.makePubliclyDecryptable(dek handle)
anyone   relayer public-decrypt([handle])      KMS threshold-decrypts, returns (dek, decryptionProof)
anyone   revealKey(owner, id, dek, proof)      FHE.checkSignatures(...) → REVEALED, dek stored, whole pot paid
anyone   getCiphertext + getRevealedKey        AES-GCM decrypt locally; verify tag and commitment
anyone   publishPlaintext(owner, id, salt, pt) optional; commitment-checked; emitted, not stored
```

Only the 32-byte data key (DEK) goes through FHE, so the FHE cost per switch is
fixed and independent of the secret's size. The ciphertext lives in contract
storage (not only in an event), so it survives log-history expiry.

## 3. State machine

`getState(owner, id)` returns the derived state. `DARK` needs no transaction:
time passing turns `ALIVE` into `DARK`.

```
             createSwitch (owner; msg.value = owner's stake)
   NONE ─────────────────────────────────────────────► ALIVE ── ping (owner): deadline = now + pingInterval ──┐
                                                         │ ▲                                                  │
                                                         │ └──────────────────────────────────────────────────┘
                   cancel (owner, only while ALIVE)      │
   CANCELLED ◄───────────────────────────────────────────┤
   key never decryptable; owner gets own stake back;     │ time passes: block.timestamp ≥ lastPing + pingInterval
   funders use reclaimContribution                       ▼
                                                        DARK          ping / fundBounty / cancel revert Expired
                                                         │
                                                         │ markDark (anyone): FHE.makePubliclyDecryptable, irreversible
                                                         ▼
                                                    DARK_MARKED       the KMS will now decrypt the key for anyone
                                                         │
                                                         │ revealKey (anyone, valid KMS proof): key stored, whole pot to caller
                                                         ▼
                                                     REVEALED ── publishPlaintext (anyone, optional, once): published = true

   Rescue (flag `rescuable`, not a state): status still ACTIVE (DARK or DARK_MARKED) and
   block.timestamp ≥ lastPing + pingInterval + RESCUE_DELAY (30 days)
   → reclaimOwnerStake / reclaimContribution return each depositor's own principal.
   The state does not change: markDark and a late revealKey still work and pay whatever is left.
```

Internally the contract stores `Status { ACTIVE, CANCELLED, REVEALED }` plus a
`darkMarked` flag; `State` is computed from those and the clock. `CANCELLED`
and `REVEALED` are terminal and distinct: funder contributions are reclaimable
after a cancel, and the whole pot has been paid out after a reveal.

## 4. Contract surface (`contracts/src/DeadManSwitch.sol`)

All switches live in one `mapping(bytes32 => Switch)` keyed by
`keccak256(abi.encodePacked(owner, id))`. No factory, no proxies, not upgradeable.

### Constants and configuration

| Name | Value | Meaning |
| --- | --- | --- |
| `MIN_PING_INTERVAL` / `MAX_PING_INTERVAL` | 60 s / 365 days | Bounds on `pingInterval`. |
| `MAX_PAYLOAD_SIZE` | 2048 | Max plaintext bytes (salt excluded). |
| `CIPHERTEXT_OVERHEAD` | 61 | version 1 + nonce 12 + salt 32 + tag 16. |
| `MAX_CIPHERTEXT_SIZE` | 2109 | 2048 + 61. |
| `RESCUE_DELAY` | 30 days | After the deadline, before depositors may recover their principal. |
| `MAX_MIN_BOUNTY_USD` | 10,000e8 | Cap on the admin-settable floor ($10,000, 8 decimals). |
| `ethUsdPriceFeed`, `maxPriceAge` | immutable | Chainlink ETH/USD feed and max answer age. Feed `0` disables the floor (local chains). |
| `minBountyUsd` | storage | Floor in USD (8 decimals). `0` disables it. |
| `admin`, `pendingAdmin` | storage | Two-step admin; it can only change `minBountyUsd`. |

Constructor `(address ethUsdPriceFeed, uint256 minBountyUsd, uint256 maxPriceAge)`
reverts `MinBountyUsdTooHigh` above the cap, and `InvalidConfig` for a floor
without a feed, a feed with `maxPriceAge == 0`, or a feed with more than 36
decimals. The inherited `ZamaEthereumConfig` reverts `ZamaProtocolUnsupported`
on any chain other than 1, 11155111 and 31337.

### Writes

| Function | Caller | Requires | Effect | Event |
| --- | --- | --- | --- | --- |
| `createSwitch(CreateParams{id, pingInterval, plaintextCommitment}, bytes ciphertext, externalEuint256 encKey, bytes inputProof)` payable | owner | `id != 0`; interval in bounds; `61 ≤ ciphertext.length ≤ 2109`; commitment ≠ 0; non-empty proof; `msg.value ≥ minBounty()`; `(owner,id)` unused; handle never used before | `FHE.fromExternal` (proof binds the handle to `msg.sender` and this contract), `FHE.allowThis` only; stores everything; `msg.value` becomes the owner's stake | `SwitchCreated` |
| `ping(id)` | owner | ACTIVE and not dark | `lastPing = now` | `Pinged(key, lastPing, expiresAt)` |
| `fundBounty(owner, id)` payable | anyone | `msg.value > 0`; ACTIVE and not dark | Adds to the pot, tracked per funder | `BountyFunded(key, funder, amount, newTotal)` |
| `cancel(id)` | owner | ACTIVE and not dark | `CANCELLED`; refunds the owner's own stake only; the key is never made decryptable | `SwitchCancelled` |
| `reclaimContribution(owner, id)` | funder | CANCELLED, or rescuable | Returns the caller's own contribution | `ContributionReclaimed` |
| `reclaimOwnerStake(id)` | owner | rescuable | Returns the owner's own stake; status stays ACTIVE | `OwnerStakeReclaimed` |
| `markDark(owner, id)` | anyone | ACTIVE, dark, not yet marked | `darkMarked = true`, `darkMarkedAt = now`, `FHE.makePubliclyDecryptable(encKey)` | `SwitchDarkMarked(key, caller, handle, ts)` |
| `revealKey(owner, id, bytes32 dataKey, bytes decryptionProof)` | anyone | ACTIVE and marked; `FHE.checkSignatures([handle], abi.encode(dataKey), proof)` passes | `REVEALED`, stores `dataKey`, pays the **whole** pot to `msg.sender`, zeroes `ownerStake` | `KeyRevealed(key, revealer, dataKey, bountyPaid, ts)` |
| `publishPlaintext(owner, id, bytes32 salt, bytes payload)` | anyone | REVEALED; not yet published; `payload.length ≤ 2048`; `keccak256(salt ‖ payload) == commitment` | `published = true`; payload is emitted, not stored; pays nothing | `PlaintextPublished(key, publisher, payload)` |
| `setMinBountyUsd(usd8)` | admin | ≤ cap; non-zero needs a feed | New floor, for new switches only | `MinBountyUsdUpdated` |
| `transferAdmin(addr)` | admin | — | Sets `pendingAdmin` (`0` cancels) | `AdminTransferStarted` |
| `acceptAdmin()` | pending admin | — | Completes the transfer | `AdminTransferred` |
| `renounceAdmin()` | admin | — | `admin = pendingAdmin = 0`; the floor is fixed forever | `AdminTransferred(admin, 0)` |

`cancel`, `reclaimContribution`, `reclaimOwnerStake` and `revealKey` are
`nonReentrant` (EIP-1153 transient-storage lock) and follow checks-effects-interactions.
Payouts use `call`; a recipient that rejects ETH makes its own call revert
`TransferFailed` and harms nobody else.

Revert precedence worth knowing: `reclaimContribution` reverts `AlreadyRevealed`
on a revealed switch and `NotRescuable` on an ACTIVE switch before the rescue
window; `revealKey` reverts `AlreadyRevealed` before `NotActive`.

### Views

| View | Returns |
| --- | --- |
| `getSwitchInfo(owner, id)` | `SwitchInfo{owner, state, lastPing, pingInterval, createdAt, expiresAt, darkMarkedAt, revealedAt, bounty, ownerStake, plaintextCommitment, encKeyHandle, revealedKey, ciphertextLength, published, rescuable}` in one call. |
| `getState`, `isAlive`, `isDark` | Derived state. `isDark` is true for both DARK and DARK_MARKED. |
| `getCiphertext`, `getRevealedKey`, `getEncKeyHandle` | The stored ciphertext; the DEK (`0x0` until revealed); the `euint256` handle. |
| `getBounty`, `getOwnerStake`, `getFunderStake(owner, id, funder)` | Pot and per-depositor stakes. Both stake views read `0` once REVEALED (the pot was paid out). |
| `expirationTime`, `switchKey` | `lastPing + pingInterval`; the mapping key. |
| `keyHandleUsed(bytes32)` | Whether an FHE handle is already bound to a switch. |
| `minBounty()` | Current floor in wei; `0` when disabled **or** when the oracle is unusable (fails open). |
| `oraclePrice()` | `(ok, price)`: lets a UI tell "floor disabled" from "oracle down". |
| `admin`, `pendingAdmin`, `minBountyUsd`, `ethUsdPriceFeed`, `maxPriceAge`, constants | Configuration. |

### Events

| Event | Fields |
| --- | --- |
| `SwitchCreated` | `switchKey` (indexed), `owner` (indexed), `switchId` (indexed), `pingInterval`, `timestamp`, `bounty`, `plaintextCommitment`, `encKeyHandle`, `ciphertext` |
| `Pinged` | `switchKey` (indexed), `lastPing`, `expiresAt` |
| `BountyFunded` | `switchKey` (indexed), `funder` (indexed), `amount`, `newTotal` |
| `SwitchCancelled` | `switchKey` (indexed), `owner` (indexed), `refund`, `timestamp` |
| `ContributionReclaimed` / `OwnerStakeReclaimed` | `switchKey` (indexed), depositor (indexed), `amount` |
| `SwitchDarkMarked` | `switchKey` (indexed), `caller` (indexed), `encKeyHandle`, `timestamp` |
| `KeyRevealed` | `switchKey` (indexed), `revealer` (indexed), `dataKey`, `bountyPaid`, `timestamp` |
| `PlaintextPublished` | `switchKey` (indexed), `publisher` (indexed), `payload` |
| `MinBountyUsdUpdated`, `AdminTransferStarted`, `AdminTransferred` | admin changes |
| `PublicDecryptionVerified` | `handlesList` (`bytes32[]`), `abiEncodedCleartexts` (`bytes`). Not declared in `DeadManSwitch.sol`: the fhEVM library's `FHE.checkSignatures` emits it from this contract's address inside every successful `revealKey`, just before `KeyRevealed`. It carries the one handle and `abi.encode(dataKey)`, the same key as `KeyRevealed`. |

Every change to the pot emits its amount, so an indexer can rebuild the pot
from logs. Clients discover switches by scanning `SwitchCreated` and read
everything else through views.

## 5. Ciphertext format v1

```
ciphertext = 0x01 ‖ nonce(12) ‖ AES-256-GCM(dek, nonce, salt(32) ‖ plaintext)    (GCM output = body ‖ 16-byte tag; no AAD)
commitment = keccak256(salt ‖ plaintext)                                          (= keccak256(abi.encodePacked(salt, payload)))
length     = plaintext length + 61, at most 2109
```

- The contract checks only the length bounds; it never parses the envelope or
  the version byte.
- The salt is inside the encryption. Because the commitment is public from
  creation, the salt is what stops anyone confirming a guessable secret against
  it.
- [`docs/ciphertext-test-vector.json`](./docs/ciphertext-test-vector.json) fixes
  the format (52-byte plaintext, 113-byte ciphertext). Both implementations
  (`client/src/envelope.ts`, `frontend/lib/envelope.ts`) have a unit test that
  decrypts it and re-encrypts it byte for byte with the fixed nonce.
- Each create uses a fresh random DEK, salt and nonce. The DEK is never written
  to disk.

### What clients check after a reveal

The contract proves that the revealed key is what Zama's KMS decrypted for this
handle. It cannot prove that the key opens the ciphertext the owner uploaded,
or that the ciphertext matches the commitment. Both clients therefore
AES-GCM-decrypt the on-chain ciphertext with every key they obtain (from the
KMS or from `getRevealedKey`) and, if the tag fails, show:

> Key accepted by the KMS proof but does not open the ciphertext — the owner
> uploaded an invalid ciphertext, or Zama's KMS signer set was compromised.

They also check the decrypted `(salt, plaintext)` against the commitment. A
reveal with a non-opening key still succeeds on-chain and pays the bounty (the
bounty pays for the KMS-proven key); the UI requires an extra "reveal anyway"
confirmation, and the CLI `read` command exits non-zero.

**Revealed plaintext is attacker-controlled.** The frontend renders it only as
a React text child of a `<pre>` (never HTML, never auto-linked; control and
bidi characters neutralised and flagged), with a download of the exact bytes.
Both apps make invisible characters visible as escapes and flag them, the same
set in each: format and tag characters, zero-width characters, variation
selectors (except one presentation selector after an emoji) and Hangul fillers.
The frontend does so in the display and in the copied text (`\u{…}`). The CLI
also escapes control and bidi characters, shows non-UTF-8 as hex, and writes
exact bytes only to a new file with mode 0600. The watcher never prints
plaintext.

## 6. Trust model

| Property | Rests on |
| --- | --- |
| **Darkness** ("has the owner missed the deadline?") | Ethereum consensus: `block.timestamp >= lastPing + pingInterval`, evaluated in the contract. No RPC, oracle or off-chain node decides it. |
| **Confidentiality before `markDark`** | FHE, plus Zama's KMS threshold (published by Zama as 9 of 13 MPC parties; this decryption threshold cannot be read on-chain), plus Zama's host governance (an upgraded ACL could authorise decryption early). |
| **Release liveness** | The Zama relayer and KMS serving the public decryption after `markDark`, and Zama's host not pausing or deny-listing the contract. |
| **Reveal integrity** (the recorded key is the real DEK) | The KMS signer set that `KMSVerifier` trusts, and its signature threshold: on Sepolia (read 2026-10-13) and on mainnet (read 2026-10-18) 7 of 13 signers, so any 7 can sign a proof `revealKey` accepts. Zama's ACL owner can change the set. |
| **Funds** | This contract only. No external call can move escrowed ETH except the payouts above. The oracle affects only the create-time floor. |

### Zama host governance, and how the protocol fails

Verified against the forge-fhevm host stack (the same contracts, run locally):

| Host action | Effect on DeadManSwitch | Failure mode |
| --- | --- | --- |
| ACL **pause** (any pauser) | `createSwitch` and `markDark` revert. `ping`, `fundBounty`, `cancel`, reclaims and `revealKey` on an already-marked switch still work on-chain (`KMSVerifier` is not pausable). | Fails closed: no new release starts; nothing leaks. The rescue clock keeps running from the deadline, so a long pause shortens the time in which a bounty still pays for a reveal. |
| ACL **deny-list** of this contract (ACL owner) | `createSwitch` and `markDark` revert for every switch (`SenderDenied`), permanently while listed. `ping`, `fundBounty`, `cancel`, reclaims and `revealKey` on an already-marked switch still work on-chain. | Fails closed: no new switch and no new release; secrets stay sealed; depositors recover principal through the rescue path after 30 days. |
| **New KMS context / KMSVerifier upgrade** (ACL owner) | A proof signed by the new signers passes `checkSignatures`. A forged `revealKey` can record a wrong key, take the pot and set REVEALED permanently. | Clients detect it (the key does not open the ciphertext). The real DEK is still publicly decryptable by the honest KMS, so the real plaintext can still be posted with `publishPlaintext` (commitment-checked). The bounty is lost to the forger. |
| **ACL upgrade** | Could mark a handle decryptable before `markDark`. | Confidentiality loss; not detectable by this contract. Same trust as any fhEVM application. |

Who holds Zama's ACL owner and pauser roles on mainnet (multisig, timelock,
governance) has not been checked yet; it is a pre-mainnet item in
[PRODUCTION-SETUP.md](./PRODUCTION-SETUP.md). On Sepolia (read 2026-10-13) the
ACL owner is a contract, `0x08e8a84c3c8c7cba165B1adcf67Ae4639eF84f52`; what
kind was not checked ([docs/fhevm-api-pins.md](./docs/fhevm-api-pins.md#sepolia-host-read-2026-10-13)).

### Caveats

- **Smart-account and EIP-7702 owners.** In the `createSwitch` transaction,
  `FHE.fromExternal` gives the caller a *transient* ACL right on the new handle.
  An owner account that executes other calls in the same transaction (a batch,
  a 7702 delegate, a wallet module) could use it to `ACL.allow` someone else or
  `allowForDecryption` the handle, making the DEK decryptable while the owner is
  alive or after a cancel. It gives the owner nothing they do not already know,
  but "sealed until `markDark`" and "cancelled = never decryptable" hold only
  if the owner's account does nothing else with the handle in that transaction.
  A plain EOA cannot do this: the transient right ends with the transaction.
- **Ciphertext length is public.** `ciphertextLength − 61` is the exact
  plaintext length, readable before release. v1 clients do not pad. The
  contract never parses the envelope, so a client can pad inside the encrypted
  body without a contract change; until one does, owners who care should pad
  the secret themselves.
- **`markDark` near the deadline and reorgs.** On any single chain, a ping
  before the deadline and `markDark` exclude each other (both read the same
  `block.timestamp` comparison), so the contract never marks an owner who could
  still ping in that block. Across a reorg, a ping in the last block before the
  deadline can be orphaned and a `markDark` included instead; that is the same
  as pinging late. Whether Zama's host listener waits for finality before
  acting on a `markDark` was not verified. Owners should ping well before the
  deadline, not in its last minutes.
- **One handle per proof.** `revealKey` verifies a proof over exactly one
  handle. A public-decrypt request that batches several handles yields a proof
  no switch can use; both clients request one handle per call.
- **One DEK per switch.** `keyHandleUsed` stops one FHE handle backing two
  switches. It cannot stop an owner encrypting the same DEK twice under
  different handles; the clients generate a fresh DEK for every create.

## 7. Threat model

| Threat | Mitigation / status |
| --- | --- |
| Early release while the owner is alive | `markDark` requires `block.timestamp ≥ lastPing + pingInterval`; `ping` reverts from that same instant. Tested at the exact boundary and under fuzzing. Before `markDark` the DEK is not publicly decryptable (invariant I4). |
| KMS collusion (≥ threshold parties) | Can decrypt any DEK at any time; 7 colluding Sepolia signers can also sign a forged reveal (wrong key, bounty taken; clients detect it, §6). Inherent to the design; the trust statement above. |
| Zama host pause / deny-list / signer change / upgrade | See §6. Fails closed for confidentiality except an ACL upgrade; funds recoverable via rescue; forged reveals detectable by the tag check. |
| Relayer or KMS outage | Release is delayed, not lost. After 30 days depositors can recover their principal; the switch stays ACTIVE, so a late `revealKey` still lands and takes whatever is left. |
| Wrong key submitted to `revealKey` | `checkSignatures` binds the proof to this switch's handle and to `abi.encode(dataKey)`. Wrong key, proof for another switch, forged or empty proof, non-KMS signer: all revert (tested, including fuzzing). |
| Input-proof replay or theft | The proof binds the handle to `(msg.sender, this contract)`: another user or another contract reverts `InvalidSigner`. The same handle for a second switch reverts `KeyHandleReused`. An empty proof reverts `EmptyInputProof` (it would otherwise take `fromExternal`'s allowed-handle path, which maps the zero handle to a trivial encryption of 0). |
| Owner uploads a ciphertext that the DEK does not open, or that does not match the commitment | Undetectable on-chain. `revealKey` still pays (it pays for the KMS-proven key). `publishPlaintext` can never succeed with what the DEK decrypts to; only someone holding the committed `(salt, plaintext)`, such as the owner, can still publish that, and the published payload is then the commitment-checked plaintext. Clients verify the tag and the commitment, warn (§5), and show a published payload next to the decrypted bytes. |
| **Cancel sweeping funder money** | Per-depositor ledgers: invariant `bounty == ownerStake + Σ funderStake` while ACTIVE or CANCELLED. `cancel` refunds only the owner's stake; funders use `reclaimContribution`. Tested by unit, fuzz and invariant tests. |
| **Zombie switch after cancel** | `Status` enum: `ping`, `fundBounty`, `markDark` revert `NotActive` after cancel. A cancelled id can never be reused (`AlreadyExists`). |
| **Trapped bounty** | `RESCUE_DELAY` rescue, per depositor, own principal only. Covers "the KMS never served a proof". Rescue is not folded into `cancel`, so the owner's key cannot retract a pending reveal. |
| Late `markDark` close to the rescue window | The rescue clock runs from the deadline, not from `markDark`, so depositors may empty the pot while the KMS is producing the proof. The release still happens (bounty 0). `getSwitchInfo().rescuable` shows the risk before a hunter spends gas. Accepted design. |
| Hunter griefing: floor-bounty switches timed to go dark just before a real one | Delay only. The watcher sends highest bounty first (a reveal before a `markDark` at equal bounty), reads chain time again during a pass, and queues a switch that goes dark meanwhile in the same pass; a backlog delays a switch only if each item carries at least its bounty, which goes to whoever reveals. Sends still wait for each receipt. |
| Redeploy on the same chain hides live switches | The contract is immutable, so a redeploy leaves the old contract's switches live; an owner who cannot find one to ping it has its secret released. The frontend keeps previous deployments listed and writable (`NEXT_PUBLIC_PREVIOUS_CONTRACTS_<id>`, `lib/deployments.json`), sends every write to its switch's own contract, and gives links a `?contract=`. Operators must keep the old address listed until every switch on it is revealed or cancelled ([PRODUCTION-SETUP.md §6](./PRODUCTION-SETUP.md#redeploying-on-the-same-chain)). |
| **Reveal front-running / MEV — by design** | `revealKey`'s `(dataKey, proof)` is public calldata, and after `markDark` anyone can fetch the same proof from the relayer. Whoever lands first is paid. That race is the delivery mechanism; there is no commit-reveal. The `markDark` caller is not paid; hunters should only mark switches whose bounty covers both transactions. |
| **Owner self-reveal — by design** | The owner can stop pinging and then mark and reveal their own switch, collecting funder contributions. A dead-man switch assumes the owner is unable to ping, not unwilling. Funders trust the owner. Shown in the UI. |
| Reentrancy on payouts | Transient-storage lock plus CEI on all four ETH-moving functions. Re-entering any of them hits the lock before the function body runs and reverts `Reentrancy` (not `AlreadyRevealed`). Tested from a revealer's payout callback re-entering `revealKey`, `cancel` and `reclaimContribution`; CEI means the switch is already `REVEALED` with bounty 0 when the ETH leaves. |
| Recipient that rejects ETH | Only its own call reverts `TransferFailed`. An owner that cannot receive ETH cannot `cancel` while it has a stake, but can keep pinging and can fix the account (tested). |
| Sub-gas bounties | Chainlink-priced `minBounty` floor (USD, admin-settable, capped at $10,000). Fails **open**: if the feed reverts, has no code, returns short data, a non-positive, future or stale answer, the floor is 0, so a dead feed can never brick `createSwitch` (which would be permanent after `renounceAdmin`). Existing switches never read the oracle. |
| Admin abuse | The admin controls only `minBountyUsd`, capped. Two-step transfer; renounceable. Recommended: a multisig admin. |
| `block.timestamp` skew | PoS timestamps are slot-aligned (12 s). `MIN_PING_INTERVAL = 60 s`. |
| Owner false trigger (lost key, outage, vacation) | Choose a long interval and ping early. No relayed or delegated pings exist. |
| Untrusted revealed plaintext (XSS, terminal escapes, bidi spoofing, hidden text) | Rendered as text only; control, bidi and invisible characters escaped in both apps; exact bytes only via explicit download / `--out` (§5). |
| Relayer API key exposure | Browsers never see it: the frontend's `/api/relayer` proxy injects it server-side and relays only the encrypt and public-decrypt endpoints: input proofs only for this app's contract, public decrypts only for one `euint256` handle on this chain, with body caps, timeouts and a per-IP rate limit. |

## 8. Gas

Two sources, both with **one** mock coprocessor signer and **one** mock KMS
signer. Mainnet and Sepolia verify several signatures per input proof and per
decryption proof, so `createSwitch` and `revealKey` will cost more there; that
has not been measured.

- **Foundry:** `forge test --gas-report` over every suite except the invariant
  suite (mock host, mock Chainlink feed). Median per call, reverting calls
  included; the committed
  [`contracts/.gas-snapshot`](./contracts/.gas-snapshot) holds whole-test totals
  for regression checks.
- **Local Anvil:** transaction receipts on Anvil + the forge-fhevm host, no
  price feed. These were taken before a storage-packing change that made
  `ping`, `fundBounty`, `cancel` and both reclaims ~2.1k cheaper; the Foundry
  medians include it.

A first figure with real signatures comes from a Sepolia fork with a real
7-of-13 KMS proof: `revealKey` used 395,303 gas
(estimate 405,925), `markDark` 80,090, and `createSwitch` 489,075 for a
62-byte ciphertext without a feed, 508,586 with the $10 floor, 1,959,149 at
2,109 bytes. Each KMS signature above 7 adds about 31.8k to `revealKey`. It
has not been repeated on Sepolia itself, and mainnet's threshold is not read
yet.

| Function | Foundry median | Local Anvil receipt | Notes |
| --- | ---: | ---: | --- |
| `createSwitch` | 421,223 | 430,431 (52-byte secret, 113-byte ciphertext) | Foundry: 398,212 at the 61-byte minimum, 1,868,452 at the 2,109-byte maximum. Anvil: 384,701 at 62 bytes, 1,854,855 at 2,109 bytes. Grows ~22.1k per 32-byte storage word of ciphertext. Includes `fromExternal` + `allowThis` (~160k). |
| `ping` | 26,585 | 31,554 | |
| `fundBounty` | 54,711 | 73,926 (first contribution, new funder, zero pot) | |
| `cancel` | 42,023 | 36,451 (zero stake, no transfer) | |
| `reclaimContribution` | 39,416 | 35,383 | |
| `reclaimOwnerStake` | 38,723 | — | |
| `markDark` | 80,441 | 80,616 | `makePubliclyDecryptable` ~51k of it. |
| `revealKey` | 141,380 | 146,897 (zero pot) – 149,796 (0.01 ETH pot) | Dominated by `checkSignatures`; scales with the KMS signer count. |
| `publishPlaintext` | 40,831 | 34,302 (short payload) | 83,768 for a 2,048-byte payload (Foundry). |
| `setMinBountyUsd` / `transferAdmin` / `acceptAdmin` / `renounceAdmin` | 25,900 / 30,693 / 23,417 / 25,682 | — | |
| Deployment | 3,194,770 | 3,166,092 (no feed) | Runtime 14,029 bytes; 10,547 bytes under EIP-170. |

A hunter pays `markDark` + `revealKey` (about 230k gas locally) and is paid the
pot in `revealKey`. Any Zama fee for public decryption is unknown and not
included.

## 9. Off-chain components

| | Client (`client/`) | Frontend (`frontend/`) |
| --- | --- | --- |
| SDK | `@zama-fhe/sdk` 3.6.0, `node()` relayer on 1/11155111 (`ZAMA_RELAYER_API_KEY` required on 1; Sepolia's relayer is open); `cleartext()` on 31337 | Same SDK, `web()` relayer pointed at its own `/api/relayer/<chainId>`; `cleartext()` on 31337 when `NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=1` |
| Envelope | `src/envelope.ts` (Node WebCrypto) | `lib/envelope.ts` (WebCrypto) |
| Public decrypt | One handle per call; result checked to be exactly 32 bytes | One handle per call; handle's chain id and type checked |
| Key check | `verifyKeyOpensCiphertext` + `KEY_MISMATCH_WARNING` | `checkKey` + `INVALID_KEY_WARNING` |
| Untrusted plaintext | `src/sanitize.ts`; `--out` writes exact bytes (0600, no overwrite) | `lib/envelope.ts` `toDisplayText` (the CLI's set of invisible characters as `\u{…}`) and `components/switch/PlaintextView.tsx`; text child only; byte-exact download |
| Writes in flight | A timed-out write names its hash and nonce; `create` and `fund-bounty` refuse while one from the key is pending (`--queue`, `--replace <hash>`) | `lib/pendingWrites.ts`: one per switch and function per tab (top-ups and reclaims per sender), refused before the wallet, resumed after a reload (`sessionStorage`). Every write but `createSwitch`, `ping` and `cancel` is dry-run first (at most 2 s). Writes from a contract account (a Safe, a 4337 account) are followed through the wallet (`wallet_getCallsStatus`, then its receipt) and count as done only when the receipt carries the write's own event for this switch from its contract. |
| Deployments | One contract (`DMS_ADDRESS`); a state file is bound to one chain and contract and refuses another | One current deployment per chain (creates) and any number of previous ones (`NEXT_PUBLIC_PREVIOUS_CONTRACTS_<id>`, `lib/deployments.json`): all are scanned, every write goes to its switch's own contract, links carry `?contract=`. A chain with only previous deployments stays usable with creates and the admin page off. |
| Create retries | `create <id> …` takes an explicit id and checks it is unused before sending | `lib/createAttempt.ts`: the id is drawn once per form session and reused by every retry; before resealing, the page reads `(owner, id)` and adopts an earlier send that landed; while a sent tx hash has no outcome it shows "Waiting for confirmation" and offers no new create. So a retry cannot leave a second live switch holding the same secret. |
| Hunter | `src/watcher.ts`: discovery by adaptive chunked `SwitchCreated` scans, re-scanning up to 64 blocks below the last scanned block each pass with new blocks; `markDark` only when the bounty covers mark + reveal gas; sends highest bounty first (a reveal before a `markDark` at equal bounty), re-reading chain time during the pass; a `revealGasEstimate` pre-check before any KMS request; public decrypt with backoff and a per-pass time budget; exact gas estimate before `revealKey`; transactions recorded before waiting and replaced (same nonce, higher fees, capped, and only while the bounty still pays) if stuck; a revealed or cancelled switch is done only once the finalized block shows it, and what was booked is then checked on the final chain; lost front-running races recorded, not counted as errors; saves plaintexts (never overwriting); optional publish; resumable state file, one watcher per state file (`<stateFile>.lock`, with a heartbeat) | `/hunt` page and the six-step reveal panel (mark, fetch, verify, reveal, decrypt, publish) |
| Docs | [client/README.md](./client/README.md) | [frontend/README.md](./frontend/README.md) |

The FHE public key and CRS the browser needs to encrypt (4,604,386 bytes on
Sepolia: a 33 KB public key and a 4.57 MB CRS) are located through the proxy's
`keyurl`, downloaded from Zama's bucket and cached in IndexedDB; hunters never
download them. The cache is keyed on the bucket URLs as well as the dataIds,
since Sepolia's relayer sends constant placeholder dataIds, and a cached copy
is dropped once when Zama rejects an input proof made with it.

## 10. Testing

| Suite | Count | What |
| --- | --- | --- |
| `contracts/test` (Foundry; all but the deploy-script tests on forge-fhevm `FhevmTest`, real mock ACL / InputVerifier / KMSVerifier / executor) | 181 | Create 29, PingFundCancel 36, Release 32, RescueAdmin 44, Hardening 7 (a valid KMS proof before `markDark`, a proof signed under another chain's domain, a feed with trailing return data, the floor at its cap, the rescue clock, ETH conservation on a mixed self-fund path, no top-ups once dark), Fuzz 7, FuzzInvariant 9 (8 invariants: balance = Σ bounties, ledger sums, revealed pot is 0, unmarked key never publicly decryptable, ETH conservation, ghost ledger, revealed key is the owner's DEK, valid actions never revert), Lifecycle 1, Deploy 16 (`Deploy.s.sol`: strict environment parsing, chain-1 guards, a `PRIVATE_KEY` that is not the chosen sender, post-deploy checks). The gas snapshot holds the 160 that are neither fuzz nor invariant tests. |
| `client/test` (vitest) | 264 | Test vector, envelope bounds and tampering, watcher decisions and profit, CLI args, CLI commands against a fake node that takes signed transactions (timeouts, `--replace`, `--queue`, partial reveals), sanitiser, config and SDK wiring (including relayer error classification and URL redaction), ABI drift (fails under CI without a fresh artifact), error decoding and revert replay (including a node without the block's state), and the watcher (113) on an in-memory chain and KMS: the state-file lock (holder identity, heartbeat, takeovers across real processes), lost races, stuck and replaced transactions (profit re-check, replacement racing inclusion, replaced cancels, held-back nonces freed only when what waits behind pays, base-fee-aware valuation), fatal relayer errors (including a wrong relayer path) and the persisted `markDark` pause, getLogs chunking, pruned history, the 64-block re-scan, resume and `--rescan-from`, the order of sends under spam, reorganisations after a booked outcome and finality checks, a state file for another contract, the KMS time budget, output files, fee raises only for a transaction next to be mined, and one state-file write per pass. |
| `frontend` (vitest) | 632 (+3 opt-in) | Test vector and invisible-character rendering, relayer proxy policy and its answers to the SDK (100), in-flight writes across reloads (`pendingWrites`), host error decoding, the FHE key download timeout and key cache, security headers and the build's deployment-variable checks, switch discovery scans (resume, backoff, pruned history, cache resumed from finality) and the published-plaintext lookup, write receipts (replacement, speed-ups, long waits, reads floored at the receipt's block), dry runs before the wallet, smart-account writes, several deployments per chain, multicall batching, the UI (stale data kept on refresh errors, pending-transaction links, near-deadline ping, cancel and top-up warnings, cancel and reveal amounts, party addresses in full, decimal comma, failed list reads), browser compatibility, the create-retry state machine and poll loop (sticky reverted, fresh re-reads before dropping an attempt, an open wallet prompt), switch helpers, FHE helpers, plaintext rendering and gas model. The 3 opt-in tests run the real SDK against a local chain (`npm run test:local`), including a create whose receipt times out with automine off. |
| `scripts/local-e2e.sh` | 4 scenarios, 116 checks | Anvil + forge-fhevm host + fresh contract: full lifecycle, cancel path, watcher (including a non-opening ciphertext), and the watcher losing both the `markDark` and `revealKey` races to a front-runner with automine off. |
| `frontend/e2e` (Playwright; `npm run test:e2e`, via `scripts/browser-e2e.sh`) | 30 tests in 13 specs, plus an opt-in screenshot spec | The built app (`next build` + `next start`) in Chromium against Anvil + forge-fhevm host + fresh contract, with an injected test wallet: create and ping, top-up, hunter release, cancel and reclaim, errors and the network guard, admin, create retries, lost wallet responses, rescue, two hunters, wallet sessions, untrusted plaintext, and the CLI and watcher working on the same chain as the UI. Runs locally. See [frontend/e2e/README.md](./frontend/e2e/README.md). |

Not tested anywhere: Sepolia, mainnet, Zama's real relayer and KMS.

## 11. Design decisions

| Decision | Why |
| --- | --- |
| `publishPlaintext` emits `PlaintextPublished` and stores only a `published` flag; there is no `getPublishedPlaintext` view | The plaintext is already recoverable from storage (`getCiphertext` + `getRevealedKey`); storing it again would cost roughly 1.4M gas at 2 KB (~22.1k per 32-byte word) for no new durability. |
| No reserved field in `SwitchCreated` for a future second release leg | A second leg would need a new contract anyway. |
| `@fhevm/solidity` **0.11.1**, not the latest 0.13.x | 0.13.4 calls `FHEVMExecutor.checkHandleType`, which exists only in host executor ≥ 0.5.0. The contract is immutable, so it must not depend on a host function the live host may lack. `checkSignatures` is identical in both. See [docs/fhevm-api-pins.md](./docs/fhevm-api-pins.md). |
| The Chainlink floor **fails open** (`minBounty() == 0` on a bad answer) instead of reverting `StalePrice` / `InvalidPrice` | A deprecated immutable feed after `renounceAdmin` would otherwise brick creation forever. |
| `reclaimContribution` reverts `AlreadyRevealed` or `NotRescuable` rather than one generic error | Precise errors for each ineligible state. |
| `revealKey` zeroes `ownerStake`; `getFunderStake` reads 0 once REVEALED | Views do not show money already paid out. |
| Constructor `(feed, minBountyUsd, maxPriceAge)`; feed `0` allowed when the floor is 0 | Configurable staleness; feedless local deployments. |
| `revealKey(..., bytes32 dataKey, ...)`; `getSwitchInfo` view | `getSwitchInfo` returns everything a UI needs in one call. |
| `keyHandleUsed`, `EmptyInputProof`, two-step admin, `MAX_MIN_BOUNTY_USD`, `oraclePrice()`, transient-storage reentrancy lock | Hardening. |
| `MAX_CIPHERTEXT_SIZE = 2048 + 61`; layout `0x01 ‖ nonce ‖ body ‖ tag` | Version byte; standard GCM output order. |
| `@zama-fhe/sdk` 3.6.0 with a server-side relayer proxy holding a server-only API key | The relayer needs an API key that must not reach browsers. |
| Dependencies via Soldeer, pinned in `soldeer.lock`; forge-fhevm at `3ee696f` | Reproducible installs. forge-fhevm `3ee696f` because the commit Zama's template pins signs decryption proofs over the wrong encoding. |
| End-to-end tests run locally only (`scripts/local-e2e.sh`) | There is no Sepolia end-to-end script yet; a Sepolia run is still required before mainnet. |
| `revealKey` costs 141k–150k gas with one mock KMS signer | The mainnet figure is not measured yet (§8). |
| The frontend supports a current deployment plus any number of previous ones per chain (`NEXT_PUBLIC_PREVIOUS_CONTRACTS_<id>`, `lib/deployments.json`); links carry `?contract=` | A redeploy of this contract leaves the old one's switches live, and their owners must still be able to ping them. |
