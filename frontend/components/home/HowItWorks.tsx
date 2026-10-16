import { IconBadge, type IconName } from "@/components/ui/Icon";

const STEPS: { icon: IconName; tone: "alive" | "warn" | "gone" | "info"; title: string; body: string }[] = [
  {
    icon: "lock", tone: "alive", title: "Encrypt",
    body: "Your browser encrypts the secret with a fresh key (AES-256-GCM), then encrypts that key to Zama's threshold network. Only ciphertext goes on-chain.",
  },
  {
    icon: "heart", tone: "alive", title: "Ping",
    body: "Check in once per interval: one small transaction, no secret needed. Each ping pushes your deadline out.",
  },
  {
    icon: "clock", tone: "warn", title: "Go dark",
    body: "Miss the deadline and the contract itself, using Ethereum's clock, lets anyone ask Zama's KMS to decrypt the key. No off-chain node decides.",
  },
  {
    icon: "unlock", tone: "gone", title: "Release",
    body: "Whoever fetches the key and submits it with the KMS proof collects the bounty. The key is then on-chain and anyone can decrypt the secret.",
  },
];

export function HowItWorks() {
  return (
    <section className="stack">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
        <p className="page-lede">Four steps. Nobody holds your secret in readable form at any point.</p>
      </div>
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="card space-y-3">
            <div className="flex items-center gap-3">
              <IconBadge name={s.icon} tone={s.tone} size={40} />
              <span className="value text-xs text-fg-subtle">Step {i + 1}</span>
            </div>
            <h3 className="font-semibold">{s.title}</h3>
            <p className="text-sm text-fg-muted">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
