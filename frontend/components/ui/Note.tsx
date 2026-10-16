import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type Tone = "warn" | "danger" | "info";

const TONE: Record<Tone, { cls: string; icon: IconName; accent: string }> = {
  warn:   { cls: "note-warn",   icon: "alert", accent: "text-warn" },
  danger: { cls: "note-danger", icon: "alert", accent: "text-gone" },
  info:   { cls: "note-info",   icon: "info",  accent: "text-info" },
};

export function Note({
  tone = "info", title, children,
}: { tone?: Tone; title?: string; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <div className={`note ${t.cls}`}>
      {title && (
        <div className="note-title">
          <span className={t.accent}><Icon name={t.icon} /></span>
          {title}
        </div>
      )}
      <div className="space-y-2 [&_p]:max-w-none">{children}</div>
    </div>
  );
}

/**
 * The single canonical statement of the self-reveal risk, shown only where it
 * is taken: creating a switch, or funding someone else's. Funders are also
 * told their contribution is locked for as long as the owner keeps pinging.
 */
export function SelfRevealNote({ audience }: { audience: "owner" | "funder" }) {
  return (
    <Note tone="warn" title="The owner can claim their own bounty">
      {audience === "owner" ? (
        <p className="text-sm">
          Once your switch goes dark, anyone can release the key and collect the
          whole bounty, you included, together with anything other people
          contributed. That is deliberate: a dead-man switch assumes you are
          unable to ping, not unwilling. It does mean funders are trusting you.
        </p>
      ) : (
        <>
          <p className="text-sm">
            The owner can stop pinging, release their own key and take the entire
            bounty, your contribution included. The owner also chose what was
            encrypted: the contract cannot check that the ciphertext is a real
            secret. Only fund switches whose owner you trust.
          </p>
          <p className="text-sm">
            You cannot withdraw your contribution while the owner keeps pinging,
            which can go on for years. It comes back only if the owner cancels,
            or if nobody releases the key within 30 days of a missed deadline.
            Otherwise it goes to whoever releases the key.
          </p>
        </>
      )}
    </Note>
  );
}

/**
 * Mempool exposure at reveal time, shown on the reveal control itself.
 */
export function FrontrunNote() {
  return (
    <p className="flex items-start gap-1.5 text-xs text-fg-muted">
      <span className="mt-px text-warn"><Icon name="alert" size={12} /></span>
      <span className="max-w-none">
        The key and the KMS proof travel as public calldata, and the proof is not
        tied to your address. A bot watching the mempool can copy them and outbid
        your gas to take the bounty. That race is how the key gets delivered; use
        a private mempool (e.g. Flashbots Protect) for high-value reveals.
      </span>
    </p>
  );
}
