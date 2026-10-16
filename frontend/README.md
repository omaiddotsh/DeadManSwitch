# DeadManSwitch — frontend

Next.js 16 app for the Zama fhEVM `DeadManSwitch`: create and ping switches,
fund bounties, hunt dark switches, and read released secrets. It includes one
server route, `/api/relayer`, which proxies the browser's FHE requests to
Zama's relayer so the relayer API key never reaches the browser.

**Status (2026-10-13).** Typecheck, lint, 632 unit tests (3 more opt-in) and
`next build` pass. The Playwright browser suite ([`e2e/`](./e2e/README.md), 13
specs, 30 tests) passes against a local Anvil with Zama's mock host, including
specs that drive the real CLI and watcher on the same chain. The browser path to the real relayer was exercised only up to the
input-proof request against a fake upstream; nothing has run against Sepolia
or Zama's real relayer and KMS.

Stack: Next.js 16 (App Router, built with webpack), React 19, wagmi 2 + viem + RainbowKit,
TanStack Query, Tailwind 3, `@zama-fhe/sdk` 3.6.0. Node 22. Browsers (Next 16's
targets): Chrome, Edge and Firefox 111+, Safari 16.4+.

## Quick start

Local chain (no relayer, no API key):

```bash
KEEP_ANVIL=1 SKIP_E2E=1 ../scripts/local-e2e.sh      # anvil :8545 + Zama mock host + DeadManSwitch; prints DMS_ADDRESS
npm ci
# replace 0x… with the DMS_ADDRESS printed above
cat > .env.local <<EOF
NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=1
NEXT_PUBLIC_CONTRACT_31337=0x…
NEXT_PUBLIC_RPC_URL_31337=http://127.0.0.1:8545
EOF
npm run dev                                           # http://localhost:3000
```

Use an Anvil dev account in your wallet. To make a switch go dark, advance
your own node's clock: `cast rpc evm_increaseTime 120 && cast rpc evm_mine`.

Sepolia or mainnet: copy `.env.example` to `.env.local`, set
`NEXT_PUBLIC_CONTRACT_<chainId>`, `NEXT_PUBLIC_FROM_BLOCK_<chainId>`,
`NEXT_PUBLIC_RPC_URL_<chainId>`, `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, and the
server-only `ZAMA_RELAYER_API_KEY` (mainnet only; Sepolia's relayer is open). The per-chain `ZAMA_RELAYER_API_KEY_<chainId>`
lines ship commented out; one overrides the global key only when it is set to a
non-empty value (an empty or blank value falls back to `ZAMA_RELAYER_API_KEY`).
`next build` refuses to build a public chain that has a deployment but no
`NEXT_PUBLIC_RPC_URL_<chainId>` (`ALLOW_PUBLIC_RPC=1` overrides that, for
throwaway builds), and refuses malformed addresses. After a redeploy on the
same chain, list the old contract in `NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>`
(`<address>:<deploy block>,…`) so its switches stay usable. Deployments can
also be compiled in, in `lib/deployments.json`. Every variable is described in
[`.env.example`](./.env.example) and [../RAILWAY-DEPLOY.md](../RAILWAY-DEPLOY.md).

## Routes

| Route | |
| --- | --- |
| `/` | What it is, how it works, roles, risks. |
| `/dashboard` | Create a switch; your switches with ping, cancel, rescue and fund actions. |
| `/hunt` | Every switch, filterable (claimable, alive, revealed, all) and sortable; the reveal flow. |
| `/archive` | Released switches, readable without a wallet. |
| `/switch/[chainId]/[owner]/[id]?contract=<address>` | Shareable page for one switch, on the deployment `?contract=` names. Reads on the URL's chain whatever the wallet is on. A link without `?contract=` (an older link) is looked up on every deployment of the chain; if it matches two, or one could not be read, the page shows no actions, only links to each. |
| `/admin` | Contract settings (readable by anyone); admin and pending-admin actions. |
| `/docs` | Mechanism, trust model, risks, FAQ. |
| `/api/relayer/[chainId]/[...path]` | Server-side relayer proxy (chains 1 and 11155111). |

## What happens in the browser

**Create.** The secret (max 2,048 UTF-8 bytes) is sealed with
`lib/envelope.ts` (v1 format: `0x01 ‖ nonce ‖ AES-256-GCM(dek, salt ‖ plaintext)`,
commitment `keccak256(salt ‖ plaintext)`) under a fresh random key. The key is
FHE-encrypted with `lib/fhevm.ts` (`encryptDek`), then `createSwitch` is sent.
The first encryption in a browser downloads Zama's FHE public key and CRS
(about 4.6 MB on Sepolia) from Zama's bucket via the proxy's `keyurl`, with
byte progress, and caches them in IndexedDB, keyed on the bucket URLs and
dataIds (Sepolia's dataIds are constant placeholders). A cached key is dropped
once if Zama rejects an input proof made with it. The download is warmed when
the user starts typing. The secret and key are cleared from the form after
success. Cancelling, or leaving the page, before the wallet prompt stops the
create there.

Retries are idempotent (`lib/createAttempt.ts`), so a retry can never leave
a second live switch holding the same secret. The switch id is drawn once per
form session and reused by every retry, and before resealing the page reads
the switch at (owner, id): if an earlier send landed, that is the success and
nothing new is sent. Once the wallet has returned a tx hash, a receipt timeout
or RPC error shows "Waiting for confirmation" with the hash, the switch id and
an explorer link, polls every 10 s, and never offers a fresh create. A retry
(same id) opens only after the receipt reverts or the node has not seen the
tx for about 5 minutes (31 polls in a row, `VANISHED_AFTER_POLLS`). The wait
is that long because wallets with private orderflow (MetaMask Smart
Transactions, Flashbots Protect) keep a tx out of public mempools until it is
mined. Even then the page says "Not confirmed", not "failed", and asks the
owner to check the wallet's activity first. A wallet that cancels the tx (a replacement that is
not a plain repricing) counts as not created, and stays so on later polls.
"Reverted" is never final for the switch: an earlier send of the same id may
have landed first (the retry then reverts `AlreadyExists`), and a
load-balanced RPC can answer a state read from a node behind the receipt. So
the page confirms a reverted receipt with a state read at a block no older
than the receipt's, re-checks the switch for about five minutes afterwards
(10, 20, 40, 80 and 160 s apart; "Check again" restarts that), and adopts it
as created whenever it appears. Until then "reverted" stands, with the retry
form: a later failed or lagging read does not turn it back into "waiting".
Starting a new switch from another account or network is behind a warning,
and the page re-reads the switch three times, 1.5 s apart (`dropAttempt`),
before it drops the attempt; if the switch exists it is shown as created, and
if the reads fail nothing is dropped. Nor is an attempt whose wallet prompt is
still open in the page: approving it later would send a create nothing tracks.
Each resend starts without a hash, so an ambiguous wallet error on a resend
reads as "sent, hash unknown" and the page keeps checking until the switch
lands. `{chainId, contract, owner, id, submitted, hash}` (never the secret,
key or ciphertext) is kept in `sessionStorage` under `dms:create-attempt:v1`,
so a reload in the same tab resumes the check. Owners should keep the tab open
(or reload it) until it shows "Switch created"; whoever closes it earlier
should check that the switch appears under Your switches on the dashboard.

**Other writes** (ping, top-up, cancel, reclaims, mark dark, reveal, publish,
admin actions) go to the switch's own contract, current or previous, and are
tracked per tab by `lib/pendingWrites.ts`. Each sent write is recorded by
chain, contract, switch and function (and, for top-ups and reclaims, sender),
and a second one with the same target is refused before the wallet until the
first settles, whichever page or card sends it. A reload resumes its receipt
wait. Before the wallet opens, every write but ping and cancel (which race the
deadline and open the wallet at once) is dry-run for at most 2 s: a revert that
decodes to the contract's or Zama's host errors, or a plain `Error(string)` /
`Panic` (shown as one plain line of at most 160 characters), is refused with
its reason and nothing is sent. A write mined as a revert is replayed to name
the cause. For a ping or cancel
that is stuck, the page says to speed it up in the wallet (same transaction,
higher fee) before the deadline: a second one would queue behind it. A top-up
whose wallet answered with an error instead of a hash (a WalletConnect request
that expired, a wallet RPC failing after broadcast) may still have been sent:
it is recorded without a hash and blocks a resend until the switch shows it,
the account's nonce moves without it, or the user confirms nothing was sent.
A top-up that then appears on the switch is matched to the transaction at its
sender and nonce and reported as done; if another transaction grew the stake,
it is reported neutrally. A value-carrying write the app's RPC cannot see is
never called safe to send again. A write from a contract account (a Safe, a
4337 account; not an EIP-7702-delegated EOA) is followed through the wallet
(EIP-5792 `wallet_getCallsStatus`, then the wallet's own receipt), and counts
as done only when the receipt carries the write's own event from the switch's
contract, for this switch and, where the event names one, this sender, with no
Safe `ExecutionFailure`; otherwise the page says to check the wallet. Its
request id is not linked as an explorer transaction. The record keeps only public transaction data (chain, contract, switch,
function, hash, sender, nonce, value, send time, the sender's stake before a
top-up) in `sessionStorage` under `dms:pending-writes:v1`. After a write is
mined, its switch is read for two minutes at a block no older than the
receipt's, so a lagging RPC node does not offer the action just done again.

**Hunt.** Six steps: mark dark → fetch the key from the KMS (`publicDecryptDek`,
one handle per call, retried while the KMS is still working) → verify the key
opens the ciphertext → reveal and claim (exact gas estimate, net profit shown)
→ decrypt → optionally publish. Hunters never download the FHE public key.

**Read.** For a revealed switch the browser reads `getCiphertext` and
`getRevealedKey`, decrypts locally and shows "Tag verified" and "Commitment
verified" badges, plus the `PlaintextPublished` event if one exists.

## Security behaviour

- **Key check.** Every key (from the KMS or from chain) is checked against the
  ciphertext's AES-GCM tag. If it fails, the UI shows "Key accepted by the KMS
  proof but does not open the ciphertext — the owner uploaded an invalid
  ciphertext, or Zama's KMS signer set was compromised." and revealing requires
  an extra "reveal anyway" confirmation.
- **Untrusted plaintext.** `components/switch/PlaintextView.tsx` is the only
  way plaintext is shown: a single text child of a `<pre>`, never HTML, never
  auto-linked; control and bidi-override characters are neutralised and
  flagged. Invisible characters that can carry hidden text (format and tag
  characters, zero-width characters, variation selectors outside an emoji,
  Hangul fillers, line and paragraph separators, a byte-order mark after the
  start; the CLI's set) are shown as visible `\u{…}` escapes in the display and
  in the copied text, and flagged (`toDisplayText`, `hadInvisibleChars`). Kept
  as text: one presentation selector after an emoji, joiners inside emoji and
  between letters, format characters that are drawn (Arabic number signs, the
  Syriac abbreviation mark), and a leading byte-order mark is dropped, as
  editors write it. One ideographic selector after a CJK ideograph and one
  Mongolian selector after a Mongolian letter are kept but flagged
  (`hadVariationSequences`), since each can carry a hidden byte. "Download"
  saves the exact bytes as `application/octet-stream`. When a published plaintext
  differs from the decrypted bytes, both are shown, the published one labelled
  as commitment-checked by the contract.
- **Relayer key.** The browser SDK's relayer URL is
  `${origin}/api/relayer/<chainId>`. The proxy (`app/api/relayer/proxy.ts`)
  adds `x-api-key`, allows only the five endpoints the SDK uses for encrypt and
  public decrypt, accepts input proofs only for this app's contract and chain
  and public decrypts only for one `euint256` handle of this chain, caps bodies,
  times out, never follows redirects, redacts the key from responses and
  rate-limits per IP. On the SDK's paths it answers its own throttles and
  upstream failures the way the SDK retries on (a 429 `rate_limited` /
  `protocol_overload` on a POST, a 202 `queued` on a poll); an upstream
  failure only twice in a row for the same request, after which a 502/504 ends
  the job and the page shows a relayer error (the hunt retries it). It answers
  configuration errors as 403s whose message starts with their label, which
  the app shows as "the operator must fix the server", except
  `contract_mismatch`, which means the tab was loaded for another contract
  than the site now uses: the page says to reload. Input proofs are relayed
  only for the chain's current contract, by the same rule as the bundle's
  (`lib/deployments.ts`).
- **Headers.** `next.config.js` sends HSTS, a `Permissions-Policy`, a CSP
  limited to `frame-ancestors`, `object-src`, `base-uri` and `form-action`,
  `X-Frame-Options: DENY`, `nosniff` and a referrer policy (tested in
  `lib/nextConfig.test.ts`). The image optimizer is off (no `next/image`).
- **Chains.** Only Ethereum mainnet and Sepolia, plus Anvil when
  `NEXT_PUBLIC_ENABLE_LOCAL_CHAIN=1`. Writes are gated on the wallet being on
  the viewed chain.
- **Deployments.** A chain has one current deployment, the only one creates go
  to (`NEXT_PUBLIC_CONTRACT_<chainId>`, else `lib/deployments.json`), and any
  number of previous ones (`NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>`, then
  `lib/deployments.json`). Lists scan all of them; a switch on a previous one
  shows an "Older deployment" pill. A contract the app does not know is never
  read or written. A chain with only previous deployments stays usable for
  their switches, with creates and the admin page off.
- **Irreversible owner and admin actions** (cancel, admin transfer, renounce)
  require an explicit confirmation panel with a ticked acknowledgement;
  transfer and renounce also need a typed phrase. Under 36 s of chain time
  before the deadline, a cancel needs a second acknowledgement that it may be
  mined too late, revert and leave the switch dark (a ping or top-up there gets
  a warning). The cancel panel separates the owner's escrow (refunded) from the
  owner's own top-ups and other funders' contributions (each reclaimed
  separately).
- **Addresses of parties** (a switch's owner, a publisher, the admin) are
  shown in full: a shortened `0x1234…abcd` keeps 32 bits, which a vanity
  address can match.
- **Funders** are told before funding that a contribution cannot be withdrawn
  while the owner keeps pinging.

## Scripts

```bash
npm run dev            # next dev --webpack
npm run build          # next build --webpack (next.config.js customises webpack; Next 16 defaults to Turbopack); checks the deployment variables
npm run start          # next start (serves the API route; needed in production)
npm run lint           # eslint .   (`next build` does not lint; run this before a release)
npm run typecheck      # tsc --noEmit (whole project)
npm run typecheck:lib  # lib/ and app/api/ only
npm test               # vitest (632): test vector, relayer proxy policy and SDK answers, create-retry state machine, in-flight writes, dry runs and smart-account writes, deployments, error decoding, switch and FHE helpers, plaintext rendering, UI fixes, headers, build checks, gas model
npm run test:local     # opt-in (3 tests): real SDK against a local chain (DMS_LOCAL_RPC, DMS_LOCAL_CONTRACT); warps time and toggles automine, so it refuses :8545 unless DMS_LOCAL_ALLOW_WARP=1
npm run test:e2e       # Playwright browser suite (13 specs, 30 tests) on its own Anvil and server; see e2e/README.md.
npm run gen:abi        # regenerate lib/abi.ts from ../contracts/out
npm run check:abi      # fail if lib/abi.ts is stale
```

## Code map

| Path | |
| --- | --- |
| `lib/envelope.ts` | v1 seal/open, commitment, `checkKey`, `INVALID_KEY_WARNING`, `toDisplayText`. |
| `lib/fhevm.ts` | SDK loading (dynamic import, browser only), FHE key download and cache, `encryptDek`, `publicDecryptDek`, typed `FhevmError`s (`RELAYER_ERROR`, `STALE_PAGE`, …). |
| `lib/hooks.ts` | Reads (floored at a recent write's receipt block), the chain clock (holds against a late block, re-anchors after a device clock step), write hooks (`runWrite`, `useTxRunner`, `waitForWrite`: in-flight tracking, dry runs, refresh after failed writes, replacement and speed-up detection, long receipt waits, smart-account writes followed through the wallet), `useCreateSwitch` (and its poll, `pollAttempt`), `useKmsKey`, `ChainScope`. |
| `lib/pendingWrites.ts` | The per-tab store of sent writes and its `sessionStorage` record (public transaction data only); `WriteInFlightError`, `WriteUnconfirmedError`; pure, 25 tests. |
| `lib/switchScan.ts` | `SwitchCreated` discovery: chunked `eth_getLogs` with bounded concurrency, rate-limit backoff vs range halving (a fixed span cap is not re-probed), "pruned history" retried on the same range, resume after failure, and a per-browser `localStorage` cache keyed by chain, contract and `FROM_BLOCK`; a later scan restarts after the last finalized block the previous one saw (12 blocks back on a node without a `finalized` tag). Also `findPublishedPlaintext`, a topic-filtered lookup bounded by the reveal time. |
| `lib/createAttempt.ts` | The create-retry state machine (`runCreate`, `planSubmit`, `classifyAttempt`, `pollStep`, `errorTitle`) and its `sessionStorage` records (the in-flight attempt and the finished create, never secret material); pure, 93 tests. |
| `lib/switch.ts`, `lib/contracts.ts`, `lib/deployments.ts`, `lib/deployments.json`, `lib/errors.ts`, `lib/abi.ts` | Constants, state names and switch links (`switchPath`, with `?contract=`); chains and every deployment per chain; the deployment rule shared by the bundle and the relayer proxy, and the compiled-in deployments; revert messages, including Zama's host-contract errors; generated ABI. |
| `next.config.js` | Security headers, the webpack settings, and the deployment-variable checks `next build` runs (`deploymentEnvProblems`). |
| `app/api/relayer/` | The proxy (`proxy.ts`; 82 tests in `proxy.test.ts`, 18 against the SDK's own request loop in `proxy.sdk.test.ts`) and its route. |
| `components/CreateSwitchForm.tsx`, `components/switch/*` | Create form; switch cards, owner and funder actions, reveal panel, revealed view, plaintext view, the chooser for an old link that matches two deployments. |
| `components/ui/*`, `components/amount.ts` | Shared UI (`Address` in full, `ConfirmPanel`, `PendingTx`, toasts); typed amounts (a decimal comma reads as a point). |
| `components/gas.ts` | Gas estimates calibrated locally (one mock signer); public chains add margins. Re-measure on Sepolia: on a Sepolia fork `revealKey` used 395,303 gas against the 250,000 assumed. |
| `e2e/`, `playwright.config.ts` | The browser suite ([e2e/README.md](./e2e/README.md)); run through `../scripts/browser-e2e.sh`. |

## Known limitations

- Not run against Sepolia or Zama's real relayer and KMS yet.
- Writes from smart accounts (Safe, 4337) are tested only against a test
  wallet. A create from a Safe takes the generic "Waiting for confirmation" /
  "Not confirmed" path until the switch appears on-chain.
- `lib/wagmi.ts` falls back to WalletConnect project id `"demo"`.
- The proxy's rate limit is per instance.
- The scan cache stops growing once it outgrows `localStorage` (about 9,000 to
  10,000 switches); later visits scan again from the last snapshot that fit.
- The cached FHE key has no integrity check and is not revalidated.
- A link without `?contract=` is not rewritten to the switch's own link.
- `lib/useTx.ts` is unused and does not follow smart-account writes.
- WASM runs single-threaded (threads would need COOP/COEP headers, which break
  wallet pop-ups); a ZK input proof took about 5 s in headless Chromium.
- The ciphertext length (secret length + 61 bytes) is public before release.
- Browsers older than Chrome, Edge and Firefox 111 or Safari 16.4 are not
  supported.
