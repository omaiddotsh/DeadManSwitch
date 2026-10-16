# Production setup — Sepolia, then Ethereum mainnet

Runbook for deploying and operating `DeadManSwitch` on Zama fhEVM. Deploy to
Sepolia first, soak it, get the external audit, then repeat the same steps on
mainnet.

> **Nothing here has been run against a public network yet.** The deploy and
> check commands were exercised locally where possible: `Deploy.s.sol` signing with
> an encrypted keystore (`--account … --sender …`) with `NEW_ADMIN` set,
> `acceptAdmin` from the new admin, the Makefile's mainnet guards, the script's
> chain-1 guards and strict environment parsing (`contracts/test/Deploy.t.sol`),
> `make deploy-sepolia` with a keystore through forge's password prompt and
> through a password file (Foundry 1.5.1, Anvil with chain id 11155111 and a
> mock feed at the Chainlink address, `VERIFY=0`), and the host and
> post-deploy `cast call` checks against Anvil + Zama's forge-fhevm host.
> Etherscan verification, Ledger signing and anything that talks to the
> relayer were not, and the items in [§9](#9-pre-mainnet-checklist) stay open
> until someone runs them for real.

> **For operators.** `next build` fails without `NEXT_PUBLIC_RPC_URL_<id>` on
> a chain with a deployment (`ALLOW_PUBLIC_RPC=1` overrides it for throwaway
> builds). A redeploy on the same chain keeps the old address in
> `NEXT_PUBLIC_PREVIOUS_CONTRACTS_<id>`
> ([§6, Redeploying on the same chain](#redeploying-on-the-same-chain)).
> Compiled-in deployments live in `frontend/lib/deployments.json`. The
> frontend is Next.js 16, built with webpack (`npm run build`), for Chrome,
> Edge and Firefox 111+ and Safari 16.4+. The watcher's RPC must support the
> `finalized` block tag (§7).

Versions, host addresses and SDK calls: [docs/fhevm-api-pins.md](./docs/fhevm-api-pins.md).
Design and trust model: [ARCHITECTURE.md](./ARCHITECTURE.md).

## 1. Key hygiene

| Key | Rule |
| --- | --- |
| Mainnet deployer | Hardware wallet (`LEDGER=1` / `--ledger`) or an encrypted Foundry keystore (`ACCOUNT=` / `--account`). **Never** a raw key. `make deploy-mainnet` and `Deploy.s.sol` refuse the `PRIVATE_KEY` environment variable on chain 1, but nothing detects a key passed on the `forge script` command line (`--private-key`, `--mnemonics`, `--interactives`): never pass one. The deployer only deploys and starts the admin transfer; it holds nothing afterwards. |
| Admin | A multisig (e.g. a Safe), set with the two-step `transferAdmin` → `acceptAdmin`. The admin can only change `minBountyUsd` (capped at $10,000), but it should still not be a hot key. |
| Watcher signer | A separate hot key with a small gas balance. Sweep earnings out regularly. |
| `ZAMA_RELAYER_API_KEY` | Server-side only: the frontend server's environment (no `NEXT_PUBLIC_` prefix) and the CLI/watcher `.env`. Never in a browser bundle, never committed. |
| `.env`, `.env.local`, `*.key` | Already in `.gitignore`. Keep it that way. |

`contracts/script/Deploy.s.sol` signs with the keystore or Ledger given to
`forge script` (`--account` / `--ledger` plus `--sender`), and uses a raw key
from the `PRIVATE_KEY` environment variable only when one is set: fine for
local and throwaway testnet keys, refused on chain 1. forge also reads
`PRIVATE_KEY` from `contracts/.env`; when a `--sender` is given, the key must
be that sender's, or the script stops before broadcasting, so a stray key
never signs in place of the keystore. On chain 1 it also
requires `NEW_ADMIN`, so the admin role goes to the multisig in the same run.
The script sees only its environment, not the `forge script` command line: a
key given as `--private-key`, `--mnemonics` or `--interactives` is not
detected and would deploy mainnet with a hot key. Never pass one. The Makefile
targets wrap the script and never put a key on the command line:

| Target | Signer | Refuses to run unless |
| --- | --- | --- |
| `make deploy-sepolia` | `ACCOUNT=<keystore>` or `LEDGER=1`, with `SENDER=<address>`; or `PRIVATE_KEY` (throwaway key) | `SEPOLIA_RPC_URL` and a signer are set, `SENDER` unless `PRIVATE_KEY` is, and `PRIVATE_KEY` is not set together with `ACCOUNT`/`LEDGER` (the script would sign with it) |
| `make deploy-mainnet` | `ACCOUNT=<keystore>` or `LEDGER=1`, with `SENDER=<address>` | `PRIVATE_KEY` is unset and `ETH_RPC_URL`, `SENDER`, `NEW_ADMIN` are set |

These checks look at `contracts/.env` too, which forge also reads: a
`PRIVATE_KEY` there counts as set, and any `ETH_PASSWORD` there is refused.

Both broadcast and, unless `VERIFY=0`, verify on Etherscan; they refuse to run
when verification is on and `ETHERSCAN_API_KEY` is empty. With `ACCOUNT=`,
forge asks for the keystore password. `ETH_PASSWORD` is forge's
`--password-file`: the path of a file holding the password, never the password
itself (forge would print it in its error), and both targets refuse to run
while it holds anything but a readable regular file. Either type the password
at forge's `Enter keystore password:` prompt, or hand forge a private file
that is removed when the deploy ends (forge accepts only a regular file, not a
pipe such as `<(…)`):

```bash
(
  pw="$(mktemp)" || exit 1            # mode 0600, in your per-user temp directory
  trap 'rm -f "$pw"' EXIT
  <password manager command that prints the password> > "$pw" || exit 1   # e.g. security find-generic-password -s <service> -w
  ETH_PASSWORD="$pw" make deploy-sepolia ACCOUNT=dms-deployer SENDER=<keystore address>
)
```

Both put `NEW_ADMIN` into the `forge script` command itself, so the command
`make` echoes is complete. To print that command without running it, use
`make -n` with the same arguments; plain `make` runs it. `make -n` also prints
the guard lines (without running them) and leaves `$SEPOLIA_RPC_URL` /
`$ETH_RPC_URL`, `$ETHERSCAN_API_KEY` and `${MIN_BOUNTY_USD:-1000000000}` for
your shell to expand.

Create a keystore once:

```bash
cast wallet import dms-deployer --interactive    # prompts for the key and a password; stored in ~/.foundry/keystores
cast wallet list
```

## 2. Inputs

| Input | Sepolia (11155111) | Mainnet (1) |
| --- | --- | --- |
| RPC | your provider's Sepolia URL | your provider's mainnet URL |
| Chainlink ETH/USD feed (`ETH_USD_PRICE_FEED`) | `0x694AA1769357215DE4FAC081bf1f309aDC325306` | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` |
| `MIN_BOUNTY_USD` (8 decimals, plain digits: `Deploy.s.sol` aborts on values it cannot parse, such as `25_00000000` or `$25`) | `1000000000` ($10, the Makefile default) | Decide from §9: must cover `markDark` + `revealKey` gas at stressed gas prices plus any Zama fee. `0` disables the floor. |
| `MAX_PRICE_AGE` (seconds) | `7200` (script default) | `7200` = twice a 1-hour heartbeat (the mainnet ETH/USD feed's heartbeat at the time of writing; confirm on data.chain.link at deploy time). |
| Zama ACL | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` | `0xcA2E8f1F656CD25C01F05d0b243Ab1ecd4a8ffb6` |
| Zama executor | `0x92C920834Ec8941d2C77D188936E1f7A6f49c127` | `0xD82385dADa1ae3E969447f20A3164F6213100e75` |
| Zama KMSVerifier | `0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A` | `0x77627828a55156b04Ac0DC0eb30467f1a552BB03` |
| Zama relayer | `https://relayer.testnet.zama.org` | `https://relayer.mainnet.zama.org` |
| Expected `confidentialProtocolId()` | `10001` | `1` |

The host addresses are compiled into the contract through `ZamaEthereumConfig`;
they are listed here only for the checks below. The floor fails open: if the
feed is unusable, `minBounty()` returns 0 instead of reverting, so a too-tight
`MAX_PRICE_AGE` merely disables the floor more often, and a too-loose one lets a
stale price set it.

## 3. Pre-deploy checks

```bash
export RPC=<rpc url>
export FEED=<feed from §2>; export ACL=<acl>; export EXEC=<executor>; export KMS=<kms verifier>

cast chain-id --rpc-url $RPC                                   # 11155111 or 1
for a in $ACL $EXEC $KMS $FEED; do cast code $a --rpc-url $RPC | head -c 10; echo " $a"; done   # all non-empty
cast call $EXEC "getVersion()(string)" --rpc-url $RPC          # @fhevm/solidity 0.11.1 needs executor >= 0.3.0
cast call $ACL  "getVersion()(string)" --rpc-url $RPC
cast call $KMS  "getVersion()(string)" --rpc-url $RPC
cast call $KMS  "getThreshold()(uint256)" --rpc-url $RPC        # record it
cast call $KMS  "getKmsSigners()(address[])" --rpc-url $RPC     # record the count
cast call $ACL  "owner()(address)" --rpc-url $RPC               # record who governs the host (EOA? multisig? timelock?)
cast call $ACL  "paused()(bool)" --rpc-url $RPC                 # false
cast call $FEED "decimals()(uint8)" --rpc-url $RPC              # 8
cast call $FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url $RPC   # updatedAt recent
```

The host getter names come from the forge-fhevm host source and were checked
on the local host (`ACL v0.3.0`, `FHEVMExecutor v0.3.0`, `KMSVerifier v0.2.0`)
and on Sepolia (read 2026-10-13: `ACL v0.4.0`, `FHEVMExecutor v0.5.0`,
`KMSVerifier v0.3.0` with 13 signers and threshold 7; see
[docs/fhevm-api-pins.md](./docs/fhevm-api-pins.md#sepolia-host-read-2026-10-13)).
Read them again at deploy time, since the host is upgradeable, and record
every answer in `docs/fhevm-api-pins.md`.

Build and test exactly what you deploy:

```bash
cd contracts
forge soldeer install          # pinned by soldeer.lock
forge fmt --check && forge build --sizes && forge test
git status                     # clean tree; note the commit hash
```

## 4. Deploy to Sepolia

Rehearse the mainnet procedure (keystore or Ledger, multisig admin):

```bash
export SAFE=<admin multisig address>
export DEPLOYER=$(cast wallet address --account dms-deployer)   # the keystore's address
export SEPOLIA_RPC_URL=$RPC ETHERSCAN_API_KEY=<key>
cd contracts
make deploy-sepolia ACCOUNT=dms-deployer SENDER=$DEPLOYER NEW_ADMIN=$SAFE
#   or, with the Ledger: make deploy-sepolia LEDGER=1 SENDER=<Ledger address> NEW_ADMIN=$SAFE
# prints "DeadManSwitch deployed at: 0x…", admin = the deployer, pendingAdmin = $SAFE

R=broadcast/Deploy.s.sol/11155111/run-latest.json
export DMS=$(jq -r '.transactions[] | select(.transactionType == "CREATE") | .contractAddress' $R)
cast to-dec $(jq -r '.receipts[] | select(.contractAddress != null) | .blockNumber' $R)   # deploy block → FROM_BLOCK everywhere

# then, from the Safe: call acceptAdmin() on $DMS
```

The app's `/admin` page can send `acceptAdmin()` from a Safe connected over
WalletConnect. Writes from a contract account are followed through the wallet
(EIP-5792 `wallet_getCallsStatus`, then the wallet's receipt) and count as done
only when the receipt shows the write's own event from the contract
(`AdminTransferred` here) and no Safe `ExecutionFailure`; otherwise the page
says to check the wallet. This has not been tried with a real Safe yet:
confirm with `cast call $DMS "admin()(address)"`.

The script deploys and calls `transferAdmin($SAFE)` in the same run (two
transactions); the deployer is admin only until the Safe accepts. `LEDGER=1`
signs with the Ledger's first account, as on mainnet (§6 covers other
accounts). Quicker alternative for a throwaway testnet key only:
`PRIVATE_KEY=0x<fresh testnet key> make deploy-sepolia NEW_ADMIN=$SAFE`.

If `--verify` fails, verify separately:

```bash
forge verify-contract $DMS src/DeadManSwitch.sol:DeadManSwitch --chain sepolia --watch \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,uint256,uint256)" $FEED 1000000000 7200)
```

Post-deploy checks:

```bash
cast call $DMS "confidentialProtocolId()(uint256)" --rpc-url $RPC   # 10001 (Sepolia) / 1 (mainnet)
cast call $DMS "admin()(address)" --rpc-url $RPC                    # the Safe, after acceptAdmin
cast call $DMS "pendingAdmin()(address)" --rpc-url $RPC             # 0x0 after acceptAdmin
cast call $DMS "ethUsdPriceFeed()(address)" --rpc-url $RPC
cast call $DMS "maxPriceAge()(uint256)" --rpc-url $RPC
cast call $DMS "minBountyUsd()(uint256)" --rpc-url $RPC
cast call $DMS "oraclePrice()(bool,uint256)" --rpc-url $RPC         # (true, price)
cast call $DMS "minBounty()(uint256)" --rpc-url $RPC                # floor in wei, > 0
```

## 5. Sepolia soak

1. No relayer API key is needed: Zama's Sepolia relayer is open. Only mainnet
   needs a key ([apply here](https://docs.zama.org/protocol/sdk/guides/relayer-api-keys)).
2. CLI round trip (`client/.env`: `CHAIN_ID=11155111`, `RPC_URL`, `DMS_ADDRESS`,
   `PRIVATE_KEY` of a test account, `FROM_BLOCK`):

   ```bash
   cd client
   npm run dms -- status
   npm run dms -- create 1 60 0.01 --file test-secret.txt    # 60 s interval; bounty must be ≥ minBounty (see status)
   npm run dms -- info 0xOwner 1
   # wait > 60 s
   npm run dms -- mark-dark 0xOwner 1
   npm run dms -- reveal 0xOwner 1 --publish                  # tries 3 times; if the KMS is still working, rerun later
   npm run dms -- read 0xOwner 1
   ```

   Also exercise `ping`, `fund-bounty`, `cancel` + `reclaim`.
3. Frontend on a staging deployment ([RAILWAY-DEPLOY.md](./RAILWAY-DEPLOY.md)):
   create from a browser (watch the key download, about 4.6 MB), hunt and
   reveal from a second wallet, read from a third browser with no wallet.
4. Run the watcher (§7) for at least a week against 1-minute and 1-hour
   switches, with nobody revealing by hand. Include a run with a low
   `maxGasPriceGwei` or a short `txReceiptTimeoutSec` so that a transaction
   gets stuck and replaced: replacement has only been tested against an
   in-memory chain stub, and lost races only on Anvil.
5. Record in `docs/fhevm-api-pins.md`: gas of `createSwitch` (small and 2 KB),
   `markDark`, `revealKey`, `publishPlaintext`; latency from `markDark` to a
   servable proof; any relayer errors and their shapes; any Zama fees charged.
6. Feed the measured gas into `client/watcher.config.json` (`revealGasEstimate`)
   and `frontend/components/gas.ts` (public-chain margins), and choose the
   mainnet `MIN_BOUNTY_USD`.

## 6. Deploy to mainnet

Only after §9 is complete. Same as §4 with the mainnet inputs and a Ledger
(or the keystore):

```bash
unset PRIVATE_KEY                               # make deploy-mainnet refuses to run while it is set
export SAFE=<admin multisig address> ETH_RPC_URL=$RPC ETHERSCAN_API_KEY=<key>
export MIN_BOUNTY_USD=<from §9, 8 decimals>     # unset = 1000000000 ($10)
cd contracts
make deploy-mainnet LEDGER=1 SENDER=<Ledger address> NEW_ADMIN=$SAFE
#   or: make deploy-mainnet ACCOUNT=dms-deployer SENDER=$DEPLOYER NEW_ADMIN=$SAFE

R=broadcast/Deploy.s.sol/1/run-latest.json
export DMS=$(jq -r '.transactions[] | select(.transactionType == "CREATE") | .contractAddress' $R)
cast to-dec $(jq -r '.receipts[] | select(.contractAddress != null) | .blockNumber' $R)   # deploy block

# from the Safe: acceptAdmin() on $DMS
```

The mainnet feed (`0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`) and
`MAX_PRICE_AGE` 7200 are set for you. `LEDGER=1` signs with the Ledger's first
account (index 0). For another account, print the command without running it,
`make -n deploy-mainnet LEDGER=1 SENDER=<that address> NEW_ADMIN=$SAFE` (plain
`make` would run it), then run its last command (`NEW_ADMIN=… forge script …`)
with `--mnemonic-derivation-paths "m/44'/60'/0'/0/<n>"` (or your wallet's path)
added. The same works for `deploy-sepolia`. Run the post-deploy checks from §4
(`confidentialProtocolId()` must be `1`; `pendingAdmin()` is the Safe until it
calls `acceptAdmin()`, then `admin()` is the Safe and `pendingAdmin()` is 0),
then publish the address and deploy block in the README.

**Admin decision.** Keep the admin on the multisig (recommended) so the floor
can follow gas prices and fees. Renouncing does not make
`createSwitch` safe from the oracle. A dead, stale, reverting or code-less feed
fails open (floor 0), but a live feed reporting an absurdly low price, or one
whose decimals change, makes `minBounty()` huge and blocks every new switch.
Only the admin can then set the floor to 0; after `renounceAdmin()` nobody can,
so creation stays blocked for as long as the feed misbehaves, and the floor can
never change again. If you renounce anyway, set `minBountyUsd` to 0 first (the
floor is then never read).

### Point the frontend and clients at a deployment

Same for Sepolia (`<id>` = 11155111) and mainnet (`<id>` = 1). Hosting details:
[RAILWAY-DEPLOY.md](./RAILWAY-DEPLOY.md).

| Where | Variable | Kind |
| --- | --- | --- |
| Frontend | `NEXT_PUBLIC_CONTRACT_<id>` | public, build time **and** runtime: the current deployment, the one creates go to (the relayer proxy relays input proofs only for this address) |
| Frontend | `NEXT_PUBLIC_FROM_BLOCK_<id>` | public, build time: the deploy block |
| Frontend | `NEXT_PUBLIC_RPC_URL_<id>` | public, build time: a provider URL (it ships in the bundle). **Required**: `next build` fails without it on a chain with a deployment. Its `eth_getLogs` must accept `NEXT_PUBLIC_LOGS_RANGE_CAP` blocks per call (default 5000) back to the deploy block. `ALLOW_PUBLIC_RPC=1` builds with viem's default anyway, for throwaway builds only. |
| Frontend | `NEXT_PUBLIC_PREVIOUS_CONTRACTS_<id>` | public, build time: earlier deployments on the chain, `<address>:<deploy block>,…`. Empty until the first redeploy ([below](#redeploying-on-the-same-chain)). |
| Frontend | `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | public, build time |
| Frontend | `ZAMA_RELAYER_API_KEY` or `ZAMA_RELAYER_API_KEY_<id>` | **secret, runtime only**; never `NEXT_PUBLIC_`. Required on mainnet only (Sepolia's relayer is open). A per-chain key overrides the global one only when non-empty. |
| Frontend | `ZAMA_RELAYER_URL_<id>` | optional runtime override, https only |
| Client / watcher | `CHAIN_ID`, `RPC_URL`, `DMS_ADDRESS`, `FROM_BLOCK`, `PRIVATE_KEY`, `ZAMA_RELAYER_API_KEY`, optional `ZAMA_RELAYER_URL` | `.env`; see [client/README.md](./client/README.md). The watcher's RPC must support the `finalized` block tag (§7). |

Instead of the address variables, deployments can be compiled into the app in
`frontend/lib/deployments.json` (`contracts` by chain id, `previousContracts`
as `"<address>:<deploy block>"` entries); a variable that is set takes
precedence for the current address. `next build` checks both, and requires an
RPC URL for a chain listed in either. The frontend is built with webpack (`npm
run build` runs `next build --webpack`; Turbopack does not build its webpack
configuration) and supports Chrome, Edge and Firefox 111+ and Safari 16.4+.

Never set `NEXT_PUBLIC_ENABLE_LOCAL_CHAIN` in production.

### Redeploying on the same chain

The contract is immutable, so a change to `src/` means a new deployment, and
the old contract's switches stay live: owners must keep pinging them there, and
an owner who cannot find a switch has its secret released when it goes dark.
Never drop the old address while any switch on it is neither revealed nor
cancelled.

1. Deploy the new contract (§4 / §6) and record its address and deploy block.
2. Frontend: add `<old address>:<old deploy block>` to
   `NEXT_PUBLIC_PREVIOUS_CONTRACTS_<id>` (keep earlier entries), point
   `NEXT_PUBLIC_CONTRACT_<id>` and `NEXT_PUBLIC_FROM_BLOCK_<id>` at the new
   deployment, and rebuild once ([RAILWAY-DEPLOY.md §5](./RAILWAY-DEPLOY.md#5-redeploying-on-the-same-chain)).
   An old address compiled into `lib/deployments.json` `contracts` moves to
   `previousContracts` in the same commit. The app then lists both, sends each
   switch's writes to its own contract, and creates only on the new one.
3. Watchers: one watcher works on one contract and one state file, which is
   refused for any other contract. Keep the old watcher running on the old
   contract, at least until its state file has no `pendingTx` left; with the
   same `PRIVATE_KEY` a new watcher's transactions would queue behind the old
   one's. Run the new watcher with a fresh `stateFile`, `FROM_BLOCK` = the new
   deploy block, or with another key. The old contract's dark switches still
   need a hunter, so keep a watcher on it while it has live switches.
4. Publish the new address and deploy block, and say that the old one keeps
   working for its switches. The CLI has no list of deployments: users point
   `DMS_ADDRESS` at the contract their switch is on.
5. When every switch on the old contract is revealed or cancelled, its entry
   can go. To stop creates without a successor, unset `NEXT_PUBLIC_CONTRACT_<id>`
   and list that address as previous: its switches stay usable, while creates
   and the admin page are off.

## 7. Watcher operations

```bash
cd client && npm ci && npm run build
cp .env.example .env                       # CHAIN_ID, RPC_URL, DMS_ADDRESS, PRIVATE_KEY (watcher hot key), ZAMA_RELAYER_API_KEY, FROM_BLOCK=<deploy block>
cp watcher.config.example.json watcher.config.json   # every value in it is the default; edit from there
node dist/watcher.js --config watcher.config.json              # daemon
node dist/watcher.js --config watcher.config.json --once       # one pass; exit 1 if any action failed (cron)
```

The watcher exits 1 at startup if `PRIVATE_KEY` is missing, or if
`ZAMA_RELAYER_API_KEY` is missing on mainnet (chain 1), before it can spend
gas on a `markDark` it could not follow up.

| Setting | Guidance |
| --- | --- |
| `FROM_BLOCK` (or `fromBlock`, `--from-block`) | The deploy block. Otherwise the first run scans from genesis. It applies only to the first run: once the state file exists, discovery resumes after its `lastScannedBlock`, so the same value can stay set for every start. A startup `note:` appears only if it is lowered below the block the state file first scanned from. Each pass with new blocks also scans up to 64 blocks below `lastScannedBlock` again (never below the first block scanned), so a `SwitchCreated` that a reorganisation moved is still found. To look again from an earlier block, run once with `--rescan-from <block>`. That only moves the start back: a block above `lastScannedBlock` + 1 is ignored with a log line, so no block is ever skipped. If the RPC no longer has the logs from `FROM_BLOCK` ("pruned history"), each pass reports a configuration error naming `FROM_BLOCK`: use an RPC that keeps the blocks back to the deploy block. |
| `revealGasEstimate` | Default 400,000 is a guess. It decides whether to `markDark`, and is the profitability pre-check before any KMS request for a `DARK_MARKED` switch. Set it from the Sepolia/mainnet measurement. The reveal itself uses an exact estimate. |
| `safetyFactor`, `minProfitEth`, `maxGasPriceGwei` | Profitability gate; `maxGasPriceGwei` also caps altruistic mode and every fee the watcher sends, replacements included. Set it on mainnet: with `0` (no cap) the replacement fees of a stuck `publishPlaintext`, or of a self-transfer that frees the nonce of a call that would now revert, keep rising by 12.5% per replacement, and so do those of a stuck `markDark` / `revealKey` in `--altruistic` mode (otherwise the bounty limits them, and those of a self-transfer that gives one up; see the next row). Zama fees are not included (model unknown). |
| `txReceiptTimeoutSec` | Default 120. How long a pass waits for a receipt. A transaction still unmined is recorded as `pendingTx` in the state file and resolved first on the next pass (or by the next process): its receipt if one of its broadcasts was mined; otherwise a replacement with the same nonce and fees +12.5% (or the market rate), capped by `maxGasPriceGwei`. A `markDark` or `revealKey` is replaced only while the bounty still covers its gas at the new fees, by the same `safetyFactor` / `minProfitEth` rule (for `markDark`, its gas plus `revealGasEstimate`). Otherwise it is held back: it stays pending at its original fees (it can still be mined if fees fall), is reported as unprofitable and is checked again after `unprofitableRecheckSec`. A held-back transaction holds the signer's nonce, and nonces are mined in order. It is given up, and its nonce freed with a 0-value self-transfer (21,000 gas at the replacement fees, capped by `maxGasPriceGwei`), only for a later `markDark` / `revealKey` worth mining: pending for another switch or about to be sent, with a bounty that covers its own gas plus the self-transfers needed in front of it, by the same rule (a later transaction is valued at its own fees while they cover the latest base fee, else at its replacement fees). A held-back transaction whose own max fee covers the base fee again is not given up; it is mined at its own fees. Anything else waits behind it: a `markDark` / `revealKey` that cannot pay for that (its own replacements stay bounded by its bounty), and a `publishPlaintext` or a self-transfer cancelling a call that would now revert, whose fees are not raised meanwhile. For a transaction the watcher did not send, which it cannot value, a self-transfer may cost no more than the transaction whose nonce it frees was allowed to cost. A stuck self-transfer that gave up an action has its fees raised only on the same terms. If the node has dropped it, the switch is re-read and the action sent again at market fees, if they pay. If the call would now revert, a 0-value self-transfer frees the nonce instead. Give each watcher process its own signer, used by nothing else. |
| `decryptTimeoutSec`, `decryptAttemptsPerPass`, `decryptPassBudgetSec` | Per-request timeout, attempts per pass, and the time one pass may spend on KMS requests and the waits between retries (default 300 s; discovery and receipt waits do not count; switches left over wait for the next pass). The relayer's `Retry-After` is honoured. |
| `stateFile`, `outDir` | Put both on persistent storage. The state file is tied to one chain and contract; a state file for another contract is refused, naming the nonces it still has pending (moving to a new deployment: [§6](#redeploying-on-the-same-chain)). Plaintexts go to `<outDir>/<chainId>-<contract>/<owner>-<id>.bin` (mode 0600) with a `.json` record; files are never overwritten, except that a final switch's own `.json` is rewritten (with `amendedAt`) if a reorganisation changed who revealed it. |
| `RPC_URL` | Must support the `finalized` block tag (Ethereum mainnet and Sepolia nodes do). A revealed or cancelled switch counts as done only once the finalized block shows it; until then it is read every pass, so a reorganisation that drops a reveal, a publish or a cancel is noticed (`WARNING: state went back …`). Without the tag the finality check fails every pass, counted as an error. |
| `--altruistic`, `--publish` | Reveal regardless of profit; also post plaintexts on-chain (costs gas, pays nothing). |

Run it under a supervisor that restarts it (systemd, a container restart
policy) or as a cron job with `--once`. SIGINT/SIGTERM stop it at the current
step with progress saved.

Run one watcher per state file, across containers and machines too (a shared
volume, NFS). `<stateFile>.lock` names its holder and carries a heartbeat
refreshed every 5 s; a second watcher on the same file exits 1, and a watcher
whose lock was taken over (frozen past the heartbeat bound, say) stops and
exits 1 ([client/README.md](./client/README.md)). A container restarted after a
kill or an OOM takes its predecessor's lock over after watching its heartbeat
for 15 s. Stop older watchers before upgrading: their locks have no heartbeat.
A new watcher takes such a lock over at once when its pid is the new watcher's
own (PID 1 in a container), keeps off it while its pid runs on the same host,
and otherwise takes it over after watching it for 15 s.

Each pass reads the switches that are due, then sends `markDark`,
`revealKey` and `publishPlaintext` highest bounty first (at equal bounty a
reveal before a `markDark`), each waiting for its receipt, and reads chain
time again as blocks arrive, so a switch that goes dark during a long pass is
sent for in that pass. A backlog of low-bounty switches can delay a switch only
if each carries at least its bounty.

What counts as an error (`--once` exits 1): a failed read, `markDark`,
`revealKey`, archive or publish; a discovery failure (including the
`FROM_BLOCK` configuration error above); a failed finality check; and a relayer
that refuses public decryption for configuration reasons (HTTP 401/403, an SDK
configuration error, or a 404/405 with no typed relayer error to the request
that starts a job, twice in a row 3 s apart: no route, a wrong
`ZAMA_RELAYER_URL` path). That last one also pauses `markDark` for `backoffMaxSec`
from the latest such failure. The pause is kept in the state file, so cron
`--once` runs honour it as well as the daemon. It ends sooner when a public
decryption succeeds, or when `ZAMA_RELAYER_URL` or `ZAMA_RELAYER_API_KEY`
change; the next start then logs
`relayer settings changed … markDark is no longer paused`. The state file
holds only a short SHA-256 prefix of those settings, never the key. While the
key stays wrong, each lapse of the pause lets about one more `markDark` out,
whose failed reveal renews it. Not errors: a lost race (someone else's
`markDark` or `revealKey` landed first,
reported as `lost races N`; the watcher carries on from the new state and
still archives the plaintext once it is revealed), a
transaction still pending, a KMS that has not served the key yet, and a
switch held back by the profitability gate. Under `--once`, and in the daemon
whenever a pass marked, revealed, published, lost a race or hit an error, the
watcher logs:

```
pass: polled N, marked N, revealed N, saved N, published N, lost races N, unprofitable N, pending N, errors N
```

Other relayer failures, every HTTP 400 included (the relayer answers one,
`not_allowed_on_host_acl`, until it has seen the `markDark`), are treated as
"not ready yet" and retried with exponential backoff up to `backoffMaxSec`
(900 s); alert on the same `public decrypt` message repeating for hours.

`WARNING` lines worth an alert: `state went back from … to …` (a reorganisation,
or a node behind), a booked transaction that reverted or is not mined on the
final chain, nonces of the signer held by transactions the state file does not
track, a key that does not open the ciphertext, and an archive file written
under another name.

## 8. Monitoring

| What | How | Alert when |
| --- | --- | --- |
| Admin changes | `AdminTransferStarted`, `AdminTransferred`, `MinBountyUsdUpdated` events | Any occurrence not initiated by you. |
| Stuck releases | Switches in `DARK_MARKED` (`SwitchDarkMarked` without `KeyRevealed`) | Older than a few hours: relayer/KMS problem. |
| Unclaimed dark switches | `DARK` switches nobody marks | Bounties too low for hunters; review `minBountyUsd`. |
| Rescues | `OwnerStakeReclaimed`, or `ContributionReclaimed` on a non-cancelled switch | Any: the KMS did not serve a key for 30 days. |
| Key mismatches | Watcher logs / `keyMismatch: true` records | Any: invalid owner ciphertext, or a KMS signer-set problem. |
| Zama host | `ACL.paused()`, `ACL.isAccountDenied($DMS)`, `KMSVerifier.getThreshold()`, `getKmsSigners()`, `getCurrentKmsContextId()`, `ACL.owner()` | Paused, deny-listed, or any change from the recorded values. |
| Oracle | `oraclePrice()` | `ok == false`: the floor is not enforced. |
| Relayer proxy (frontend) | Status codes and bodies of `/api/relayer/*` (Railway HTTP logs). `keyurl` answers a configuration error with a 503 and its label, and throttling or upstream failures with 429 / 502 / 504. On the SDK's paths (input proof, public decrypt, their polls) the proxy answers the way the SDK understands: a configuration error is a 403 whose message starts with its label; its own throttle is a 429 `rate_limited` on a POST and a 202 `queued` (request id `proxy-throttled`) on a poll, so the SDK retries. An upstream network failure is answered the same way (`protocol_overload`, `proxy-upstream-retry`) twice in a row for the same request or job; the third, within 2 minutes, gets a 502 (504 on a timeout), which ends the SDK's job and shows the user a relayer error. | Any `relayer_not_configured`, `relayer_misconfigured` or `contract_not_configured`; `contract_mismatch` beyond the minutes after a redeploy (stale tabs cause it then); sustained 429 or `rate_limited`; `protocol_overload` or `proxy-upstream-retry` for minutes, or repeated 502/504 (relayer unreachable). |
| Frontend | An external uptime check on `/` (Railway's health check runs only when a deployment starts, and only if it is set in the service settings: [RAILWAY-DEPLOY.md §1](./RAILWAY-DEPLOY.md#1-create-the-service)) | Failing. |
| Watcher | Process supervisor, `--once` exit code, hot-wallet balance, the `pass:` log line, `pendingTx` entries in the state file | Down, non-zero exit, low balance; `pending` that never clears (e.g. `maxGasPriceGwei` leaves no room to replace a stuck transaction), or a `pendingTx` held back as unprofitable to replace; any `WARNING` line (§7); a `FROM_BLOCK` configuration error or a failed finality check every pass. |

## 9. Pre-mainnet checklist

Not verified yet (needs Sepolia or mainnet):

- [ ] Live relayer latency from `markDark` to a servable public-decryption proof (Sepolia, then mainnet).
- [ ] Zama fee model: who pays for input verification and public decryption, and in what. Fold into `MIN_BOUNTY_USD` and the watcher's profit check.
- [ ] Mainnet `revealKey` gas with the real KMS signer count (`checkSignatures` does one `ecrecover` per signature), and `createSwitch` gas with real coprocessor signatures. Locally, with one mock signer each: 141k–150k and ~430k. On a Sepolia fork with a real 7-of-13 proof: `revealKey` 395,303, `createSwitch` 489,075 at 62 bytes without a feed.
- [ ] Relayer API key issuance, rate limits and SLA; the real job-id format (the proxy accepts `[A-Za-z0-9._~:=+-]{1,256}`); keyurl bucket CORS in a browser, and the mainnet key size (Sepolia's: 4,604,386 bytes); the relayer's error text for "not decryptable yet" (the frontend matches the SDK's text and the labels `not_ready_for_decryption` and `readiness_check_timed_out`; check it also retries the 400 `not_allowed_on_host_acl` seen right after `markDark`); the response to a missing or rejected API key (the watcher and CLI treat HTTP 401/403, SDK configuration errors and a repeated untyped 404/405 as fatal, everything else as "not ready yet").
- [ ] Mainnet host: executor version ≥ 0.3.0, KMS threshold and signer count, ACL owner and pauser set (single key, multisig or timelock?).
- [ ] One-week Sepolia soak (§5) passes with no manual intervention.
- [ ] External audit (start from the known limitations in [SECURITY.md](./SECURITY.md)).
- [ ] Admin multisig chosen; renounce decision made.
- [ ] Frontend production env set: `NEXT_PUBLIC_CONTRACT_1`, `NEXT_PUBLIC_FROM_BLOCK_1`, `NEXT_PUBLIC_RPC_URL_1` (`next build` fails without it), a real `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (the code falls back to `"demo"`), server-only `ZAMA_RELAYER_API_KEY_1`.
- [ ] The browser suite (`cd frontend && npm run test:e2e`) passes on the release commit.
- [ ] A write from the admin Safe through the app's `/admin` page, checked on-chain (smart-account writes are tested only against a test wallet).
