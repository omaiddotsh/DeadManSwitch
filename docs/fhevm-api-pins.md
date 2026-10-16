# fhEVM API pins

> **Date:** 2026-10-11, Sepolia host facts added 2026-10-13. Every pin below
> was checked against the package source (not docs) and, where marked ✅,
> exercised by a passing Foundry test. The Sepolia host facts below were read
> with read-only calls. Measurements that need this contract on Sepolia (⏳)
> are not taken yet: it is not deployed there. They are pre-mainnet checklist
> items in [PRODUCTION-SETUP.md](../PRODUCTION-SETUP.md).

## Versions

| Component | Pin | Why this one |
| --- | --- | --- |
| `@fhevm/solidity` (Soldeer `@fhevm-solidity`) | **0.11.1** | See "Library version" below. Same mainnet/Sepolia addresses as 0.13.4. |
| `encrypted-types` (Soldeer `@encrypted-types`) | **0.0.4** | Dependency of `@fhevm/solidity` 0.11.1. |
| `forge-fhevm` (git) | **`3ee696fba62a32314fde457de28cc29f1191c4cb`** (2026-07-31) | Earlier commit `eba2324` — the one Zama's own Foundry template pins — signs public-decrypt proofs over `abi.encode(uint256[])` instead of the production encoding, so a contract that calls `FHE.checkSignatures` with real-shaped cleartexts can never verify in tests. Fixed at `3ee696f`. |
| `forge-std` | **1.14.0** | Matches `forge-fhevm`. |
| `@zama-fhe/sdk` (frontend, client) | **3.6.0** | Successor to `@zama-fhe/relayer-sdk`, whose `FhevmInstanceConfig` is marked deprecated. Has a viem adapter (our stack) and a `cleartext()` relayer for local Anvil. |
| solc | **0.8.28**, `evm_version = cancun`, `via_ir`, 1,000,000 runs | Unchanged from the existing contract. `checkSignatures` needs transient storage (Cancun). Verified to compile and pass with these settings. ✅ |

### Library version: why 0.11.1 and not 0.13.4

`@fhevm/solidity` 0.13.4 calls `FHEVMExecutor.checkHandleType` from
`toBytes32`, `allowThis`, `makePubliclyDecryptable` and friends. That function only
exists in host executor **≥ 0.5.0** (fhevm monorepo tag `v0.13.6`+). Mapping of
monorepo tags to versions, read from GitHub:

| fhevm tag | library | host executor | `checkHandleType` |
| --- | --- | --- | --- |
| v0.12.0 – v0.12.5 | 0.11.1 | 0.3.0 | no |
| v0.13.0 – v0.13.5 | 0.11.1 → 0.13.3 | 0.4.0 | no |
| v0.13.6 – v0.13.7 | 0.13.4 | 0.5.0 | **yes** |
| v0.14.2 – v0.14.3 | 0.14.2 | 0.6.0 | yes |

The contract is immutable, so a build that calls a host function the live host
lacks would revert on every FHE call forever. 0.11.1 needs only executor ≥ 0.3.0
and uses no function that later hosts removed. The one path whose semantics
matter most — `FHE.checkSignatures` — is identical in 0.11.1 and 0.13.4: both
call `KMSVerifier.verifyDecryptionEIP712KMSSignatures` on the host, so KMS
context/threshold handling is whatever the (upgradeable) host implements. The
EIP-712 digest (`PublicDecryptVerification(bytes32[] ctHandles,bytes decryptedResult,bytes extraData)`)
is byte-identical between the two versions.

## Network addresses (`ZamaEthereumConfig`, identical in 0.11.1 and 0.13.4)

| Chain | ACL | Coprocessor (executor) | KMSVerifier |
| --- | --- | --- | --- |
| Ethereum mainnet (1) | `0xcA2E8f1F656CD25C01F05d0b243Ab1ecd4a8ffb6` | `0xD82385dADa1ae3E969447f20A3164F6213100e75` | `0x77627828a55156b04Ac0DC0eb30467f1a552BB03` |
| Sepolia (11155111) | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` | `0x92C920834Ec8941d2C77D188936E1f7A6f49c127` | `0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A` |
| Local Anvil/Hardhat (31337) | `0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D` | `0xe3a9105a3a932253A70F126eb1E3b589C643dD24` | `0x901F8942346f7AB3a01F6D7613119Bca447Bb030` |

`ZamaEthereumConfig` reverts `ZamaProtocolUnsupported` on any other chain id, so
the contract cannot be deployed to an unsupported chain by mistake.

SDK chain presets (`@zama-fhe/sdk/chains`, 3.6.0):

| Preset | Relayer | Input verifier | Gateway chain |
| --- | --- | --- | --- |
| `mainnet` | `https://relayer.mainnet.zama.org` | `0xCe0FC2e05CFff1B719EFF7169f7D80Af770c8EA2` | 261131 |
| `sepolia` | `https://relayer.testnet.zama.org` | `0xBBC1fFCdc7C316aAAd72E807D9b0272BE8F84DA0` | 10901 |
| `anvil` / `hardhat` | none (`cleartext()` transport) | `0x36772142b74871f255CbD7A3e89B401d3e45825f` | — |

The `anvil` preset matches `forge-fhevm`'s fixed local deployment exactly, which
is what makes a fully local end-to-end test possible.

## Solidity calls used

```solidity
import {FHE, euint256, externalEuint256} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

euint256 k = FHE.fromExternal(externalEuint256 h, bytes inputProof); // proof binds (user = msg.sender, contract)
FHE.allowThis(k);                                                    // contract may use k later
FHE.makePubliclyDecryptable(k);                                      // irreversible; KMS will now decrypt k for anyone
FHE.checkSignatures(bytes32[] handles, bytes abiEncodedCleartexts, bytes decryptionProof); // reverts InvalidKMSSignatures / KMSInvalidSigner
```

- `abiEncodedCleartexts` for one `euint256` is `abi.encode(uint256 dek)` (32 bytes).
- `decryptionProof` = `uint8 numSigners ‖ 65-byte sig × numSigners ‖ extraData`.
- `fromExternal` with an **empty** proof takes a different path (accepts a handle
  already ACL-allowed to `msg.sender`, and maps the zero handle to a trivial
  encryption of 0). The contract therefore requires a non-empty proof.

## SDK calls used (`@zama-fhe/sdk` 3.6.0)

What `client/src/fhevm.ts` and `frontend/lib/fhevm.ts` actually call:

```ts
import { ZamaSDK, cleartext } from "@zama-fhe/sdk";
import { mainnet, sepolia, anvil } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { node } from "@zama-fhe/sdk/node";   // CLI / watcher
import { web } from "@zama-fhe/sdk/web";     // browser

const chain = { ...sepolia, network: RPC_URL, auth: { __type: "ApiKeyHeader", value: API_KEY } }; // header x-api-key
const sdk = new ZamaSDK(createConfig({ chains: [chain], publicClient, walletClient,
                                       relayers: { [chain.id]: node() /* web(), or cleartext() on anvil */ } }));

// encrypt (owner, at create)
const { encryptedValues: [handle], inputProof } =
  await sdk.encrypt({ values: [{ type: "euint256", value: dek }], contractAddress, userAddress });

// public decrypt (hunter, after markDark) — ONE handle per call
const { clearValues, abiEncodedClearValues, decryptionProof } =
  await sdk.decryption.decryptPublicValues([handle]);
// revealKey(owner, id, abiEncodedClearValues /* 32 bytes */, decryptionProof)
```

- One handle per public-decrypt call: `revealKey` verifies a proof over a
  one-element handle list, so a proof covering several handles never verifies.
- Relayer factories: `web()` (browser), `node()` (Node), `cleartext()` (local
  Anvil, no relayer). Relayer auth is `FheChainAuth` (`ApiKeyHeader` /
  `BearerToken`). Browsers reach the relayer only through the frontend's
  `/api/relayer` proxy, so the key stays server-side.
- The first encrypt in a fresh browser downloads the FHE public key and CRS,
  about 4.6 MB on Sepolia (below). Public decryption does not need them.
- Sepolia's `keyurl` answers with constant placeholder dataIds
  (`fhe-public-key-data-id`, `crs-data-id`), so a key or CRS rotation shows
  only as new bucket URLs. The frontend keys its IndexedDB cache on the URLs
  and the dataIds.
- The SDK's HTTP surface (read from `@fhevm/sdk` 0.13.2): `GET v2/keyurl`,
  `POST v2/input-proof`, `POST v2/public-decrypt`, and `GET <endpoint>/<jobId>`
  polling. That is exactly what the frontend proxy allows.

## Local host versions (forge-fhevm `3ee696f`, checked 2026-10-11)

`ACL v0.3.0`, `FHEVMExecutor v0.3.0`, `KMSVerifier v0.2.0`; one mock KMS signer,
threshold 1. The mainnet equivalents are pre-deploy checks in
[PRODUCTION-SETUP.md §3](../PRODUCTION-SETUP.md#3-pre-deploy-checks).

## Sepolia host (read 2026-10-13)

Read with `cast call` through a public Sepolia RPC, and from Zama's testnet
relayer and key bucket. Read them again before the Sepolia deploy: the host is
upgradeable.

| Fact | Value |
| --- | --- |
| `KMSVerifier.getVersion()` | `KMSVerifier v0.3.0` |
| `KMSVerifier.getKmsSigners()` / `getThreshold()` | 13 signers, threshold 7: a public-decryption proof with 7 valid signatures passes `checkSignatures` |
| `FHEVMExecutor.getVersion()` | `FHEVMExecutor v0.5.0` (≥ 0.3.0, as 0.11.1 needs) |
| `ACL.getVersion()`, `paused()`, `owner()` | `ACL v0.4.0`; not paused; owner `0x08e8a84c3c8c7cba165B1adcf67Ae4639eF84f52`, a contract |
| `InputVerifier.getVersion()` | `InputVerifier v0.2.0` |
| `GET /v2/keyurl` (`relayer.testnet.zama.org`, no API key) | One public key and one CRS (`2048`), each with one bucket URL and a placeholder dataId |
| Key download | Public key 33,018 bytes + CRS 4,571,368 bytes = 4,604,386 bytes (`Content-Length`, no `Content-Encoding`) |

Other reads at the same time: `InputVerifier` with 5 signers and threshold 3,
and a real decryption proof carrying 7 signatures. On a Sepolia fork,
`revealKey` used 395,303 gas with such a proof; it has not been measured on
Sepolia itself or on mainnet yet.

## Gas (Foundry, mock host, our compiler settings) ✅

| Step | Gas |
| --- | --- |
| `fromExternal(euint256)` + `allowThis` | ~160,000 |
| `makePubliclyDecryptable` | ~51,000 |
| `checkSignatures`, 1 mock signer | ~82,000 |

⏳ Mainnet `checkSignatures` will be higher (one `ecrecover` + signer check per
signature, threshold signers on mainnet). Measure on Sepolia before mainnet.
Whole-function figures (`createSwitch` ~430k for a 52-byte secret, `markDark`
~81k, `revealKey` ~141–150k, all with one mock signer) are in
[ARCHITECTURE.md §8](../ARCHITECTURE.md#8-gas).

## Not verified yet: needs Sepolia or mainnet ⏳

- Live relayer latency from `makePubliclyDecryptable` to a servable proof.
- Zama fee model for input verification and public decryption (who pays, and in what).
- Relayer API-key issuance and rate limits.
- Mainnet host executor version (affects only a future library upgrade, not this pin).
- Mainnet `KMSVerifier` threshold and signer count (Zama publishes a 9-of-13 decryption threshold; Sepolia's `KMSVerifier` accepts 7 of 13 signatures, above), and who holds the ACL owner and pauser roles on mainnet.
- The real relayer's job-id format and error shapes, and the mainnet `keyurl` key size.
