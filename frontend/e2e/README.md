# Browser end-to-end tests

Playwright drives the real app (`next build` + `next start`) against a local
Anvil running Zama's forge-fhevm mock host and a fresh `DeadManSwitch`. The
local chain uses the SDK's `cleartext()` mode: no relayer, no FHE key
download, nothing leaves the machine (other hosts are blocked).

13 specs, 30 tests, plus the screenshot spec, which is skipped unless
`E2E_SCREENS=1`. Run it before merging frontend changes. It needs Foundry (anvil, forge, cast), `jq`,
`curl`, Node 22, `npm ci` in `frontend/` and `client/`, and Playwright's
Chromium (`npx playwright install chromium`).

```bash
npm run test:e2e                                  # from frontend/: the whole stack, then every spec
../scripts/browser-e2e.sh -g cancel               # extra arguments go to `playwright test`
../scripts/browser-e2e.sh e2e/specs/03-hunter     # one file (a bare "03" also matches digits in the absolute path)
../scripts/browser-e2e.sh e2e/specs/13-crosswire  # only the CLI / watcher / UI cross-component tests
E2E_HEADED=1 npm run test:e2e                     # watch it
E2E_SCREENS=1 E2E_SCREENS_DIR=/tmp/screens ../scripts/browser-e2e.sh e2e/screens.spec.ts   # the UI screenshot set
```

`scripts/browser-e2e.sh` starts Anvil on 18600 and the app on 3100, runs the
specs and always stops both (by pid). Its header lists the knobs
(`E2E_ANVIL_PORT`, `E2E_PORT`, `E2E_OUTPUT_DIR`, `E2E_REUSE_BUILD`,
`E2E_STACK_ONLY`, …). For quick iterations keep a stack up with
`E2E_STACK_ONLY=1 ../scripts/browser-e2e.sh` and, in another shell, run
`npx playwright test` with the `E2E_BASE_URL`, `E2E_RPC_URL` and
`E2E_DMS_ADDRESS` it prints.

## How it works

- **Test wallet** (`support/injected-wallet.ts`): an EIP-1193 provider added
  with `addInitScript`, announced over EIP-6963, so RainbowKit lists it under
  "Installed" and every test connects through the real modal. It forwards
  JSON-RPC to Anvil (dev accounts are unlocked, so nothing is signed),
  answers `eth_chainId` with the chain it pretends to be on, supports
  `wallet_switchEthereumChain` / `wallet_addEthereumChain`, and emits
  `accountsChanged` / `chainChanged`. Test hooks (`support/wallet.ts`):
  switch account (`owner` = anvil #1, `hunter` = #2, `funder` = #3, `admin` =
  #0, the deployer), report another chain, make the next prompt a user
  rejection (4001), broadcast a transaction and then lose the response
  (`failNext(…, "lose-response")`), or hold the next prompt open until
  released (`holdNext` / `releaseHeld`). It logs every request it handled.
- **Time**: deadlines pass with `evm_increaseTime` + `evm_mine`
  (`chain.travel`). The UI notices at its next chain-clock poll (12 s); tests
  wait on visible state, never on fixed sleeps.
- **Diagnostics** (`support/diagnostics.ts`): every test records console
  errors and warnings, failed requests, HTTP errors, uncaught page errors and
  the JSON-RPC traffic to Anvil, writes `diagnostics.json` (and, for a failed
  test, `rpc-log.txt`) next to its artifacts, and **fails on any uncaught page
  error**. Other hosts (WalletConnect, RainbowKit telemetry) do not resolve
  in the test browser (a Chromium host-resolver rule, so Anvil traffic never
  detours through the test runner); those failures are counted apart.
- **Isolation**: one worker, files in order; each test creates the switches it
  needs, so any spec can run alone. `actor(role)` opens another browser (a
  second person) watched the same way.
- **The client** (`support/cli.ts`, fixture `cli`): the cross-component spec
  runs the real `dms` CLI and watcher from `client/dist` (built by
  `scripts/browser-e2e.sh` when missing or older than `client/src`; needs
  `npm ci` in `client/`) as subprocesses against the same Anvil and contract.
  They sign with the same dev keys as the browser roles (owner #1, hunter #2,
  funder #3, admin #0); the watcher uses #4. Each process gets a clean
  environment and runs in the test's output directory, so `client/.env` and
  `client/watcher.config.json` never apply. Every command, its exit code and
  its output are attached to the test as `client-log.txt`.

## Specs

| File | Covers |
| --- | --- |
| `01-owner-create-ping` | create (1 min, small bounty) → dashboard card, state, countdown → ping moves the deadline; the dashboard lists a just-created switch without a reload (F1) |
| `02-funder-top-up` | account switch on the switch page → top-up → bounty and stake update |
| `03-hunter-release` | deadline passes → dark → /hunt → mark dark → fetch key → verify → reveal (bounty paid) → exact plaintext as text → publish → /archive; read without a wallet |
| `04-cancel-reclaim` | top-up, cancel behind its confirmation → never claimable after time travel → funder reclaims |
| `05-errors` | wallet rejection on ping; malformed `/switch/…` links; network guard for another chain and the switch-back |
| `06-admin` | admin page as the deployer; read-only for anyone else |
| `07-create-retries` | rejected create retried with the same id; lost wallet response adopted from chain, never re-sent; "Create another" |
| `08-lost-wallet-response` | lost response on ping and top-up: the top-up is neither reported as reverted nor offered again (F2) |
| `09-rescue` | 30 days past the deadline: owner and funder reclaim, a late release still lands |
| `10-two-hunters` | two browsers: the second follows the first one's mark dark and reveal; a hunter acting on a stale card is stopped before the wallet, with the reason (F3) |
| `11-wallet-session` | reconnect after reload, disconnect, the app's connect prompt, account switching on the dashboard; the "Switch created" card is not shown to another account (F4) |
| `12-untrusted-plaintext` | a 2,048-byte secret with markup, a bidi override and a control character comes back inert and flagged; 2,049 bytes is refused |
| `13-crosswire` | contract + CLI + watcher + UI on one chain. **A** a `dms create` switch on the owner's dashboard and page (technical details match the CLI's output), released by the UI hunter, then `dms read` returns the exact bytes and a `dms publish` shows on the page. **B** a UI-created switch discovered by `watcher --once`, left alone before its deadline, then marked, revealed, archived and published in one pass (exact bytes, exact bounty accounting); the open page follows to REVEALED with the text. **B2** a UI-created switch released with `dms mark-dark` + `dms reveal --publish --out`. **C1** CLI ping / fund-bounty / cancel on an open page; a UI reclaim in `dms info`. **C2** UI ping / top-up / cancel in `dms info`; the CLI refuses mark-dark on the cancelled switch; a CLI reclaim on the page. **C3** a UI admin nomination and its cancellation in `dms status`. **C4** (F5) an open page follows a contribution its viewer made from the CLI. **F6** invisible characters the CLI escapes are neutralised and flagged in the UI too |

## Screenshot set (`e2e/screens.spec.ts`)

Skipped unless `E2E_SCREENS=1`. It drives the app into every page and state
worth a design review (home, docs, the connect and account modals, every
stage of the create flow, each switch state from alive to published,
cancelled and rescuable, the hunter's steps, /hunt with a second page,
/archive, /admin, the network guard, bad links, the 404 page, a pending
transaction, success and error toasts) and saves full-page PNGs to
`$E2E_SCREENS_DIR/<viewport>/<NN>-<page>-<state>.png` (default
`test-results/screens`) at `desktop` (1440x900) and `mobile` (390x844, touch,
2x). A `desktop-dark` set is added only if the app renders differently under
`prefers-color-scheme: dark` (it checks first). `index.json` lists every shot
with its page, state and viewport, the console errors, page errors and failed
requests seen while reaching it, and any state it could not capture, with the
reason. Run it on a fresh stack (the empty lists need a contract without
switches); it moves the chain clock by 31 days. Transient states are held
still, not raced: the FHE library's script chunks are held at the network,
the test wallet holds `eth_sendTransaction` open (`holdNext`), and Anvil's
automine is off while a sent transaction is on screen.

Tests named after a finding (F1–F6, with a `FINDING` comment above each)
were written as `test.fixme` against known app bugs, asserting the intended
behaviour. The bugs are fixed and the tests enabled; the comments still describe the bug each one caught.
Mark a new known bug the same way, and remove `.fixme` once it is fixed.

The app has no `data-testid` hooks; the helpers in `support/app.ts` use
roles, labels and visible text (RainbowKit's own `rk-*` test ids for its
buttons). Where they lean on markup structure (a card's countdown and
summary values) a test id would make them sturdier.
