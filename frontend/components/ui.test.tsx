// UI-level checks that need no browser: the create-gas model against
// measured receipts, and that revealed plaintext can never become markup.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DocsPage from "@/app/docs/page";
import { ANVIL_ID, MAINNET_ID } from "@/lib/contracts";
import { FhevmError } from "@/lib/fhevm";
import { fhevmHint } from "./FheKeyStatus";
import { estimateCreateGas } from "./gas";
import { PlaintextView } from "./switch/PlaintextView";
import { CreatedCard, ForgetAttemptNote, OtherAccountCard, RecheckLine, UnconfirmedCard } from "./CreateSwitchForm";

describe("estimateCreateGas", () => {
  // gasUsed of createSwitch receipts on Anvil + forge-fhevm host, 2026-10-11.
  const measured: [number, number][] = [
    [62, 384_701], [93, 407_674], [161, 476_257], [573, 752_247], [1_085, 1_119_770], [2_109, 1_854_855],
  ];
  it.each(measured)("is within 0.5%% of the measured gas for a %i-byte ciphertext", (bytes, gas) => {
    const est = Number(estimateCreateGas(bytes, ANVIL_ID));
    expect(Math.abs(est - gas) / gas).toBeLessThan(0.005);
  });
  it("adds a margin on public chains", () => {
    expect(estimateCreateGas(100, MAINNET_ID)).toBeGreaterThan(estimateCreateGas(100, ANVIL_ID));
  });
});

describe("PlaintextView", () => {
  const render = (text: string) =>
    renderToStaticMarkup(<PlaintextView plaintext={new TextEncoder().encode(text)} filenameBase="x" />);

  it("renders hostile HTML as inert text", () => {
    const html = render(`<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not linkify URLs", () => {
    const html = render("visit https://evil.example/login now");
    expect(html).toContain("https://evil.example/login");
    expect(html).not.toMatch(/<a [^>]*evil\.example/);
  });

  it("neutralises bidi overrides and control characters, and says so", () => {
    const html = render("invoice\u202etxt.exe\u0007\u001b[31m");
    expect(html).not.toContain("\u202e");
    expect(html).not.toContain("\u0007");
    expect(html).not.toContain("\u001b");
    expect(html).toContain("Bidirectional-override characters were removed");
    expect(html).toContain("Control characters were replaced");
  });

  it("says so when invisible or format characters were made visible as \\u{…}", () => {
    // A zero-width space and a tag character (both can carry hidden text).
    const html = render("pay\u200Bme \u{E0041}");
    expect(html).toContain("\\u{200b}");
    expect(html).toMatch(/<li>Invisible or format characters[^<]*\\u\{…\}/);
    expect(render("plain text, emoji ❤️ and a ZWJ family 👨‍👩‍👧")).not.toContain("Invisible or format characters");
  });

  it("kept ideographic variation selectors get their own warning, not the 'made visible' one", () => {
    // Shown as written (Japanese name variants), but one selector per character can carry a hidden byte.
    const html = render("葛\u{E0100}辻\u{E0101}");
    expect(html).toMatch(/<li>[^<]*variation selectors[^<]*hidden data/);
    expect(html).not.toContain("made visible");
    // Both kinds present: both lines.
    const both = render("pay​me 葛\u{E0100}");
    expect(both).toContain("made visible");
    expect(both).toMatch(/variation selectors/);
  });
});

describe("fhevmHint", () => {
  it("RELAYER_NOT_CONFIGURED names every server setting that causes it", () => {
    const hint = fhevmHint(new FhevmError("RELAYER_NOT_CONFIGURED", "the relayer proxy refused the request (contract_mismatch)")) ?? "";
    expect(hint).toContain("ZAMA_RELAYER_URL_");
    // A page loaded for another contract than the server's is STALE_PAGE (reload), not a server setting.
    expect(hint).not.toMatch(/this page's contract/i);
    expect(hint).toContain("NEXT_PUBLIC_CONTRACT_");
    expect(hint).toContain("ZAMA_RELAYER_API_KEY");
    expect(hint).toContain("Nothing was sent on-chain");
  });
});

describe("create outcome cards", () => {
  const HASH = `0x${"ab".repeat(32)}` as const;
  const attempt = {
    chainId: 11155111, contract: "0x00000000000000000000000000000000000d3ad5", owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    id: 123456789n, submitted: true, hash: HASH,
  } as const;

  it("an unconfirmed send shows the hash and the switch id, and offers no create", () => {
    const flow = { outcome: "pending", lastCheckedAt: null, checkNow: () => {} } as never;
    const html = renderToStaticMarkup(<UnconfirmedCard flow={flow} attempt={attempt} />);
    expect(html).toContain("Waiting for confirmation");
    expect(html).toContain(HASH);
    expect(html).toContain("#123456789");
    expect(html).toContain("https://sepolia.etherscan.io/tx/" + HASH);
    expect(html).toContain("Do not create the switch again");
    expect(html).toContain("Your switches");
    expect(html).not.toMatch(/type="submit"|Encrypt and create|Try again|Could not create/);
  });

  describe("W13: an attempt from another account", () => {
    const render = (outcome: string | null, hash: `0x${string}` | null) =>
      renderToStaticMarkup(
        <OtherAccountCard
          flow={{ outcome, forgetAttempt: () => {}, checkNow: () => {}, lastCheckedAt: null } as never}
          attempt={{ ...attempt, hash }}
        />,
      );

    it("R3 reverted: no one-click new switch; re-checked, and starting afresh opens a warning first", () => {
      const html = render("reverted", HASH);
      expect(html).toContain("reverted");
      expect(html).toContain("re-checks it for a few minutes");
      expect(html).toContain("an earlier send of the same id");
      // Q2: the re-checks stop after a few minutes; the owner can always check again.
      expect(html).toMatch(/<button[^>]*>.*Check again<\/button>/);
      expect(html).toContain("Start a new switch…</button>");
      expect(html).not.toContain(">Start a new switch</button>");
      expect(html).not.toMatch(/so that switch was not created|did not go through|Check, then/);
    });

    describe("R3: the warning before an attempt is dropped", () => {
      const note = (outcome: string, flow: Record<string, unknown> = {}) =>
        renderToStaticMarkup(
          <ForgetAttemptNote
            flow={{ outcome, forgetAttempt: async () => {}, rechecking: false, recheckError: null, ...flow } as never}
            attempt={attempt}
            onKeep={() => {}}
          />,
        );

      it("reverted: warns about two switches and says the chain is checked first", () => {
        const html = note("reverted");
        expect(html).toContain("Start a new switch instead?");
        expect(html).toContain("two switches holding the same secret");
        expect(html).toContain("checks the chain again");
        expect(html).toContain("Check, then start a new switch");
      });

      it("while re-checking: no second click; a failed re-check says nothing was dropped", () => {
        expect(note("reverted", { rechecking: true })).toMatch(/<button[^>]*disabled=""[^>]*>.*Checking the chain…/);
        expect(note("vanished", { recheckError: "Could not check whether switch #1 exists (429), so nothing was dropped." }))
          .toContain("so nothing was dropped");
        expect(note("absent")).toContain("Check, then forget it");
      });
    });

    it("unseen (vanished): may still land, so finishing there comes first and forgetting is behind a warning", () => {
      const html = render("vanished", HASH);
      expect(html).not.toContain("Check again");
      expect(html).toContain("Finish your earlier attempt first");
      expect(html).toContain("still land");
      expect(html).toContain("It will not land…");
      expect(html).not.toMatch(/cannot tell whether|never sent|Start a new switch/);
    });

    it("no hash: outcome unknown, as before", () => {
      const html = render("absent", null);
      expect(html).toContain("cannot tell whether it went through");
      expect(html).toContain("It was never sent…");
    });
  });

  it("Q2: a reverted attempt's 'Check again' line shows when it was last checked", () => {
    const at = Date.UTC(2026, 9, 11, 12, 0, 0);
    const html = renderToStaticMarkup(
      <RecheckLine flow={{ lastCheckedAt: at, checkNow: () => {} } as never} attempt={attempt} />,
    );
    expect(html).toContain("#123456789");
    expect(html).toContain(`Last checked ${new Date(at).toLocaleTimeString()}`);
    expect(html).toMatch(/<button type="button"[^>]*>.*Check again<\/button>/);
    expect(renderToStaticMarkup(<RecheckLine flow={{ lastCheckedAt: null, checkNow: () => {} } as never} attempt={attempt} />))
      .not.toContain("Last checked");
  });

  it("an adopted switch says nothing new was sent", () => {
    const html = renderToStaticMarkup(
      <CreatedCard
        created={{ ...attempt, pingInterval: 86400n * 7n, state: "alive", adopted: true }}
        onStartOver={() => {}}
      />,
    );
    expect(html).toContain("Switch created");
    expect(html).toContain("#123456789");
    expect(html).toContain("7d");
    expect(html).toContain("nothing new");
  });
});

describe("/docs page", () => {
  const html = renderToStaticMarkup(<DocsPage />);

  it("D19: an ACL pause or deny-list blocks createSwitch as well as markDark", () => {
    expect(html).toContain("createSwitch and markDark then revert until lifted");
  });

  it("W11: keep the page open until the switch is created, or check the dashboard", () => {
    expect(html).toContain("until it shows “Switch created”");
    expect(html).toContain("Your switches on the dashboard");
    expect(html).not.toContain("until your wallet has sent the transaction");
  });
});
