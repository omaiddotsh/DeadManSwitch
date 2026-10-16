# DeadManSwitch — contracts

One Solidity contract, `src/DeadManSwitch.sol`, built on Zama fhEVM. Every
switch lives in a single mapping keyed by `keccak256(owner, id)`; no factory,
no proxy, not upgradeable. Design, functions, trust model and gas:
[../ARCHITECTURE.md](../ARCHITECTURE.md). Pinned versions and host addresses:
[../docs/fhevm-api-pins.md](../docs/fhevm-api-pins.md).

```
contracts/
├── src/DeadManSwitch.sol        the contract (inherits ZamaEthereumConfig)
├── test/                        174 tests (158 on forge-fhevm's FhevmTest, 16 for the deploy script)
│   ├── utils/DMSTestBase.sol    harness: mock host, mock price feed, encrypt + KMS-decrypt helpers
│   ├── Create.t.sol             29   PingFundCancel.t.sol  36   Release.t.sol  32
│   ├── RescueAdmin.t.sol        44   FuzzInvariant.t.sol   16 (7 fuzz + 9 invariant)
│   ├── Deploy.t.sol             16   Deploy.s.sol: strict env parsing, chain-1 and signer guards
│   └── DeadManSwitch.t.sol       1   lifecycle smoke test
├── script/Deploy.s.sol          deploy script (env-driven)
├── Makefile                     deps / build / test / gas / deploy targets
├── foundry.toml                 solc 0.8.28, cancun, via_ir, 1,000,000 runs; Soldeer dependency pins
├── soldeer.lock                 exact dependency checksums
└── .gas-snapshot                per-test gas, checked by `make gas-check`
```

## Toolchain and dependencies

Foundry (tested with 1.5.1). Dependencies are managed by **Soldeer** and pinned in
`foundry.toml` / `soldeer.lock`; there are no git submodules.

| Dependency | Pin | Why |
| --- | --- | --- |
| `@fhevm/solidity` | 0.11.1 | 0.13.4 calls a host function that only exists in executor ≥ 0.5.0; the contract is immutable. |
| `encrypted-types` | 0.0.4 | Required by 0.11.1. |
| `forge-fhevm` | git `3ee696f` | Foundry harness and local host. Zama's template commit signs decryption proofs over the wrong encoding. |
| `forge-std` | 1.14.0 | Matches forge-fhevm. |

`evm_version = cancun` is required: `FHE.checkSignatures` and the reentrancy
lock use transient storage. `via_ir` is required for the multi-field
`SwitchCreated` emit.

## Build and test

```bash
make deps        # forge soldeer install
make build       # forge build
make sizes       # forge build --sizes   → runtime 14,029 bytes (EIP-170 limit 24,576)
make test        # forge test -vv        → 174 passed
make gas         # rewrite .gas-snapshot (unit tests only; fuzz/invariant gas is not deterministic)
make gas-check   # gas regression check: fails if any test moved more than 2%
make fmt         # forge fmt
make lint        # forge build, then lint: forge lint -D notes src script
forge test --gas-report                  # per-function gas against the mock host
```

`make gas` and `make gas-check` skip the fuzz and invariant tests
(`--no-match-test "testFuzz|invariant|test_Invariant"`), because their gas is
not deterministic; the committed `.gas-snapshot` holds the other 153 tests.
Fuzz tests must be named `testFuzz_*` for the filter to catch them: a
parameterised `test_*` puts a fuzz median in the snapshot, which shifts
whenever unrelated test bytecode changes. A plain `forge snapshot --check`
fails on the missing fuzz and invariant entries.

Run `forge build` before `forge lint` locally (`make lint` does). With Foundry
1.5.1, when `forge lint` is the run that compiles a changed file, it writes an
artifact without bytecode that later builds reuse, and `forge script` then
fails with "Could not find target contract". It fails safe (nothing is
deployed); a fresh checkout is not affected.

The contract tests (all but `Deploy.t.sol`) run against forge-fhevm's real
ACL, InputVerifier, KMSVerifier and a cleartext executor with one mock
coprocessor signer and one mock KMS signer. `DMSTestBase` encrypts DEKs into
genuine input proofs and builds genuine KMS public-decryption proofs, so
`fromExternal` and `checkSignatures` are exercised end to end. The invariant
suite drives every action through a handler and checks eight invariants
(balance, ledgers, revealed pot, sealed keys, ETH conservation, revealed key =
owner's DEK, valid actions never revert).

Before a release, run `forge soldeer install`, `forge fmt --check`, `make lint`,
`forge build --sizes`, `forge test -vv` and `make gas-check`, then check the
ABI copies with `npm run check:abi` in `frontend/` and the client tests after
a `forge build src`.

## Deploy

`ZamaEthereumConfig` supports only chain ids 1, 11155111 and 31337; the
constructor reverts `ZamaProtocolUnsupported` anywhere else.

Constructor `(address ethUsdPriceFeed, uint256 minBountyUsd, uint256 maxPriceAge)`.
`Deploy.s.sol` reads the variables below. An empty variable counts as unset.
Any other value must parse (an address in mixed case must also carry a valid
EIP-55 checksum), or the script reverts before anything is broadcast; it never
falls back to the default. After deploying it checks that the contract holds
exactly the configured feed, floor, price age and pending admin.

| Env | Default | |
| --- | --- | --- |
| `PRIVATE_KEY` | unset | Optional raw deployer key (`0x` + 64 hex digits; a malformed one is refused without being printed), for local Anvil and throwaway testnet keys. When unset, the script signs with whatever `forge script` was given (`--account <keystore>` or `--ledger`, plus `--sender <address>`). forge also reads it from `contracts/.env`. When a `--sender` is given (or a single `--account` / `--ledger`), the key must be that sender's, or the run stops before broadcasting: a stray key never signs in place of the keystore. **Refused on chain 1.** Only this variable is checked: a key passed on the command line is not (see below). |
| `ETH_USD_PRICE_FEED` | `0x0` | Chainlink ETH/USD. `0x0` disables the bounty floor. |
| `MIN_BOUNTY_USD` | `0` | 8 decimals (`1000000000` = $10), plain digits. Must be 0 without a feed. Max $10,000. **Required on chain 1** (`make deploy-mainnet` sets it). |
| `MAX_PRICE_AGE` | `7200` | Seconds; ignored without a feed. |
| `NEW_ADMIN` | unset | Calls `transferAdmin(NEW_ADMIN)` in the same run; the new admin then calls `acceptAdmin()`. **Required on chain 1** (point it at a multisig). |

The script prints the address, `admin` (still the deployer) and
`pendingAdmin` (`NEW_ADMIN`). Forge records the transactions and receipts in
`broadcast/Deploy.s.sol/<chainId>/run-latest.json` (git-ignored).

### Local (Anvil + Zama mock host)

```bash
../scripts/local-e2e.sh                         # everything: anvil, host, deploy, client e2e
KEEP_ANVIL=1 SKIP_E2E=1 ../scripts/local-e2e.sh # anvil + host + deploy only; prints DMS_ADDRESS
make deploy-anvil                               # deploy only; needs anvil on :8545 with the host already deployed
../scripts/browser-e2e.sh                       # the frontend's Playwright suite: its own anvil (:18600), host, deploy, app
```

`make deploy-anvil` uses Anvil's dev account #0 and no price feed. The host
stack comes from `dependencies/forge-fhevm-3ee696f/deploy-local.sh`, which
needs forge-fhevm's own Soldeer dependencies; `local-e2e.sh` installs them.

### Sepolia and mainnet

Follow [../PRODUCTION-SETUP.md](../PRODUCTION-SETUP.md). In short:

```bash
cast wallet import dms-deployer --interactive      # once: encrypted keystore in ~/.foundry/keystores

# Sepolia rehearsal, admin handed to the multisig (run one of these)
export SEPOLIA_RPC_URL=https://… ETHERSCAN_API_KEY=…
make deploy-sepolia ACCOUNT=dms-deployer SENDER=0xDeployer NEW_ADMIN=0xSafe
#   or: make deploy-sepolia LEDGER=1 SENDER=0xDeployer NEW_ADMIN=0xSafe
#   or, with a throwaway testnet key: PRIVATE_KEY=0x… make deploy-sepolia NEW_ADMIN=0xSafe

# Mainnet: keystore or Ledger only (run one of these)
unset PRIVATE_KEY                                  # deploy-mainnet refuses to run while it is set
export ETH_RPC_URL=https://… ETHERSCAN_API_KEY=… MIN_BOUNTY_USD=<8-decimal USD>
make deploy-mainnet ACCOUNT=dms-deployer SENDER=0xDeployer NEW_ADMIN=0xSafe
#   or: make deploy-mainnet LEDGER=1 SENDER=0xDeployer NEW_ADMIN=0xSafe

# then, from the multisig: acceptAdmin() on the deployed address
```

| Target | Signer | Checks before running `forge script` |
| --- | --- | --- |
| `deploy-anvil` | Anvil dev account #0 | none (local only) |
| `deploy-sepolia` | `ACCOUNT=<keystore>` or `LEDGER=1`, with `SENDER=<address>`; or `PRIVATE_KEY` for a throwaway key | `SEPOLIA_RPC_URL` and a signer are set, `SENDER` unless `PRIVATE_KEY` is, and `PRIVATE_KEY` not together with `ACCOUNT`/`LEDGER` |
| `deploy-mainnet` | `ACCOUNT=<keystore>` or `LEDGER=1`, with `SENDER=<address>` | `PRIVATE_KEY` is **unset**; `ETH_RPC_URL`, `SENDER` and `NEW_ADMIN` are set |

forge reads `contracts/.env` as well as the environment, so these checks look
at both: a `PRIVATE_KEY` in `.env` counts as set. `.env` must not set
`ETH_PASSWORD` at all (a password there would be printed); both targets refuse
to run while it does. None of the checks prints a value.

On chain 1 `Deploy.s.sol` checks the mainnet rules again: it refuses the
`PRIVATE_KEY` environment variable and requires `NEW_ADMIN` and an explicit
`MIN_BOUNTY_USD`, so a `forge script` run by hand cannot skip those. It cannot see the command
line, though: a key given as `--private-key`, `--mnemonics` or `--interactives` is
not detected and would deploy mainnet with a hot key. Never pass one; use
`--account` or `--ledger`.

Both public targets set the Chainlink feed (Sepolia
`0x694AA1769357215DE4FAC081bf1f309aDC325306`, mainnet
`0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419`), default `MIN_BOUNTY_USD` to
`1000000000` ($10), put `NEW_ADMIN` into the `forge script` command itself (so
the command `make` echoes is complete), broadcast, and verify on Etherscan
(`ETHERSCAN_API_KEY` must be set; `VERIFY=0` skips verification). With
`ACCOUNT=`, forge prompts for the keystore password. `ETH_PASSWORD`, if set,
must be the path of a file holding it (forge reads it as `--password-file`),
never the password itself: forge would print it in its error, so both targets
refuse anything that is not a readable regular file (and any `ETH_PASSWORD` in
`contracts/.env`). `LEDGER=1` signs with the Ledger's first
account (index 0). For another account, print the command without running it
with `make -n` and the same arguments (plain `make` would run it), then run its
last command (`NEW_ADMIN=… forge script …`) with
`--mnemonic-derivation-paths "<path>"` added.

After a deploy, regenerate nothing: the client and frontend ABIs come from
`out/DeadManSwitch.sol/DeadManSwitch.json` (`npm run abi` in `client/`,
`npm run gen:abi` in `frontend/`) and only change if the contract does.
