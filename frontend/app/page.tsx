import Link from "next/link";
import { Hero } from "@/components/home/Hero";
import { HowItWorks } from "@/components/home/HowItWorks";
import { Roles } from "@/components/home/Roles";
import { Note } from "@/components/ui/Note";
import { Icon } from "@/components/ui/Icon";

/**
 * What this is, how it behaves, and where to go. The mechanics, trust model
 * and risks live at /docs.
 */
export default function HomePage() {
  return (
    <div className="space-y-16 pb-8">
      <Hero />
      <HowItWorks />
      <Roles />

      <section className="stack">
        <Note tone="warn" title="Unaudited. Read the risks before trusting it with anything.">
          <p className="text-sm">
            The contract has a Foundry test suite but no third-party audit. Until release, confidentiality rests on
            Zama&apos;s threshold KMS: enough colluding KMS operators could decrypt any key early. Zama&apos;s host
            governance can pause the protocol or change the KMS signer set. Reveals are front-runnable by design, and
            an owner can always let their own switch lapse. Do not store anything you cannot afford to leak early or
            lose entirely.
          </p>
          <Link
            href="/docs#trust"
            className="inline-flex items-center gap-1 text-sm font-medium text-fg underline underline-offset-4"
          >
            Read the trust model <Icon name="chevronRight" size={14} />
          </Link>
        </Note>
      </section>
    </div>
  );
}
