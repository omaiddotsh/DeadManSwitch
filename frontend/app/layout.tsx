import "./globals.css";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Providers } from "./providers";
import { Header } from "@/components/Header";
import { ToastProvider } from "@/components/ui/Toast";
import { Icon } from "@/components/ui/Icon";

const DESCRIPTION =
  "Encrypt a secret in your browser and set a check-in interval. Its key is encrypted to Zama's threshold " +
  "network, and the Ethereum contract alone decides when you have gone dark. Then anyone can release the key " +
  "and collect the bounty.";

export const metadata: Metadata = {
  title: { default: "Dead Man's Switch", template: "%s · Dead Man's Switch" },
  description: DESCRIPTION,
  openGraph: {
    title: "Dead Man's Switch",
    description: DESCRIPTION,
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Dead Man's Switch",
    description: DESCRIPTION,
  },
};

/**
 * The UI has one, dark, palette: native controls (checkboxes, selects,
 * number spinners, scrollbars) are drawn dark too, and so is the phone's
 * browser chrome.
 */
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0a0a0c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-canvas text-fg">
        <Providers>
          <ToastProvider>
            {/* Keyboard users otherwise tab through the whole nav on every page. */}
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-raised focus:px-3 focus:py-2 focus:text-sm"
            >
              Skip to content
            </a>

            <div className="flex min-h-screen flex-col">
              {/* One global disclosure; the specific risks are stated again at the point of action. */}
              {/* A div, not a <p>: the global 68ch measure on <p> cut this banner to half width. */}
              <div className="flex items-center justify-center gap-2 border-b border-warn/25 bg-warn/[0.07] px-4 py-1.5 text-center text-xs text-warn">
                <Icon name="alert" size={12} />
                Unaudited software. Don&apos;t store anything you can&apos;t afford to leak or lose.
              </div>

              <Header />

              <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
                {children}
              </main>

              <footer className="border-t border-line">
                {/* Padded inside the 6xl column, like the header and main, so the edges line up. */}
                <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-fg-subtle">
                  <span>Ethereum mainnet &amp; Sepolia · key sealed by Zama&apos;s fhEVM threshold KMS · MIT licensed</span>
                  <Link href="/docs" className="hover:text-fg">How it works</Link>
                </div>
              </footer>
            </div>
          </ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
