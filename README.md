# DeadManSwitch — a ping-extendable dead-man switch on Ethereum (Zama fhEVM)

Store an encrypted secret and an ETH bounty on Ethereum. Ping to show you are
alive. If you stop pinging for one interval, anyone can release the secret and
claim the bounty, and from then on anyone can read it from chain state.

- **The deadline is judged by Ethereum consensus.** The contract compares
  `block.timestamp` with your last ping. No oracle, RPC or off-chain node
  decides whether you are dark.
- **The key is held by Zama's threshold KMS.** Your secret is AES-256-GCM
  encrypted in your browser or CLI under a fresh 32-byte key. That key is
  stored in the contract as an FHE ciphertext (`euint256`), which Zama's KMS
  (13 MPC parties; Zama publishes a 9-of-13 decryption threshold) decrypts
  only after the contract calls `markDark`, and only once you have missed the
  deadline.
- **Release pays.** `revealKey` verifies the KMS signatures (on Sepolia,
  `KMSVerifier` accepts 7 of its 13 signers), records the key on-chain and
  pays the whole bounty to whoever submits it first.
- **Public release only.** No recipients, no fixed-date vault. Max secret size
  2,048 bytes.

> **Unaudited and not yet deployed.** Do not store anything you cannot afford
> to leak early or never release. Read the [trust model](./ARCHITECTURE.md#6-trust-model)
> first: confidentiality depends on Zama's KMS and on Zama's governance of its
> host contracts.

## Status

| Area | State |
| --- | --- |
| Contract (`contracts/`) | Complete. Foundry tests against Zama's mock host (unit, fuzz, invariants) and for the deploy script. Runtime 14,029 bytes. |
| Client (`client/`) | CLI and watcher complete, with unit tests and a local end-to-end suite (full lifecycle, cancel, the watcher, and the watcher losing front-running races). |
| Frontend (`frontend/`) | Complete. Next.js 16, React 19, with unit tests and a Playwright browser suite against a local chain. Browsers: Chrome, Edge and Firefox 111+, Safari 16.4+. |
| Deployment tooling | `make deploy-sepolia` / `make deploy-mainnet` sign with an encrypted keystore or a Ledger (`ACCOUNT=` or `LEDGER=1`); mainnet refuses the `PRIVATE_KEY` environment variable and hands the admin role to a multisig (`NEW_ADMIN`). See [PRODUCTION-SETUP.md](./PRODUCTION-SETUP.md). |
| **Not done** | |
| Sepolia deployment | Not started. The app has not run against Zama's real relayer and KMS yet. |
| External audit | Not started. |
| Zama fee model, relayer rate limits | Unknown. Not included in bounty or profitability maths. |
| Mainnet gas for `createSwitch` / `revealKey` | Unmeasured (local figures use one mock signer). |
| Mainnet deployment | Not started. |

Known limitations and how to report a vulnerability: [SECURITY.md](./SECURITY.md).

## Quick start

Requirements: [Foundry](https://getfoundry.sh) (tested with 1.5.1 and 1.7.1), Node 22,
`jq`.

### Everything, locally, in one command

```bash
./scripts/local-e2e.sh
```

Starts (or reuses) Anvil on port 8545, deploys Zama's host contracts with a
cleartext executor and mock KMS at their canonical local addresses, deploys a
fresh `DeadManSwitch`, and runs the client's end-to-end suite: full lifecycle,
cancel path, the watcher, and the watcher losing front-running races. Installs
Soldeer and npm dependencies on first run. It needs Node 22 or later and stops
with an error on older versions. It advances the node's clock and turns
automine off for a while, so do not point it at a node others rely on.
Options: `ANVIL_PORT`, `KEEP_ANVIL=1`, `SKIP_E2E=1` (deploy only, prints
`DMS_ADDRESS`), `FORCE_HOST_DEPLOY=1`.

### Contracts

```bash
cd contracts
forge soldeer install
forge build --sizes
forge test
```

See [contracts/README.md](./contracts/README.md).

### Browser end-to-end

```bash
cd client && npm ci && cd ../frontend && npm ci && npx playwright install chromium
npm run test:e2e                                       # from frontend/
```

Starts its own Anvil (port 18600) with Zama's mock host and a fresh contract,
builds and serves the app (port 3100), and runs the Playwright suite: 13 specs
(30 tests), one of them driving the real CLI and watcher against the same
chain. `E2E_SCREENS=1` adds a screenshot set. See
[frontend/e2e/README.md](./frontend/e2e/README.md).

### Frontend against a local chain

```bash
KEEP_ANVIL=1 SKIP_E2E=1 ./scripts/local-e2e.sh        # prints DMS_ADDRESS=0x…
cd frontend && npm ci
# replace 0x… with the DMS_ADDRESS printed above
cat > .env.local <<EOF
NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=1
NEXT_PUBLIC_CONTRACT_31337=0x…
NEXT_PUBLIC_RPC_URL_31337=http://127.0.0.1:8545
EOF
npm run dev                                            # http://localhost:3000
```

Connect a wallet to `http://127.0.0.1:8545` (chain 31337) with an Anvil dev
account. To make a switch go dark, advance your own node's clock:
`cast rpc evm_increaseTime 120 && cast rpc evm_mine`. See
[frontend/README.md](./frontend/README.md).

### CLI

```bash
cd client && npm ci && cp .env.example .env    # set RPC_URL, CHAIN_ID, DMS_ADDRESS; PRIVATE_KEY only to send transactions
npm run dms -- create 1 86400 0.01 --file secret.txt   # id 1, 1-day interval, 0.01 ETH bounty
npm run dms -- ping 1
npm run dms -- info 0xOwner 1
# after the owner misses the deadline:
npm run dms -- mark-dark 0xOwner 1
npm run dms -- reveal 0xOwner 1 --publish
npm run dms -- read 0xOwner 1 --out secret.bin
npm run watcher -- --once                              # unattended hunter, one pass
```

On mainnet, `create`, `reveal` and the watcher also need
`ZAMA_RELAYER_API_KEY` (Sepolia's relayer is open and needs none). See [client/README.md](./client/README.md).

## How it works

```
create   seal secret with AES-256-GCM under a random key; FHE-encrypt the key; store both + bounty
ping     owner resets the deadline to now + interval
markDark anyone, once block.timestamp ≥ lastPing + interval: the key becomes publicly decryptable (irreversible)
reveal   anyone fetches (key, KMS proof) from Zama's relayer; revealKey verifies it, stores the key, pays the bounty
read     anyone: getCiphertext + getRevealedKey → decrypt locally (clients also verify the AES-GCM tag and commitment)
publish  optional: post the plaintext on-chain, checked against the creation-time commitment
cancel   owner, while alive: refund own stake; the key is never decryptable
rescue   30 days after the deadline with no reveal: each depositor can take back their own principal
```

By design:

- **Reveals are front-runnable.** After `markDark` anyone can fetch the same
  KMS proof, and `revealKey` calldata is public. Whoever lands first is paid;
  that race is how the secret gets delivered.
- **The owner can reveal their own switch** (stop pinging, then reveal) and
  collect funder contributions. Fund only switches whose owner you trust.
- **A contribution is locked while the owner keeps pinging**, possibly for
  years. A funder gets it back only after a cancel, or if nobody releases the
  key within 30 days of a missed deadline; otherwise it goes to whoever
  releases the key. The owner's own top-ups count as contributions too: a
  cancel refunds only the owner's escrow.
- **The secret's length is public** (ciphertext length minus 61 bytes).
- **Revealed plaintext is untrusted data.** Both apps render it only as text.

Details: [ARCHITECTURE.md](./ARCHITECTURE.md) (mechanism, state machine,
functions, trust and threat model, gas).

## Repository layout

```
contracts/          Foundry project: src/DeadManSwitch.sol, tests, Deploy.s.sol, Makefile (Soldeer deps)
client/             Node CLI (dms) and hunter daemon (watcher) on @zama-fhe/sdk
frontend/           Next.js 16 app + /api/relayer proxy (server-side relayer API key)
scripts/            local-e2e.sh (CLI and watcher end to end), browser-e2e.sh (Playwright suite)
docs/               fhevm-api-pins.md (versions, addresses), ciphertext-test-vector.json
ARCHITECTURE.md     design, trust model, threat model, gas
PRODUCTION-SETUP.md Sepolia → mainnet deploy runbook, frontend and watcher operations
RAILWAY-DEPLOY.md   hosting the frontend on Railway
SECURITY.md         vulnerability reporting and known limitations
```

## License

[MIT](./LICENSE).
