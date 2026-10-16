# Deploying the frontend on Railway

The frontend is a Next.js 16 app **with a server route**: `/api/relayer/<chainId>/…`
proxies the browser's FHE requests to Zama's relayer and adds the relayer API
key on the server. It therefore needs a Node server (`next start`); a static
export or a static host will not work.

The intended service settings are recorded in
[`frontend/railway.toml`](./frontend/railway.toml): `npm run build`,
`npm run start`, health check on `/` (60 s timeout), restart on failure (3
retries). **Railway does not apply that file on its own.** A config file does
not follow the Root Directory: Railway reads it only from the absolute path set
in the service settings (`/frontend/railway.toml`). Railway has also
deprecated config-as-code: services created after the cutoff cannot opt in,
and existing ones lose it on 2026-12-01. So set the values in the service
settings (§1 step 3). Without them a deployment counts as live as soon as its
container starts, and a crash-looping deploy replaces a healthy one. Node 22 is
selected through `frontend/.nvmrc`, `engines` and `RAILPACK_NODE_VERSION=22`
(`@zama-fhe/sdk` 3.6.0 requires it).

> **Before you start.**
>
> - **`NEXT_PUBLIC_RPC_URL_<chainId>` is required.** `next build` fails on
>   chain 1 or 11155111 when it has a deployment (current or previous, from
>   the variables or `lib/deployments.json`) and no RPC URL: viem's public
>   defaults cap or prune `eth_getLogs`, which makes switch discovery take
>   minutes. If a build fails for this reason, Railway keeps the running
>   deployment until a build succeeds. `ALLOW_PUBLIC_RPC=1` builds with the
>   default anyway (a throwaway build only).
> - **`NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>`** lists earlier deployments on
>   the same chain (`<address>:<deploy block>,…`) so their switches stay
>   listed and usable after a redeploy. See [§5](#5-redeploying-on-the-same-chain).
> - **Compiled-in deployments** live in `frontend/lib/deployments.json`
>   (`contracts`, `previousContracts`), not in `lib/deployments.ts`. The
>   variables take precedence; `next build` checks both.
> - **Next.js 16 with webpack.** Keep the build command `npm run build`
>   (`next build --webpack`): a plain `next build` uses Turbopack, which does
>   not build this app's webpack configuration. Supported browsers: Chrome,
>   Edge and Firefox 111+, Safari 16.4+.

## 1. Create the service

1. Railway → **New project** → **Deploy from GitHub repo** → this repository.
2. Service **Settings → Root directory**: `frontend`.
3. Service **Settings**, before the first build: **Deploy → Healthcheck path**
   `/` with a 60 s timeout; **Restart policy** on failure, 3 retries; custom
   **build command** `npm run build` and **start command** `npm run start`.
   If the service offers **Config-as-code → Railway config file** (older
   services only), you may instead set it to `/frontend/railway.toml`, until
   2026-12-01.
4. Set the variables below, then deploy. In the first deployment's logs,
   confirm that the health check on `/` ran and passed.
5. **Settings → Networking → Generate domain** (or add a custom domain).

Railway's health check runs only when a deployment starts. It is not
monitoring: watch the live site with an external uptime check
([PRODUCTION-SETUP.md §8](./PRODUCTION-SETUP.md#8-monitoring)).

## 2. Variables

`NEXT_PUBLIC_*` values are inlined into the browser bundle **at build time**:
change them, then redeploy. The relayer key is read **at runtime** by the
server route and never reaches the browser.

| Variable | When | Required | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_CONTRACT_11155111` / `NEXT_PUBLIC_CONTRACT_1` | build + runtime | at least one (or a compiled-in address) | The current `DeadManSwitch` deployment per chain: the one new switches are created on. A chain with no deployment, current or previous, is hidden. The relayer proxy also reads it at runtime and relays input proofs only for this contract, or else for the address in `lib/deployments.json` (a 403 `contract_not_configured` when there is neither, `contract_mismatch` when the page's contract differs). `next build` refuses a value that is not an address. Railway passes service variables to both build and runtime. |
| `NEXT_PUBLIC_FROM_BLOCK_11155111` / `_1` | build | yes, in practice | The current contract's deploy block. Without it, switch discovery scans from genesis. |
| `NEXT_PUBLIC_RPC_URL_11155111` / `_1` | build | **yes**, on a chain with a deployment | Provider RPC for reads, log scans and the FHE SDK's chain reads. `next build` fails without it (viem's public Sepolia default allows 101 blocks per `eth_getLogs`; others prune old logs). Its `eth_getLogs` must accept `NEXT_PUBLIC_LOGS_RANGE_CAP` blocks per call back to the deploy block. This URL is public (it ships in the bundle); use a key restricted by origin if your provider supports it. |
| `ALLOW_PUBLIC_RPC` | build | no | `1` lets `next build` use viem's default RPC where `NEXT_PUBLIC_RPC_URL_<chainId>` is missing. Throwaway builds only. |
| `NEXT_PUBLIC_PREVIOUS_CONTRACTS_11155111` / `_1` | build | after a redeploy on the same chain | Earlier deployments, comma-separated `<address>:<deploy block>` (e.g. `0xAbc…:7012345`). Their switches stay listed and usable (ping, cancel, top-up, release, reclaim); only creates go to the current contract. `next build` refuses a malformed entry. Never drop an address while a switch on it is not revealed or cancelled. |
| `NEXT_PUBLIC_LOGS_RANGE_CAP` | build | no | Max blocks per `eth_getLogs` (default 5000). Set it at or below your provider's span limit. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | build | yes, in practice | From cloud.reown.com. The code falls back to `"demo"`, which breaks mobile WalletConnect. |
| `ZAMA_RELAYER_API_KEY` | runtime | mainnet only | **Secret.** Sent upstream as `x-api-key`. Zama's Sepolia relayer is open, so a Sepolia-only deploy needs no key. On mainnet, without it, `/api/relayer/1` answers `relayer_not_configured` (a 503 on `keyurl`, a 403 on the SDK's paths) and browsers cannot create switches or fetch keys. |
| `ZAMA_RELAYER_API_KEY_11155111` / `_1` | runtime | no | Per-chain keys. When set to a non-empty value, they take precedence over `ZAMA_RELAYER_API_KEY` for that chain; an empty or blank value falls back to it. |
| `ZAMA_RELAYER_URL_11155111` / `_1` | runtime | no | Relayer override; https only. Defaults: `https://relayer.testnet.zama.org`, `https://relayer.mainnet.zama.org`. |
| `NEXT_PUBLIC_ENABLE_LOCAL_CHAIN` | build | — | **Never set in production.** Enables chain 31337 for local development. |

Never give the relayer key a `NEXT_PUBLIC_` prefix: that would publish it in
the JavaScript bundle. Only Ethereum mainnet and Sepolia are supported, because
Zama's host only exists there.

## 3. Check the deployment

```bash
D=https://<your-domain>
curl -s -o /dev/null -w "%{http_code}\n" $D/                                  # 200
curl -s -i $D/api/relayer/11155111/v2/keyurl | head -20                       # 200 JSON with key URLs (no key needed on Sepolia)
curl -s -o /dev/null -w "%{http_code}\n" $D/api/relayer/137/v2/keyurl         # 404: chain not allowed
curl -s -o /dev/null -w "%{http_code}\n" -X PUT $D/api/relayer/11155111/v2/keyurl   # 405
```

Then, in a browser on the deployed site: create a switch on Sepolia (the first
encryption downloads Zama's FHE public key and CRS, about 4.6 MB, directly from
Zama's bucket, not through Railway, and caches them in IndexedDB), and load
`/archive` with no wallet connected.

## 4. Operations

- **Replicas.** The proxy's rate limit (per IP per minute: keyurl 30,
  input-proof 10, public-decrypt 20, polling 120) is held in memory per
  instance and keyed on the first `X-Forwarded-For` entry, which Railway's
  edge sets. Run one replica, or put a shared rate limiter in front.
- **Logs.** `keyurl` answers a configuration error with a 503 and its label,
  and throttling or upstream failures with 429 / 502 / 504. The SDK's paths
  (input proof, public decrypt, their polls) answer the way the SDK retries
  on: configuration errors are 403s whose message starts with the label
  (`relayer_not_configured`, `relayer_misconfigured`,
  `contract_not_configured`, `contract_mismatch`); the proxy's own throttle is
  a 429 `rate_limited` on a POST and a 202 `queued` (request id
  `proxy-throttled`) on a poll. An upstream network failure gets a 429
  `protocol_overload` / 202 `queued` (`proxy-upstream-retry`) twice in a row
  for the same request (per client address, endpoint and body; per job for a
  poll, within 2 minutes); the third gets a 502 (504 on a timeout), which ends
  the SDK's job and shows the user a relayer error. Watch for any
  configuration label, and for 502/504 or `proxy-upstream-retry` lasting
  minutes (relayer unreachable). `contract_mismatch` right after a redeploy is
  usually a browser tab loaded before it; the page tells the user to reload.
  See [PRODUCTION-SETUP.md §8](./PRODUCTION-SETUP.md#8-monitoring).
- **Caching.** `/api/relayer/*` responses carry `cache-control: no-store`;
  do not put a caching CDN rule in front of them.
- **Headers.** `next.config.js` sets `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options: DENY`, `Strict-Transport-Security`
  (two years, `includeSubDomains`), a `Permissions-Policy` that turns off
  camera, microphone, geolocation, payment, USB, serial, HID, Bluetooth and
  topics, and a CSP limited to `frame-ancestors`, `object-src`, `base-uri` and
  `form-action` (tested in `lib/nextConfig.test.ts`). `includeSubDomains`
  also forces https on every subdomain of the host that serves the app, so
  on a custom apex domain check that nothing under it still needs plain http.
  A full CSP must allow inline scripts: every page is prerendered and
  hydrates from inline scripts, so nonces are not available. A starting point,
  to replace the current header (a second CSP header would be enforced on top
  of it, not instead of it):

  ```
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';
  worker-src 'self' blob:;
  connect-src 'self' <RPC hosts> <Zama key-bucket host>
    wss://relay.walletconnect.org https://pulse.walletconnect.org;
  frame-src https://verify.walletconnect.org https://verify.walletconnect.com;
  img-src 'self' data: https:;
  style-src 'self' 'unsafe-inline';
  frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'
  ```

  The host list has not been checked in a browser; wallet SDKs may open
  further sockets. Ship it as `Content-Security-Policy-Report-Only` first, try
  each wallet, and add what the console reports before enforcing it.

## 5. Redeploying on the same chain

The contract is immutable. A new deployment on the same chain does not move
the old one's switches: they stay live, their owners must still ping them, and
an owner who cannot find a switch has its secret released when it goes dark.
So the old address is never dropped; it becomes a previous deployment.

1. Deploy the new contract ([PRODUCTION-SETUP.md §4 / §6](./PRODUCTION-SETUP.md#4-deploy-to-sepolia))
   and note its address and deploy block.
2. Set the variables in one go, with `--skip-deploys`:
   `NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>` gains
   `<old address>:<old deploy block>` (keep any entries already there,
   comma-separated); `NEXT_PUBLIC_CONTRACT_<chainId>` and
   `NEXT_PUBLIC_FROM_BLOCK_<chainId>` become the new address and block. If the
   old address is compiled in (`lib/deployments.json` `contracts`), move it to
   `previousContracts` as `"<address>:<deploy block>"` in the same commit.
3. Redeploy the service once. `next build` refuses a malformed entry. Old
   switches show an "Older deployment" pill, and their writes go to the old
   contract; creates go to the new one. Old links without `?contract=` are
   looked up on every deployment. A tab opened before the rebuild that tries
   to create is told the page is out of date and to reload.
4. Move watchers as [PRODUCTION-SETUP.md §6](./PRODUCTION-SETUP.md#redeploying-on-the-same-chain)
   describes: a watcher works on one contract and one state file.
5. Keep the old address listed until every switch on it is revealed or
   cancelled. To stop creates without a successor, unset
   `NEXT_PUBLIC_CONTRACT_<chainId>` and list that address as previous: the
   chain stays usable for its switches, with creates and the admin page off.

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Build fails on Node version | The builder must use Node 22 (`.nvmrc`, `engines`, `RAILPACK_NODE_VERSION=22`). |
| Build fails: "Deployment variables: … `NEXT_PUBLIC_RPC_URL_<chainId>` is required when chain … has a deployment" | Set `NEXT_PUBLIC_RPC_URL_<chainId>` to a provider URL (§2). `ALLOW_PUBLIC_RPC=1` only for a throwaway build. Railway keeps the running deployment meanwhile. |
| Build fails: "… is set but is not an address" or "… entries that are not `<address>:<deploy block>`" | Fix `NEXT_PUBLIC_CONTRACT_<chainId>`, `NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>` or `lib/deployments.json`. |
| Build fails after the build command was changed to `next build` | Next 16 builds with Turbopack by default, which does not build this app's webpack configuration. Use `npm run build` (`next build --webpack`). |
| "This page is out of date … Reload the page and try again" when creating | The tab was loaded before the site was rebuilt for a new contract (`contract_mismatch`); reloading fixes it. If it persists after a reload, the build and the server disagree on `NEXT_PUBLIC_CONTRACT_<chainId>`: redeploy so they match. |
| "This server's Zama relayer proxy is not set up for this network …" when creating or fetching a key | On mainnet: `ZAMA_RELAYER_API_KEY` missing or blank, and no non-empty `ZAMA_RELAYER_API_KEY_1` (`relayer_not_configured`). A bad `ZAMA_RELAYER_URL_<chainId>` (`relayer_misconfigured`). On any chain, when creating: no `NEXT_PUBLIC_CONTRACT_<chainId>` at runtime and no compiled-in address (`contract_not_configured`). |
| Create fails with `contract_not_configured` | `NEXT_PUBLIC_CONTRACT_<chainId>` not set at runtime (and no address in `lib/deployments.json`). |
| A chain does not appear in the wallet list | No deployment for it at build time (`NEXT_PUBLIC_CONTRACT_<chainId>`, `NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>` or `lib/deployments.json`); redeploy after setting one. |
| Switches from before a redeploy are gone | The old address is not in `NEXT_PUBLIC_PREVIOUS_CONTRACTS_<chainId>` (§5). Add it with its deploy block and redeploy. |
| Switch lists slow or empty | `NEXT_PUBLIC_FROM_BLOCK_<chainId>` unset, or the RPC caps `eth_getLogs` below `NEXT_PUBLIC_LOGS_RANGE_CAP` or has pruned the logs back to the deploy block; lower the cap or use another provider. |
| Mobile wallets cannot connect | Set a real `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`. |
| Key fetch keeps "waiting" after `markDark` | KMS still producing the proof, or relayer trouble; check `/api/relayer` status codes for upstream errors. The hunt panel says which it is waiting for. |
