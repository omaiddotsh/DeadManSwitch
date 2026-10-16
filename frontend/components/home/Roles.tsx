import Link from "next/link";
import { Icon, IconBadge, type IconName } from "@/components/ui/Icon";

const ROLES: {
  icon: IconName; tone: "alive" | "warn" | "info"; role: string;
  href: string; cta: string; body: string;
}[] = [
  {
    icon: "shield", tone: "alive", role: "Owner", href: "/dashboard", cta: "My switches",
    body: "Create a switch, ping to stay alive, or cancel while alive and take your escrow back. A cancelled secret stays sealed forever.",
  },
  {
    icon: "target", tone: "warn", role: "Hunter", href: "/hunt", cta: "Hunt",
    body: "Watch every switch. When one goes dark, mark it, fetch the key from Zama's KMS, verify it and claim the bounty.",
  },
  {
    icon: "archive", tone: "info", role: "Reader", href: "/archive", cta: "Archive",
    body: "Everything already released, decrypted in your browser from chain state alone. No wallet needed.",
  },
];

export function Roles() {
  return (
    <section className="grid-3">
      {ROLES.map((r) => (
        <Link key={r.role} href={r.href} className="card card-interactive space-y-3">
          <IconBadge name={r.icon} tone={r.tone} />
          <div>
            <h3 className="font-semibold">{r.role}</h3>
            <p className="mt-1 text-sm text-fg-muted">{r.body}</p>
          </div>
          <span className="inline-flex items-center gap-1 text-sm text-alive">
            {r.cta} <Icon name="chevronRight" size={14} />
          </span>
        </Link>
      ))}
    </section>
  );
}
