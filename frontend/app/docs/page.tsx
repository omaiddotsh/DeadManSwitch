import type { Metadata } from "next";
import Link from "next/link";
import { Icon, IconBadge, type IconName } from "@/components/ui/Icon";
import { Note } from "@/components/ui/Note";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "How the dead-man switch works on Ethereum and Zama fhEVM: the encryption, the contract mechanics, who you trust, the risks, and answers to common questions.",
};

function Section({ id, title, lede, children }: { id: string; title: string; lede?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {lede && <p className="mt-1 text-sm text-fg-muted">{lede}</p>}
      </div>
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-fg-muted">{children}</p>;
}

function Card({ icon, tone, title, children }: {
  icon: IconName; tone: "alive" | "warn" | "gone" | "info" | "neutral"; title: string; children: React.ReactNode;
}) {
  return (
    <div className="card space-y-2">
      <div className="flex items-center gap-3">
        <IconBadge name={icon} tone={tone} size={36} />
        <h3 className="font-semibold">{title}</h3>
      </div>
      <div className="space-y-2 text-sm text-fg-muted [&_p]:max-w-none">{children}</div>
    </div>
  );
}

const TOC: [string, string][] = [
  ["#overview", "In one minute"],
  ["#lifecycle", "Lifecycle"],
  ["#mechanics", "Mechanics"],
  ["#trust", "Trust model"],
  ["#risks", "Risks"],
  ["#faq", "FAQ"],
];

const STATES: { name: string; pill: string; body: string }[] = [
  { name: "Alive", pill: "pill-alive", body: "The owner has pinged within the interval. The key is sealed: the contract has not allowed anyone to decrypt it." },
  { name: "Dark", pill: "pill-dark", body: "Ethereum’s clock passed lastPing + interval. Ping, top-up and cancel now revert. Anyone may call markDark." },
  { name: "Key release requested", pill: "pill-dark", body: "markDark was called: the contract made the key publicly decryptable. Zama’s KMS will decrypt it for anyone who asks." },
  { name: "Revealed", pill: "pill-revealed", body: "Someone submitted the key with a valid KMS proof and was paid the bounty. The key is in contract storage for good." },
  { name: "Cancelled", pill: "pill-cancelled", body: "The owner cancelled while alive. The key is never made decryptable; the secret stays sealed forever." },
];

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-12 pb-12">
      <header>
        <h1 className="page-title">How it works</h1>
        <p className="page-lede">The mechanism, who you are trusting, and the ways this can go wrong.</p>
      </header>

      <nav aria-label="On this page" className="card">
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {TOC.map(([href, label]) => (
            <li key={href}>
              <a href={href} className="inline-flex items-center gap-1.5 text-fg-muted hover:text-fg">
                <Icon name="chevronRight" size={12} /> {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="overview" title="In one minute">
        <P>
          You write a secret. Your browser encrypts it with a fresh random 32-byte key, then encrypts that key to
          Zama’s fhEVM threshold network. Both ciphertexts go into an Ethereum contract with a bounty and a
          check-in interval. Nothing readable leaves your browser.
        </P>
        <P>
          While you keep pinging, the key stays sealed. Miss a deadline and the contract, using Ethereum’s own block
          time rather than any off-chain service, lets anyone ask Zama’s KMS to decrypt the key. Whoever then submits
          the key with the KMS’s signed proof collects the bounty, and the key sits on-chain for good: anyone can
          decrypt the secret from chain state alone.
        </P>
      </Section>

      <Section id="lifecycle" title="Lifecycle" lede="Every switch is in exactly one of these states, as reported by getSwitchInfo.">
        <ol className="space-y-2">
          {STATES.map((s) => (
            <li key={s.name} className="card flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
              <span className={`pill ${s.pill} shrink-0 self-start`}>{s.name}</span>
              <p className="text-sm text-fg-muted">{s.body}</p>
            </li>
          ))}
        </ol>
        <P>
          Alive → Dark happens on its own, by the passage of time. Dark → Key release requested and → Revealed each
          take one transaction from anyone. Cancelled is reachable only from Alive, by the owner.
        </P>
      </Section>

      <Section id="mechanics" title="Mechanics">
        <div className="space-y-4">
          <Card icon="lock" tone="alive" title="Encrypting the secret">
            <p>
              Ciphertext format v1: <code>0x01 ‖ nonce(12) ‖ AES-256-GCM(key, nonce, salt(32) ‖ plaintext)</code>,
              with the 16-byte GCM tag at the end and no associated data. Up to 2,048 bytes of plaintext, so at most
              2,109 bytes of ciphertext, stored in contract storage (not only in an event log) so it survives history
              expiry.
            </p>
            <p>
              The contract also stores a commitment, <code>keccak256(salt ‖ plaintext)</code>. The 32-byte salt is
              inside the encryption, so a short, guessable secret cannot be confirmed against the public commitment
              before release.
            </p>
          </Card>

          <Card icon="key" tone="info" title="Encrypting the key to Zama">
            <p>
              Only the 32-byte AES key is FHE-encrypted, as one <code>euint256</code>. Your browser builds the FHE
              ciphertext with a zero-knowledge proof that you know what is inside; Zama’s relayer and coprocessors
              check it and return an input proof bound to your address and this contract. The first time, your
              browser downloads Zama’s FHE public key (about 4.6 MB, then cached).
            </p>
            <p>
              On-chain, <code>FHE.fromExternal</code> accepts the key and <code>FHE.allowThis</code> lets only this
              contract keep using it; your account’s own right to it lasts only for that transaction (see Risks). One
              encrypted key can back one switch only, so marking one switch dark can never expose another.
            </p>
          </Card>

          <Card icon="heart" tone="alive" title="Pinging and going dark">
            <p>
              <code>ping(id)</code> sets <code>lastPing</code> to the current block time. The switch is dark from the
              block whose timestamp reaches <code>lastPing + interval</code>. Intervals run from 1 minute to 365 days.
              There is no grace period, and nothing can bring a dark switch back.
            </p>
          </Card>

          <Card icon="clock" tone="warn" title="Releasing: markDark, then revealKey">
            <p>
              <strong className="text-fg">markDark</strong> (anyone, once dark) calls{" "}
              <code>FHE.makePubliclyDecryptable</code> on the stored key. That is the only way the key ever becomes
              decryptable, and it is irreversible. The contract checks the deadline itself.
            </p>
            <p>
              Zama’s KMS then decrypts the key for anyone who asks through the relayer, and signs the result.{" "}
              <strong className="text-fg">revealKey</strong> (anyone) submits the key with that proof;{" "}
              <code>FHE.checkSignatures</code> verifies the KMS threshold signatures over this switch’s handle and that
              exact value, so a wrong key cannot claim the bounty. The whole bounty goes to the caller and the key is
              stored on-chain.
            </p>
            <p>
              Before you pay for revealKey, this app checks that the key actually opens the stored ciphertext (the
              AES-GCM tag). A key the KMS signed that does not open it means the owner uploaded an invalid ciphertext,
              or Zama’s KMS signer set was compromised, and you are warned.
            </p>
          </Card>

          <Card icon="eye" tone="info" title="Reading and publishing">
            <p>
              After a reveal, anyone decrypts <code>getCiphertext</code> with <code>getRevealedKey</code>. This app
              does it in your browser and shows whether the tag and the commitment verify. The plaintext is shown as
              plain text only, never as HTML or clickable links.
            </p>
            <p>
              <strong className="text-fg">publishPlaintext</strong> is optional: anyone may post the plaintext and its
              salt; the contract checks them against the commitment and emits them in an event, for indexers. It costs
              gas and pays nothing.
            </p>
          </Card>

          <Card icon="coins" tone="neutral" title="Bounty, minimum and rescue">
            <p>
              The bounty is the owner’s escrow plus any contributions. Contributions are tracked per funder: a cancel
              refunds only the owner’s escrow, and each funder reclaims their own. A reveal pays the whole pot.
            </p>
            <p>
              A contribution cannot be withdrawn while the owner keeps pinging. Intervals go up to a year and pings
              never run out, so that can last indefinitely. It comes back only after a cancel, or in the rescue window
              below; otherwise it pays whoever releases the key.
            </p>
            <p>
              An admin-set minimum, in USD, is converted to ETH with a Chainlink feed when a switch is created. If the
              feed is stale or broken, the minimum is not enforced: the contract fails open rather than blocking new
              switches. The admin can change only this number, and can renounce the role.
            </p>
            <p>
              If a dark switch is still unrevealed 30 days after its deadline (the KMS never served the key, or Zama
              paused the protocol), each depositor may reclaim their own deposit. The switch stays active: a late
              reveal still lands and collects whatever is left.
            </p>
          </Card>
        </div>
      </Section>

      <Section id="trust" title="Trust model" lede="Who can do what, stated plainly.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Card icon="clock" tone="alive" title="When you go dark: Ethereum">
            <p>
              The contract compares <code>block.timestamp</code> with your last ping. No KMS node, relayer, RPC provider
              or this website decides whether you are alive.
            </p>
          </Card>
          <Card icon="key" tone="warn" title="Keeping the key sealed: Zama’s KMS">
            <p>
              Zama’s KMS splits its decryption key across 13 independent operators. Decrypting takes a threshold of
              them working together, and they decrypt only keys the contract marked decryptable. Enough colluding
              operators could decrypt any key early, yours included, without the contract.
            </p>
            <p>
              The KMS also vouches for the key at release: revealKey accepts a key once enough of the signers that
              Zama’s KMSVerifier trusts have signed it, 7 of 13 on Sepolia. That many colluding signers could sign a
              wrong key and collect the bounty; the tag check above exposes it.
            </p>
          </Card>
          <Card icon="settings" tone="warn" title="Zama’s host governance">
            <p>
              Zama’s host contracts are upgradeable. Their owner and pausers can pause the protocol or deny-list this
              contract: createSwitch and markDark then revert until lifted, and depositors can rescue after 30 days.
              The owner can also replace the KMS signers that revealKey trusts, with the same effect as a colluding
              quorum of them.
            </p>
          </Card>
          <Card icon="cpu" tone="neutral" title="Liveness: relayer, KMS, coprocessors">
            <p>
              Creating needs Zama’s relayer and coprocessors to verify your encrypted key; releasing needs the KMS to
              decrypt. If they stop, nothing leaks; releases simply stall (see rescue). They only ever see ciphertext,
              and at release a key that is about to be public anyway.
            </p>
          </Card>
          <Card icon="shield" tone="neutral" title="This website">
            <p>
              The page you are using sees your plaintext before it is encrypted, so you trust the code it serves. Its
              server only forwards encrypted inputs and decryption requests to Zama’s relayer with an API key it keeps
              private. Never paste a secret into a copy of this app you do not trust.
            </p>
          </Card>
          <Card icon="link" tone="neutral" title="Your RPC provider">
            <p>
              It can show your browser stale or false data, but it cannot change what the contract decides. Before
              paying for a reveal, the key is checked against the ciphertext.
            </p>
          </Card>
        </div>
      </Section>

      <Section id="risks" title="Risks" lede="Design properties, not bugs. Decide whether you can live with them.">
        <div className="space-y-3">
          <Card icon="alert" tone="gone" title="Unaudited">
            <p>The contract has an extensive Foundry test suite but no third-party audit. Treat it as experimental.</p>
          </Card>
          <Card icon="clock" tone="warn" title="A missed ping is irreversible">
            <p>
              Once the deadline passes you cannot ping, cancel or stop the release. Travel, illness, a lost wallet,
              or gas you cannot afford on the day all count as going dark. Choose an interval with room to spare.
            </p>
            <p>
              Ping well before the deadline, not in its last minutes. Near it, a chain reorganisation can drop a ping
              from the last block before the deadline and include a markDark instead. That is the same as pinging
              late, and markDark cannot be undone.
            </p>
          </Card>
          <Card icon="key" tone="gone" title="Early release by KMS collusion or Zama governance">
            <p>
              Confidentiality before release rests on Zama’s KMS operators not colluding and on Zama’s governance of
              its host contracts, which can also pause releases. Nobody else can decrypt early.
            </p>
          </Card>
          <Card icon="ban" tone="warn" title="It may never be released">
            <p>
              If Zama’s KMS stops serving decryptions, or nobody finds the bounty worth two transactions, the key stays
              sealed. A switch rescued after 30 days has little or nothing left to pay a late releaser.
            </p>
          </Card>
          <Card icon="wallet" tone="warn" title="Smart-account and EIP-7702 owners">
            <p>
              In the createSwitch transaction, the creating account gets a temporary right to the encrypted key that
              lasts until the transaction ends. An owner account that runs other calls in that same transaction (a
              batch, an EIP-7702 delegate, a wallet module) could use it to let someone else, or everyone, decrypt
              the key while the owner is alive, or even after a cancel. It tells the owner nothing they do not
              already know, but “sealed until markDark” and “cancelled means never decryptable” hold only if your
              account does nothing else with the key in that transaction. A plain EOA cannot: it sends only the
              createSwitch call, and the right ends with the transaction.
            </p>
          </Card>
          <Card icon="shield" tone="warn" title="The owner is trusted by funders">
            <p>
              An owner can let their own switch lapse and claim the whole pot, contributions included. An owner can
              also store a ciphertext that the key does not open; the contract cannot check it, but this app warns.
            </p>
          </Card>
          <Card icon="flame" tone="gone" title="Reveals are front-runnable">
            <p>
              The key and proof travel as public calldata and are not bound to the sender. A bot can copy them and
              outbid your gas. That race is the delivery mechanism; use a private mempool for high-value reveals.
            </p>
          </Card>
          <Card icon="eye" tone="info" title="Public metadata, public forever">
            <p>
              From day one, anyone sees the owner’s address, the interval, the bounty, the timestamps and the exact
              secret length (ciphertext minus 61 bytes). After release the secret is public permanently; there is no
              undo.
            </p>
          </Card>
        </div>
      </Section>

      <Section id="faq" title="FAQ">
        <div className="space-y-2">
          {FAQ.map(([q, a]) => (
            <details key={q} className="card group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium">
                {q}
                <Icon name="chevronRight" size={14} className="shrink-0 text-fg-subtle transition-transform group-open:rotate-90" />
              </summary>
              <p className="mt-2 text-sm text-fg-muted">{a}</p>
            </details>
          ))}
        </div>
      </Section>

      <Note tone="danger" title="Unaudited">
        <p className="text-sm">
          Research-grade code with tests and no audit. Do not store anything you cannot afford to leak early or lose.{" "}
          <Link href="/dashboard" className="text-fg underline underline-offset-4">Create a switch</Link> only once you
          have read the above.
        </p>
      </Note>
    </div>
  );
}

const FAQ: [string, string][] = [
  ["Does my plaintext ever reach a server?",
    "No. It is encrypted in your browser. Only the ciphertext goes on-chain, and only the FHE-encrypted key (with a zero-knowledge proof) goes to Zama’s relayer."],
  ["Can I read my own secret back later?",
    "Not from the chain until it is released: the key is wiped from the page after creation. Keep your own copy."],
  ["Can I change the secret or the interval?",
    "No. Cancel the switch while it is alive (its secret then stays sealed forever) and create a new one."],
  ["Do I need to keep the page open?",
    "Only while creating: keep it open (or reload in the same tab) until it shows “Switch created”. A reload picks the attempt back up rather than creating a second switch, and a sent transaction can still revert. If you close it earlier, check that the switch appears under Your switches on the dashboard before you rely on it. After that, pinging is one small transaction from any device with your wallet."],
  ["What is the 4.6 MB download?",
    "Zama’s FHE public key, needed to encrypt the 32-byte key in your browser. It is downloaded once per browser and cached. Hunters and readers never need it."],
  ["Who can release a switch, and when?",
    "Anyone, at any time after the deadline, even years later. The bounty pays whoever completes the reveal first."],
  ["Why two transactions to release?",
    "markDark asks the contract to make the key decryptable; Zama’s KMS then decrypts it off-chain and signs the result; revealKey proves that result on-chain and pays the bounty."],
  ["What happens if I cancel?",
    "Your escrow is refunded and the key is never made decryptable, so nobody can release the secret through this contract. Funders reclaim their own contributions, and so do you for any top-ups you added: they are booked as a contribution, not as escrow."],
  ["Can I take back a contribution?",
    "Not while the owner keeps pinging, which can go on for years. Only after the owner cancels, or if nobody releases the key within 30 days of a missed deadline. Otherwise it pays whoever releases the key."],
  ["What if nobody reveals in time?",
    "Thirty days after the deadline, depositors may take back their own deposits. The switch stays open: anyone can still reveal it later."],
  ["Which networks are supported?",
    "Ethereum mainnet and Sepolia, the networks where Zama’s fhEVM is deployed. The contract cannot be deployed anywhere else."],
  ["How is a released secret displayed?",
    "As plain text only: never interpreted as HTML, and links are not clickable. You can also download the exact bytes."],
];
