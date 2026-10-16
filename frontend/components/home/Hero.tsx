import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

export function Hero() {
  return (
    <section className="py-10 sm:py-16">
      <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-fg-muted">
        <span className="text-alive"><Icon name="lock" size={12} /></span>
        Encrypted in your browser · released by the contract · no custodian
      </p>
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
        A secret that stays sealed while you&apos;re still here.
      </h1>
      <p className="mt-5 text-base text-fg-muted sm:text-lg">
        Your browser encrypts the secret and encrypts its key to Zama&apos;s threshold network. Keep pinging and it
        stays sealed. Miss your deadline and the Ethereum contract, not any off-chain service, decides you have gone
        dark: anyone can then release the key and collect the bounty you left behind.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/dashboard" className="btn btn-primary btn-lg">
          <Icon name="plus" /> Create a switch
        </Link>
        <Link href="/hunt" className="btn btn-lg">
          <Icon name="target" /> Hunt dark switches
        </Link>
        <Link href="/docs" className="btn btn-ghost btn-lg">
          How it works
        </Link>
      </div>
    </section>
  );
}
