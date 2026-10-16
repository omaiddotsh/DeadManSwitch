"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useContractConfig, useIsAdmin, useIsPendingAdmin } from "@/lib/hooks";
import { Icon, type IconName } from "./ui/Icon";

const LINKS: { href: string; label: string; icon: IconName }[] = [
  { href: "/dashboard", label: "My switches", icon: "shield" },
  { href: "/hunt", label: "Hunt", icon: "target" },
  { href: "/archive", label: "Archive", icon: "archive" },
  { href: "/docs", label: "How it works", icon: "book" },
];

export function Header() {
  const pathname = usePathname();
  const isAdmin = useIsAdmin();
  const isPendingAdmin = useIsPendingAdmin();
  const { data: config } = useContractConfig();

  // Settings are public (read-only for everyone at /admin); the nav only
  // advertises the page to the admin and to a nominated admin.
  const links = isAdmin || isPendingAdmin
    ? [...LINKS, { href: "/admin", label: "Admin", icon: "settings" as IconName }]
    : LINKS;

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur">
      {/* One row at 390 px: below sm the brand is its icon and the nav is icons (the wallet button no longer
          drops to a second row). flex-wrap stays as the fallback for a wide wallet button ("Wrong network"). */}
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:gap-x-4">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 rounded py-1 font-semibold tracking-tight text-fg"
        >
          <span className="text-alive"><Icon name="clock" size={20} /></span>
          <span className="sr-only sm:not-sr-only">Dead Man&apos;s Switch</span>
        </Link>

        <nav aria-label="Main" className="flex items-center gap-1 text-sm">
          {links.map(l => {
            const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                // Below `sm` the text label is display:none and the icon is
                // decorative, so without this the link has no accessible name.
                aria-label={l.label}
                aria-current={active ? "page" : undefined}
                className={
                  "inline-flex items-center gap-1.5 rounded px-2.5 py-2 transition-colors sm:py-1.5 " +
                  (active
                    ? "bg-raised text-fg"
                    : "text-fg-muted hover:bg-raised hover:text-fg")
                }
              >
                <Icon name={l.icon} size={14} />
                <span className="hidden sm:inline">{l.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {config?.ethUsd && (
            <span className="hidden text-xs text-fg-muted lg:inline">
              ETH <span className="value text-fg">${config.ethUsd.toFixed(0)}</span>
            </span>
          )}
          <ConnectButton
            chainStatus="icon"
            showBalance={false}
            accountStatus={{ smallScreen: "avatar", largeScreen: "full" }}
          />
        </div>
      </div>
    </header>
  );
}
