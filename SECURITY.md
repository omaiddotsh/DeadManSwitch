# Security

DeadManSwitch has **not had an external audit** and is not deployed to
mainnet. Do not store anything you cannot afford to leak early or never
release. The trust and threat models are in
[ARCHITECTURE.md](./ARCHITECTURE.md#6-trust-model).

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Do not open a public issue for anything that could put funds or secrets at
risk.

Include the affected component (contract, client, frontend or relayer proxy),
the commit you tested, and steps or a proof of concept. You should get a reply
within a few days.

## Scope

In scope: `contracts/src/DeadManSwitch.sol` and its deploy script, the CLI and
watcher in `client/`, and the frontend in `frontend/`, including the
`/api/relayer` proxy.

Out of scope: Zama's protocol, host contracts, relayer and KMS (report those
to [Zama](https://github.com/zama-ai)); third-party wallets and RPC providers;
and the documented design properties below.

## Design properties (not vulnerabilities)

- Reveals are front-runnable: after `markDark` anyone can fetch the same KMS
  proof, and whoever lands `revealKey` first is paid.
- The owner can reveal their own switch and collect funder contributions.
- The secret's length is public (ciphertext length minus 61 bytes).
- Confidentiality depends on Zama's threshold KMS and on Zama's governance of
  its host contracts.

## Known limitations

Contract and deployment:

- Not yet run on Sepolia or mainnet against Zama's real relayer and KMS.
  Mainnet gas for `createSwitch` and `revealKey` is unmeasured.
- Zama's fee model and relayer rate limits are unknown and are not part of the
  bounty or watcher profitability maths.
- No static analysis (Slither, Aderyn), external fuzzer (Echidna, Medusa) or
  formal verification yet.

Frontend:

- `InvalidIndex()` from Zama's InputVerifier is not decoded (nor in the
  client).
- Writes from smart accounts are tested only against a test wallet, not a real
  Safe or 4337 wallet.
- The cached FHE public key has no integrity check and is not revalidated.
- The switch scan does not check block hashes; on a node without a
  `finalized` tag it relies on a 12-block overlap.
- The scan cache stops growing once it outgrows `localStorage`.

Client:

- The watcher waits for each receipt before the next send (no pipelining), so
  a backlog of equal or higher bounties delays a switch.
- On a provider without a `finalized` block tag the watcher's finality check
  fails every pass, and revealed or cancelled switches never count as done.
- The CLI targets one contract (`DMS_ADDRESS`) and has no command to free a
  stuck nonce other than `--replace <hash>`.
