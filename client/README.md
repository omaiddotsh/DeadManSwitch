# DeadManSwitch — client (CLI + watcher)

TypeScript CLI and hunter daemon for the Zama fhEVM `DeadManSwitch`
(`../contracts/src/DeadManSwitch.sol`). Public release only: once an owner stops
pinging, anyone can release the secret, and after that anyone can read it from
chain state.

**Status (2026-10-13).** Every command and the watcher were exercised end to
end on a local Anvil running Zama's `forge-fhevm` host (cleartext executor and
mock KMS), via `../scripts/local-e2e.sh` (4 scenarios, 116 checks), and 264
unit tests pass. Sepolia and mainnet use the same code with `@zama-fhe/sdk`'s
`node()` relayer, but nothing has run against them yet (the original build
environment could not reach them). Run them against Sepolia before relying on
them.

## How it works

```
owner      plaintext ──AES-256-GCM(dek)──► ciphertext (stored in the contract)
           dek (32 random bytes) ──Zama SDK encrypt──► euint256 handle + input proof
           createSwitch(id, interval, commitment, ciphertext, handle, proof) + bounty
           ping(id) … ping(id) …                      (each ping extends the deadline)

deadline passes (judged by block.timestamp, not by anyone's RPC)
anyone     markDark(owner, id)       → contract calls FHE.makePubliclyDecryptable(dek)
anyone     KMS public decrypt(handle) → (dek, decryptionProof)   [one handle per request]
anyone     revealKey(owner, id, dek, proof) → contract checks the KMS signatures,
                                              stores dek, pays the whole bounty
anyone     getCiphertext + getRevealedKey → AES-GCM decrypt locally
anyone     publishPlaintext(owner, id, salt, plaintext)  (optional, commitment-checked)
```

State machine (`getState`): `NONE → ALIVE → DARK → DARK_MARKED → REVEALED`, or
`ALIVE → CANCELLED` (the key is then never decryptable).

### Ciphertext format v1 (`src/envelope.ts`)

```
ciphertext = 0x01 ‖ nonce(12) ‖ AES-256-GCM(dek, nonce, salt(32) ‖ plaintext)   (ciphertext ‖ 16-byte tag, no AAD)
commitment = keccak256(salt ‖ plaintext)
```

The plaintext can be at most 2048 bytes, and the ciphertext is always the
plaintext length plus 61 bytes. `test/envelope.test.ts` decrypts
`../docs/ciphertext-test-vector.json` and re-encrypts it byte for byte with the
fixed nonce. Every other implementation (the frontend included) must pass the
same vector.

### Checking the key

The contract proves the revealed key is what Zama's KMS decrypted. It cannot
prove that the key opens the ciphertext the owner uploaded. After obtaining a
key (from the KMS in `reveal` or the watcher, or from `getRevealedKey` in
`read`), the client AES-GCM-decrypts the on-chain ciphertext. If the tag fails,
it prints:

> key accepted by the KMS proof but does not open the ciphertext — the owner
> uploaded an invalid ciphertext, or Zama's KMS signer set was compromised

`reveal` and the watcher still submit the key, because the bounty pays for the
KMS-proven key. `read` exits non-zero. Separately, the client checks that the
decrypted `(salt, plaintext)` matches the creation-time commitment.
`publishPlaintext` requires that match.

### Revealed plaintext is untrusted

Whoever created a switch chose its bytes. The CLI never prints them raw:

- control characters (ESC, BEL, CR, C1 including the one-byte CSI), bidi overrides, zero-width and other invisible format characters (soft hyphen, the tag characters U+E0000–E007F that can carry hidden text), variation selectors (U+FE00–FE0F, U+E0100–E01EF, Mongolian U+180B–180F; they render as nothing and can carry hidden text one byte per selector) and the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) are shown as visible escapes, such as `\x1b[31m` or `\u{202e}`. A selector that is ordinary text after its base character is kept, as in the web app: one presentation selector after an emoji character (a red heart's U+FE0F, a keycap), one ideographic selector after a CJK ideograph (Japanese name variants), one Mongolian selector after a Mongolian letter. Anywhere else (after Latin letters, a second selector) it is escaped;
- plaintext that is not valid UTF-8 is shown as hex;
- `--out <file>` writes the exact bytes to a new file with mode 0600, and never overwrites an existing file. An empty `--out` (or `--file`) value, such as an unset shell variable, is a usage error. If the write fails (disk full, file size limit), the file is removed, so the `--out` retry is not blocked by an empty file.

The watcher never prints plaintext. It writes it to `outDir` (mode 0600,
never overwriting) and logs only lengths and paths.

## Setup

Requirements: Node 22 or later (`engines` says `>=22`, because `@zama-fhe/sdk`
3.6.0 requires it; `local-e2e.sh` refuses older versions). For local runs you
also need Foundry (`anvil`, `forge`, `cast`) and `jq`.

```bash
cd client
npm ci
cp .env.example .env       # then edit
```

| Variable | |
| --- | --- |
| `PRIVATE_KEY` | Signer. Not needed for `info`, `read` or `status`: leave it empty, as `.env.example` ships it (a bare `0x` also counts as unset). |
| `RPC_URL` | Host-chain RPC. Every run checks that it serves `CHAIN_ID`. |
| `CHAIN_ID` | `1` (Ethereum mainnet), `11155111` (Sepolia) or `31337` (local Anvil + forge-fhevm). Any other value is rejected, because `ZamaEthereumConfig` reverts on other chains. |
| `DMS_ADDRESS` | The deployed `DeadManSwitch`. |
| `ZAMA_RELAYER_API_KEY` | Required on mainnet (1) for `create`, `reveal` and the watcher; optional on Sepolia, whose relayer is open. Sent as `x-api-key`. Keep it out of browsers. |
| `ZAMA_RELAYER_URL` | Optional relayer override: the base URL, since the SDK appends `/v2/public-decrypt` (a value ending in `/v2` is answered 404). The default is the SDK preset: `relayer.mainnet.zama.org` or `relayer.testnet.zama.org`. |
| `FROM_BLOCK` | Watcher discovery start on its first run (no state file yet). Set it to the deploy block. |

SDK wiring (`src/fhevm.ts`, `@zama-fhe/sdk` 3.6.0): chain 1 uses the `mainnet`
preset with `node()`, 11155111 uses `sepolia` with `node()`, and 31337 uses
`anvil` with `cleartext()`. `network` is always `RPC_URL`.

## CLI

```bash
npm run dms -- <command> …        # or, after `npm run build`: node dist/index.js <command> …
```

| Command | Who | |
| --- | --- | --- |
| `create <id> <intervalSec> <bountyEth> <plaintext>` | owner | Seals the secret, FHE-encrypts the key and creates the switch. Checks: interval 60 s – 365 d, plaintext ≤ 2048 bytes, bounty ≥ `minBounty`, id unused. |
| `create <id> <intervalSec> <bountyEth> --file <path>` | owner | Reads the secret from a file. `--file -` reads stdin. Prefer this: an inline secret ends up in shell history and `ps`. |
| `ping <id>` | owner | Proves you are alive and resets the deadline. |
| `cancel <id>` | owner | Only while alive. The key is never released, and your own escrow is refunded. Your own top-ups (`fund-bounty` on your switch) are contributions, not escrow: take them back afterwards with `reclaim <you> <id>`. |
| `rescue <id>` | owner | Recovers your escrow 30 days after dark with no reveal (`reclaimOwnerStake`). Your own top-ups come back with `reclaim <you> <id>`. |
| `fund-bounty <owner> <id> <amountEth>` | anyone | Adds to the bounty of a live switch. The contribution cannot be withdrawn while the owner keeps pinging, which can go on for years: it comes back only after a cancel, or if nobody releases the key within 30 days of a missed deadline; otherwise it goes to whoever releases the key. |
| `reclaim <owner> <id>` | funder | Takes back your contribution after a cancel, or during the rescue window. |
| `mark-dark <owner> <id>` | anyone | Use after the deadline: asks the KMS to make the key publicly decryptable. |
| `reveal <owner> <id> [--publish] [--out f]` | anyone | Gets the key and proof (one handle), verifies the tag, calls `revealKey` (which pays the bounty), then prints or saves the plaintext. `--publish` also posts it on-chain; if someone else published it first (`AlreadyPublished`), that is reported, not an error. `--out` creates the file before `revealKey` is sent, so an existing file or a bad path fails before any transaction. If someone else revealed first (`AlreadyRevealed`), it points you to `read`. If the reveal succeeded but writing `--out` or publishing then failed, it exits 3 with the reveal transaction and how to recover (`dms read … --out`, `dms publish`). |
| `read <owner> <id> [--out f]` | anyone | Decrypts a revealed switch from chain state alone and verifies the tag and the commitment. No key or FHE needed. |
| `publish <owner> <id>` | anyone | `publishPlaintext`, commitment-checked. Earns no bounty. |
| `info <owner> <id> [--json]` | anyone | Every field, with the state name and times relative to chain time. |
| `status [--json]` | anyone | Contract config: min bounty, oracle price and feed, admin and pending admin, limits, relayer, signer balance. The oracle price is the feed's raw answer scaled by the feed's own `decimals()` (any up to 36), and `--json` includes `feedDecimals`. |

Every write is simulated before it is sent. A revert is decoded from the
contract ABI and from Zama's host errors (`ACLNotAllowed`, `KMSInvalidSigner`,
`EnforcedPause`, and others), with a hint, for example
`reverted: NotDarkMarked — call mark-dark first; …`. A transaction that is
mined but reverts (because another transaction changed the state first) is
explained by replaying the same call at its block:
`revealKey transaction 0x… reverted on-chain in block N (gas used G): AlreadyRevealed — …`.
A node that no longer has that block's state (a non-archive node keeps about
128 blocks) fails the replay; the call is then replayed against the latest
block and the message says so, or ends in `replay failed: <error>` if that
fails too.
A transaction whose nonce another transaction from the same key took (cancelled
or replaced in a wallet that shares the key) is reported as a failure,
`ping transaction 0x… was cancelled by 0x… (same nonce, same key), so the call did not run`,
never as success; only a repriced copy of the same call counts. Transactions
are signed locally, so a broadcast whose answer the RPC loses (a gateway
timeout retried into "already known") still yields its hash.
Error text from the RPC node or the relayer is printed with control characters
escaped, like plaintext.
`reveal` stops retrying the KMS on HTTP 401/403 (it tells you to check
`ZAMA_RELAYER_API_KEY`) and on a second 404/405 in a row to the request that
starts the job, which means the relayer has no route at `ZAMA_RELAYER_URL` (it
tells you to check that; after the first one it asks again 3 s later, since an
edge reloading its routes can answer that for a second or two). A 400 is
retried: the relayer answers one (`not_allowed_on_host_acl`) until it has seen
the `markDark`. In error text
from the relayer SDK, `RPC_URL` is replaced and any other URL on its host is
cut down to the host, since an RPC URL can carry an API key in its path
(`…/v2/<key>`); other URLs (documentation links, the relayer) are left whole.

Every write's max fee is twice the latest base fee plus the tip (only the
base fee and the tip are paid), so a `ping` near its deadline survives several
full blocks of base-fee rises. The node checks gas × max fee + value against
your balance before it takes the transaction; if that fails at twice the base
fee, the write is sent once more at the usual 1.2 × base fee + tip, with a
note. A write that is not mined within 180 s is not lost: the error gives its
hash and nonce, says it may still be mined, and how to replace it. Before
sending, each write checks whether a transaction from your key is still
pending (the node's pending nonce is ahead of its mined one; read twice, since
behind a load balancer the two counts can come from nodes at different
heights):

- `create` and `fund-bounty` refuse, because the pending one may be the same
  command from a run that timed out, and both could be mined (two
  contributions, or a second switch for one secret). Check with `dms info`,
  then wait, use `--replace`, or pass `--queue` to send after it anyway.
- Any other write is sent after it, with a note.
- `--replace <hash>` (any write) sends this command at that pending
  transaction's nonce with fees at least 12.5% above its own and at least the
  market's, so it takes its place: for example `dms ping 1 --replace 0x…` after
  a ping timed out. The replaced transaction is then never mined. It must be
  your key's and not yet mined.

`create` on an id you already use says that switch exists (with its state and
deadline), since it is most likely an earlier `create` that timed out and was
mined after all, and tells you to ping or cancel it rather than create another
switch for the same secret.

Exit codes: 0 for success, 1 for a failure, 2 for a usage error, 3 when
`reveal` revealed the key and paid the bounty but writing `--out` or
publishing failed. Set `DMS_DEBUG=1` for stack traces.

Example (local):

```bash
npm run dms -- create 1 3600 0.01 --file secret.txt
npm run dms -- info 0xOwner 1
# … owner stops pinging; an hour passes …
npm run dms -- mark-dark 0xOwner 1
npm run dms -- reveal 0xOwner 1 --publish
npm run dms -- read 0xOwner 1 --out secret.bin
```

## Watcher

```bash
cp watcher.config.example.json watcher.config.json    # optional; the example holds exactly the defaults
npm run watcher                                        # daemon
npm run watcher -- --once                              # one pass; exit 1 if any action failed (cron-friendly)
npm run watcher -- --altruistic --publish              # ignore profitability; also publish plaintexts
npm run watcher -- --rescan-from 7000000 --once        # look for switches again from block 7000000
npm run watcher -- --help                              # every flag
```

`./watcher.config.json` is loaded automatically when it exists (or pass
`--config <file>`). Keys starting with `_` are comments. Beyond the example's
keys, `fromBlock`, `confirmations` and `switches` are optional; they are
explained in its `_discovery`, `_confirmations` and `_switches` comments.

The watcher exits 1 at startup when `PRIVATE_KEY` is missing, or when
`ZAMA_RELAYER_API_KEY` is missing on mainnet (chain 1), before it can pay
for a `markDark` it could never follow up. It also exits 1 when another
watcher uses the same state file, in this container or another, on this
machine or another sharing the file (NFS, a ReadWriteMany volume): an
overlapping cron `--once` run would otherwise send the same transactions again
and overwrite the other's records. Run one watcher per state file.

The state file is tied to one chain and contract. Moving the watcher to a new
deployment with the same `PRIVATE_KEY`: its old state file is refused, naming
the nonces it still has pending; a watcher with a fresh state file sends every
transaction behind those, and cannot re-price or free them. Run the old
watcher until its state file has no `pendingTx` left first, or use another
key. The first pass of each process logs a `WARNING` when transactions its
state file does not track hold the signer's next nonces, and so does a
transaction of its own stuck behind one.

`<stateFile>.lock` names its holder: pid, hostname, machine id (Linux
`/etc/machine-id`, hashed; none on macOS or in most containers), boot id (Linux
`boot_id`, macOS `kern.bootsessionuuid`), PID namespace (Linux) and process
start time. The holder refreshes a heartbeat, the file's modification time,
every 5 s from a timer, so also while it waits for a receipt or the KMS.
Another watcher judges the lock:

- by the pid when the pid means the same process to it (same boot, same PID
  namespace): a holder that is gone, or whose pid another process now has, is
  taken over at once; a running one never is, whatever the clocks say. An
  equal pid number in another namespace proves nothing (node is PID 1 in every
  container);
- as stale at once when this machine wrote it before its last boot (same
  machine id and hostname, another boot id). Without a machine id this rule is
  off, since two machines can share a hostname;
- otherwise (another container or machine) by watching its heartbeat for
  15 s (3 periods) on a monotonic clock, however fresh it looks. If it moves,
  the lock is in use and this watcher exits 1 at once; if it does not, the
  holder is gone and the lock is taken over. No wall clock is compared, so
  machines whose clocks differ, or a clock that jumped (a device without an
  RTC, set by NTP), make no difference. A container restarted after a kill or
  an OOM gets a new PID namespace, and takes its predecessor's lock over after
  those 15 s.

A stale lock is taken over through a claim file created exclusively (no hard
links, so it works on SMB/CIFS and FUSE mounts too): of several watchers
starting at once, exactly one gets it and the others exit 1. A takeover that
crashed half-way leaves a claim that the next start skips and then clears, so
it never blocks later starts. A watcher that finds its lock taken over (it was
frozen past the heartbeat bound, say) stops at once, sends nothing more and
does not write the state file; it exits 1. A lock written by an older watcher
(no heartbeat, no PID namespace) on the same boot is taken over at once when
its pid is this watcher's own (PID 1 in a container), is held while its pid
runs here, and is otherwise taken over after 15 s, since it never moves: stop
older watchers before starting this one on their state file. The "in use"
error says how to check that no watcher runs before deleting the lock by hand.
SIGINT/SIGTERM stop it at the current step (discovery included), abort
in-flight KMS requests and save progress.

Each pass:

1. **Discovery.** Scans `SwitchCreated` logs with chunked `eth_getLogs`. The
   first run starts at `FROM_BLOCK` (or `fromBlock`, or `--from-block`); later
   runs resume after the state file's `lastScannedBlock`, so the start block
   can stay configured; a pass with new blocks scans up to 64 blocks below it
   again (not on Anvil), never below the first block scanned, so a
   `SwitchCreated` log that a reorganisation deeper than `confirmations` moved
   into a scanned range (or that a node lagging behind the head had not served
   yet) is still found. Only as many as fit in one request with the new blocks
   are scanned again, so a provider that caps the range (below) is not asked
   for several more requests every pass. A startup `note:` appears only if it is lowered below
   the block the state file first scanned from. `--rescan-from <block>` scans
   again from that block to the head on the first pass, without moving
   `lastScannedBlock` backwards (not allowed with `--no-discover`). It only
   ever moves the start back: given a block above `lastScannedBlock` + 1, it
   logs that discovery starts at the first unscanned block, so nothing is
   skipped. Errors are judged by the node's own message and code (never the
   request URL or body viem adds). A transient provider error (HTTP 429,
   timeout, network, 5xx) ends the scan for the moment: the pass handles its
   switches first, then retries the same range after 1, 2, 4, 8 and 16 s, and
   then counts it as a discovery error (switches found then are handled next
   pass). A node without the blocks' history ("pruned", code 4444) is asked
   again at once, twice, since another backend of a load-balanced RPC may have
   them; then it is a configuration error naming `FROM_BLOCK` (the start block
   is below what the RPC keeps: set it to the deploy block, on an RPC that has
   the blocks from there), reported every pass, and that range is asked for
   again only after `backoffBaseSec`, doubling up to `backoffMaxSec`
   (`logsUnavailable` in the state file). A range or result-size error (or
   anything unrecognised) halves the chunk, which doubles again after 4
   successful requests, up to `logChunkBlocks`; a doubled size refused again
   is tried only after twice as many (at most 64). The working chunk size and
   that count are kept in the state file, so a reduced chunk grows back across
   passes and processes.
   Progress is saved every 20 chunks. The scan stops `confirmations`
   blocks behind the head (0 on Anvil, 2 elsewhere), which only delays
   discovery. Switches listed under `switches` in the config are watched as
   well.
2. **Decision.** For each switch, a transaction left unresolved by an earlier
   pass or process is settled first, in nonce order (see *Transactions*
   below). Then the pure `decide()` in `src/watcherCore.ts` (unit-tested)
   picks the next action from the on-chain state, judged by chain time. Each
   switch that is due is read once and takes every step that sends nothing
   (waiting, archiving, done); the steps that send a transaction (`markDark`,
   `revealKey`, `publishPlaintext`) then go out highest bounty first (at the
   same bounty a reveal before a `markDark`, then discovery order). Each one
   waits for its receipt, so a backlog of low-bounty switches (spam timed to go
   dark just before another switch, say) cannot hold up one worth more: to
   delay it, each must carry at least its bounty, which goes to whoever
   reveals. Switches still under an unprofitable or backoff verdict are read
   after the transactions, so a backlog of them does not delay any either.
   After a broadcast (or 12 s), chain time is read again, and a switch that
   went dark meanwhile is read and queued in the same pass; so are dark
   switches read while `markDark` was paused (below), once a public decryption
   works again. A pending transaction the node dropped (or whose nonce another
   took) is forgotten and its switch handled at once, in nonce order, since its
   nonce may be a gap that holds up every later one.

   | State | Action |
   | --- | --- |
   | `ALIVE` | Wait until the deadline. No reads before then. |
   | `DARK` | `markDark`, but only if the bounty covers `markDark` gas plus `revealGasEstimate` × gas price × `safetyFactor` (+ `minProfitEth`). Paused for `backoffMaxSec` while the relayer refuses public decryption (see below). |
   | `DARK_MARKED` | Check profitability on `revealGasEstimate` first, so an unprofitable switch never reaches the KMS. Public-decrypt the key (one handle; `decryptAttemptsPerPass` tries, honouring the relayer's `Retry-After` up to `backoffMaxSec`, then exponential backoff). `decryptPassBudgetSec` caps the time one pass spends on KMS requests and the waits between retries; switches left over wait for the next pass. Verify the AES-GCM tag, warning on a mismatch but still revealing. Check profitability on the exact `revealKey` gas estimate, then call `revealKey`. |
   | `REVEALED` | Decrypt from chain and archive it (below). If the key does not open the ciphertext, only the `.json` (`keyMismatch: true`) is written. With `publish`, then call `publishPlaintext`. Done once final (below). |
   | `CANCELLED` | Never again, once final (below). |

   A revealed (or cancelled) switch is done only once the `finalized` block
   shows the same state (at once on Anvil). Until then it is read again each
   pass, so a reorganisation that drops a reveal (the watcher's or anyone's),
   a publish or a cancel is noticed (`WARNING: state went back from … to …`)
   and the switch handled from there. A read showing an earlier state came
   from a node behind, not a reorganisation, when what moved the switch on is
   still on the chain: the watcher's own transaction for the later state is
   mined (or known to the node), the finalized block shows the later state, or
   its event (`KeyRevealed`, `SwitchDarkMarked`, `SwitchCancelled`, whoever
   sent it) is between the finalized block and the head. Such a read is
   ignored until the next pass, so no transaction that can only revert is
   sent. If those checks cannot be made, the read is taken as it is. Once final, each
   transaction booked from its first receipt (`markDarkTx`, `revealTx`,
   `publishTx`) is checked on the final chain: one that reverted there (a lost
   race) is unbooked with a `WARNING`. No receipt proves nothing by itself (the
   node answering may lack it): the action's event decides (`KeyRevealed`,
   `SwitchDarkMarked`, `PlaintextPublished`, searched from 64 blocks below the
   first receipt booked, `bookedBlock`). If it names the watcher, the booking
   stands, moved to that event's transaction if a reorganisation included an
   earlier broadcast of the same nonce instead; if it names someone else, it
   is unbooked with a `WARNING`; with no event found, it is kept. The search
   goes in discovery's working chunk size, halved on a range error, a pruned
   range asked for again once; one that fails is an error and is tried again
   next pass, and after 3 failed passes it is given up with a `WARNING`: the
   booking is kept and the switch is done (`eventSearchFailures` counts them).
   Then the archive record is brought in line.

   An "unprofitable" verdict holds back only `markDark` and `revealKey`, never
   archiving or publishing. When a switch's on-chain state changes, its
   backoff, profit timer and note are reset.
3. **State.** Progress is written to `stateFile` (default `./watcher-state.json`,
   written atomically): `lastScannedBlock` and `firstScannedBlock`, the
   getLogs chunk size (`logChunkBlocks`, `logChunkSuccesses`,
   `logChunkGrowAfter`, `logChunkProbing`), a range the node does not serve
   (`logsUnavailable`), the relayer pause (`decryptBroken`, below), and per
   switch the attempts, backoff, txs (and `bookedBlock`,
   `eventSearchFailures`), `pendingTx`, `lostRaces` and notes. It is written
   right after each
   broadcast (before waiting for the receipt), and otherwise once at the end of
   a pass (at most every 5 s during a long one), only when something changed:
   each write serialises the whole state. The file is
   bound to one chain and contract. A restart resumes from it. Verdicts of
   "unprofitable" are cleared on restart, because the policy or gas price may
   have changed; so is "done" for a switch archived while `publish` was off,
   so a run with `publish` publishes it. A switch whose state keeps moving for
   8 steps in one pass is logged and left for the next pass.

**Archive.** Plaintexts go to
`<outDir>/<chainId>-<contract>/<owner>-<id>.bin` (contract and owner in
lowercase, mode 0600), with a `.json` record written last (`revealedKey`,
`revealTx`, `revealedByUs`, `lostRaces`, `keyMismatch`, `commitmentMatches`,
…). Files are created with `O_EXCL` and never overwritten: if files for the
same switch and key are already there, the switch counts as archived; any
other clash is written as `<owner>-<id>.N.*` with a `WARNING` in the log.
The one exception: once the switch is final, its own `.json` is rewritten
(atomically, with `amendedAt`) if a reorganisation changed `revealTx`,
`revealedByUs` or `lostRaces` since it was written.

**Transactions.** The watcher simulates each call, then sends it with an
explicit nonce and explicit EIP-1559 fees (capped by `maxGasPriceGwei`), and
records it as `pendingTx` in the state file before waiting. It waits up to
`txReceiptTimeoutSec` (default 120) for the receipt; a timeout counts as
pending, not as an error. On the next pass (or in the next process) the
pending transaction is resolved first (switches with one pending go first, in
nonce order): its receipt if one of its broadcasts was mined; void if another
transaction took the nonce; left alone while it is younger than
`txReceiptTimeoutSec`; forgotten, and the switch handled afresh (which refills
the nonce), when the node no longer knows it (dropped); otherwise replaced with the same nonce
and fees +12.5% or the market rate, whichever is higher, capped by
`maxGasPriceGwei` (if the cap leaves no room, it waits and says so). Fees are
raised only for a transaction that is next to be mined, or behind ones that
are being mined: behind a nonce that is not (a gap, a transaction the node
dropped, a held-back transaction, or one priced below the base fee) no fee
helps, so it keeps its own fees and counts as held back. A `publishPlaintext`,
or a self-transfer freeing the nonce of a call that would now revert, earns
nothing: its fees follow the market up and never go above the current market
rate, except to match a market tip that has risen above its own, or to turn a
call that would now revert into a self-transfer. A
`markDark` or `revealKey` is re-sent only while the bounty still covers its
gas at the new fees, by the same `safetyFactor` / `minProfitEth` rule as the
first send (`markDark` counts its gas plus `revealGasEstimate`); otherwise it
is held back: the original stays pending at its own fees (it can still be
mined if fees fall), is reported as unprofitable and is checked again after
`unprofitableRecheckSec`. A held-back transaction holds the signer's nonce,
and nonces are mined in order. It is given up, and a 0-value self-transfer
frees its nonce (21,000 gas at the replacement fees, capped by
`maxGasPriceGwei`), only for a later `markDark` / `revealKey` worth mining:
one pending for another switch, or one the watcher is about to send, whose
bounty covers its own gas plus the self-transfers needed in front of it, by
the same rule. A later transaction is valued at its own fees when they still
cover the latest base fee (it is mined at them once the nonces in front are
freed), otherwise at its replacement fees. A held-back transaction whose own
max fee covers the base fee again is never given up: it is simply mined. Anything else waits behind it: a `markDark` /
`revealKey` that cannot pay for that (its own replacements stay bounded by its
bounty), and a `publishPlaintext` or a self-transfer cancelling a call that
would now revert, whose fees are not raised meanwhile. A transaction the
watcher did not send cannot be valued: for one, each self-transfer may cost no
more than the transaction whose nonce it frees was allowed to cost when sent.
The fees of a stuck self-transfer that gave up an action are raised only on
the same terms. A held-back transaction the node has dropped is noticed: the
switch is re-read and the action sent again at market fees, if they pay. If
the call would now revert, a 0-value self-transfer frees the nonce instead (no
profit check). If an earlier broadcast is mined while a replacement is being
sent, its receipt decides the outcome (mined, or a lost race), not the node's
error. A transaction the watcher sent whose nonce another transaction from
its key took (say, a wallet's "cancel") is void: the switch is re-read and
handled from its state. Give the watcher a signer that nothing else uses.

**Lost races.** `revealKey` calldata is public and can be front-run, which is
how the key gets delivered: whoever lands first is paid. When someone else's
`markDark` or `revealKey` wins, the watcher re-reads the switch and carries
on, archiving the plaintext if it is now revealed. If the race was lost
before sending (the simulation reverts `AlreadyDarkMarked` or
`AlreadyRevealed`), nothing was spent. If it was lost on-chain (both landed in
the same block and the watcher's transaction reverted, decoded by replaying
the call at that block, or at the latest block if the node has pruned that
block's state), it is logged, counted as `lost races` in the pass
line and kept under `lostRaces` in the state file and the archive record. A
lost race is not an error and does not change the `--once` exit code.

**Relayer errors.** HTTP 401/403, two 404/405 answers in a row with no typed
relayer error to the request that starts the job (no route: a wrong
`ZAMA_RELAYER_URL` path; after one, the watcher asks again 3 s later, within
`decryptPassBudgetSec`, since an edge reloading its routes can answer that for
a second or two; with no budget left for the wait, one answer alone does not
count), and SDK configuration errors from
public decryption count as errors (`--once` exits 1) and pause `markDark` for
`backoffMaxSec` from the latest such failure, since the watcher could not
follow it up. The pause is kept in the state file (`decryptBroken`), so
separate `--once` runs honour it too. It ends sooner when a public decryption
succeeds, or when `ZAMA_RELAYER_URL` or `ZAMA_RELAYER_API_KEY` change: the
next start logs `relayer settings changed … markDark is no longer paused`.
The state file stores only a 16-hex-digit SHA-256 prefix of the chain id,
relayer URL and API key, never the key. While the key stays wrong, each lapse
of the pause lets about one more `markDark` out, whose failed reveal renews
the pause. Every other failure is treated as "the KMS has not served the key
yet": counted as pending and retried with backoff. That includes every HTTP
400: the SDK reports them all as `NO_CIPHERTEXT`, and the relayer answers one
(`not_allowed_on_host_acl`) until it has seen the `markDark`.

**Output.** Under `--once`, and in the daemon whenever a pass marked,
revealed, published, lost a race or hit an error:

```
pass: polled N, marked N, revealed N, saved N, published N, lost races N, unprofitable N, pending N, errors N
```

Profitability uses the EIP-1559 `maxFeePerGas`, a conservative figure.
`maxGasPriceGwei` is a hard cap that also applies in altruistic mode.

## Local end-to-end test

```bash
../scripts/local-e2e.sh                 # ANVIL_PORT=8545 by default
```

The script is idempotent, and any failure exits non-zero with a message naming
the step that failed. It:

1. starts `anvil` (chain 31337), or reuses one that is already listening;
2. installs `forge-fhevm`'s Soldeer dependencies if they are missing, then runs
   its `deploy-local.sh` (skipped when the host is already at the canonical
   addresses);
3. deploys a fresh `DeadManSwitch` with `forge script`;
4. runs `npm run e2e:local` (`src/e2e.ts`):
   - **(a)** create → fund → ping → early public decrypt refused (also `NotDark`
     and `NotDarkMarked`) → warp → `Expired` everywhere → mark-dark → forged
     proof and wrong key rejected → `reveal --out <existing file>` fails with
     the switch still `DARK_MARKED` → reveal (whole pot paid, tag and commitment
     verified, control characters escaped) → `read` with no key → `--out` exact
     bytes → publish (event payload checked, second publish rejected) → the real
     binary as a subprocess (`info`, `read`, exit codes, `status --json`);
   - **(b)** cancel path: refund of the owner escrow only → warp → `markDark`
     reverts `NotActive` → the key is never publicly decryptable → funder
     reclaims;
   - **(c)** `watcher --once --publish` discovers three dark switches. It
     reveals and publishes the profitable one, skips the zero-bounty one as
     unprofitable, and reveals the switch whose ciphertext was sealed under a
     different key than the FHE one, printing the key-mismatch warning. A second
     `--altruistic` pass resumes from the state file and reveals the zero-bounty
     switch.
   - **(d)** races, with automine off: a competitor with a higher tip front-runs
     the watcher's `markDark`, then its `revealKey`, in the same block. Both of
     the watcher's transactions revert on-chain; it decodes them
     (`AlreadyDarkMarked`, `AlreadyRevealed`), reports `lost races 2 … errors 0`,
     exits 0 and archives the exact plaintext with `revealedByUs: false` and
     both races recorded. With automine back on, a switch created between two
     `--once` passes is discovered by the second.

`e2e:local` calls `evm_increaseTime` and toggles `evm_setAutomine`, so point it
only at a node you control. It uses Anvil accounts 5–8.

## Development

```bash
npm run build       # tsc → dist/
npm test            # vitest (264): envelope vector + bounds + tamper, watcher decide/profit/config, the watcher I/O loop on an in-memory chain and KMS (test/watcherStub.ts), the state-file lock across real processes (test/lockContender.ts), CLI args, CLI commands against a fake JSON-RPC node that takes signed transactions (test/cliChain.ts), sanitizer, config/SDK wiring, ABI sync, error decoding, revert replay (test/chain.test.ts)
npm run typecheck   # tsc over src + test
npm run abi         # regenerate src/abi.ts from ../contracts/out (after `forge build`); test/abi.test.ts fails on drift
```

| File | |
| --- | --- |
| `src/envelope.ts` | v1 seal/open (Node WebCrypto), commitment, size limits, `verifyKeyOpensCiphertext`. |
| `src/fhevm.ts` | Zama SDK factory per chain; `encryptDek`, `publicDecryptDek` (single handle, result validated). |
| `src/chain.ts` | viem clients and typed wrappers for every contract function: simulate, send, receipt, events. |
| `src/config.ts` | Env parsing and validation (`CHAIN_ID` ∈ {1, 11155111, 31337}). |
| `src/errors.ts` | Revert decoding (contract and host errors) with hints; `TxRevertedError` (mined but reverted, decoded by replay) and `TxTimeoutError`. |
| `src/sanitize.ts` | Terminal-safe rendering of untrusted plaintext. |
| `src/args.ts`, `src/cli.ts`, `src/index.ts` | CLI parsing, commands, entry point. |
| `src/watcherCore.ts`, `src/watcher.ts` | Watcher: pure decision and profit logic, then the I/O loop. |
| `src/e2e.ts` | Local lifecycle tests. |
| `src/abi.ts` | Generated from the forge artifact. Do not edit. |

## Security notes

- **Trust.** Confidentiality before `markDark` rests on Zama's KMS threshold and
  on FHE. The "has the owner gone dark?" check is Ethereum consensus. Liveness
  and reveal integrity also rest on Zama's host governance, which can pause or
  deny-list contracts and can change the KMS signer set. Depositors can rescue
  their funds after 30 days. See `../ARCHITECTURE.md`.
- `create` wipes the data key from memory after encrypting it (best effort) and
  never writes it to disk. The owner needs nothing locally to keep the switch
  alive, only `ping`.
- `info`, `read` and `status` need no private key. Do not put a funded key on a
  machine that only reads.
- The relayer API key belongs on servers and CLIs, not in browsers.
