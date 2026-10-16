import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { parseCliArgs, USAGE } from "../src/args.js";
import { UsageError } from "../src/errors.js";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("parseCliArgs", () => {
  it("shows help for no args, help, -h, --help", () => {
    for (const a of [[], ["help"], ["-h"], ["--help"], ["ping", "1", "--help"]]) expect(parseCliArgs(a)).toEqual({ cmd: "help" });
  });

  it("parses create with an inline plaintext", () => {
    expect(parseCliArgs(["create", "7", "3600", "0.05", "my secret"])).toEqual({
      cmd: "create",
      id: 7n,
      intervalSec: 3600n,
      bountyWei: parseEther("0.05"),
      source: { kind: "arg", text: "my secret" },
    });
  });

  it("parses create --file (before or after the positionals) and --file - for stdin", () => {
    const expected = { cmd: "create", id: 1n, intervalSec: 60n, bountyWei: 0n, source: { kind: "file", path: "s.txt" } };
    expect(parseCliArgs(["create", "1", "60", "0", "--file", "s.txt"])).toEqual(expected);
    expect(parseCliArgs(["create", "--file", "s.txt", "1", "60", "0"])).toEqual(expected);
    expect(parseCliArgs(["create", "1", "60", "0", "--file", "-"])).toMatchObject({ source: { kind: "file", path: "-" } });
  });

  it("lets -- end flag parsing so a plaintext may start with --", () => {
    expect(parseCliArgs(["create", "1", "60", "0", "--", "--not-a-flag"])).toMatchObject({ source: { kind: "arg", text: "--not-a-flag" } });
  });

  it("validates create arguments", () => {
    const bad: [string[], RegExp][] = [
      [["create", "0", "60", "0", "x"], /non-zero/],
      [["create", "abc", "60", "0", "x"], /positive integer/],
      [["create", "1", "59", "0", "x"], /between 60/],
      [["create", "1", String(365 * 86400 + 1), "0", "x"], /between 60/],
      [["create", "1", "1.5", "0", "x"], /whole number/],
      [["create", "1", "60", "-1", "x"], /ETH amount/],
      [["create", "1", "60", "1e18", "x"], /ETH amount/],
      [["create", "1", "60", "0.0000000000000000001", "x"], /ETH amount/],
      [["create", "1", "60", "0"], /missing arguments/],
      [["create", "1", "60", "0", "a", "b"], /quote the plaintext/],
      [["create", "1", "60", "0", ""], /must not be empty/],
      [["create", "1", "60", "0", "x", "--file", "f"], /too many arguments/],
      [["create", "1", "60", "0", "--file"], /needs a value/],
      [["create", "1", "60", "0", "x", "--json"], /does not take --json/],
      [["create", (1n << 256n).toString(), "60", "0", "x"], /uint256/],
    ];
    for (const [argv, re] of bad) {
      expect(() => parseCliArgs(argv), argv.join(" ")).toThrow(UsageError);
      expect(() => parseCliArgs(argv), argv.join(" ")).toThrow(re);
    }
  });

  it("accepts hex ids and the uint256 maximum", () => {
    expect(parseCliArgs(["ping", "0x10"])).toEqual({ cmd: "ping", id: 16n });
    const max = (1n << 256n) - 1n;
    expect(parseCliArgs(["ping", max.toString()])).toEqual({ cmd: "ping", id: max });
  });

  it("parses the owner commands", () => {
    expect(parseCliArgs(["ping", "3"])).toEqual({ cmd: "ping", id: 3n });
    expect(parseCliArgs(["cancel", "3"])).toEqual({ cmd: "cancel", id: 3n });
    expect(parseCliArgs(["rescue", "3"])).toEqual({ cmd: "rescue", id: 3n });
  });

  it("parses the anyone commands and checksums the owner", () => {
    const owner = OWNER.toLowerCase();
    expect(parseCliArgs(["fund-bounty", owner, "2", "0.5"])).toEqual({ cmd: "fund-bounty", owner: OWNER, id: 2n, amountWei: parseEther("0.5") });
    expect(parseCliArgs(["reclaim", owner, "2"])).toEqual({ cmd: "reclaim", owner: OWNER, id: 2n });
    expect(parseCliArgs(["mark-dark", owner, "2"])).toEqual({ cmd: "mark-dark", owner: OWNER, id: 2n });
    expect(parseCliArgs(["publish", owner, "2"])).toEqual({ cmd: "publish", owner: OWNER, id: 2n });
    expect(parseCliArgs(["reveal", owner, "2"])).toEqual({ cmd: "reveal", owner: OWNER, id: 2n, publish: false, out: undefined });
    expect(parseCliArgs(["reveal", owner, "2", "--publish", "--out", "x.bin"])).toEqual({
      cmd: "reveal",
      owner: OWNER,
      id: 2n,
      publish: true,
      out: "x.bin",
    });
    expect(parseCliArgs(["read", owner, "2", "--out", "x.bin"])).toEqual({ cmd: "read", owner: OWNER, id: 2n, out: "x.bin" });
    expect(parseCliArgs(["info", owner, "2", "--json"])).toEqual({ cmd: "info", owner: OWNER, id: 2n, json: true });
    expect(parseCliArgs(["status"])).toEqual({ cmd: "status", json: false });
    expect(parseCliArgs(["status", "--json"])).toEqual({ cmd: "status", json: true });
  });

  it("rejects an empty --out or --file value (an unset shell variable) instead of silently ignoring it", () => {
    for (const argv of [
      ["read", OWNER, "1", "--out", ""],
      ["reveal", OWNER, "1", "--out", ""],
      ["create", "1", "60", "0", "--file", ""],
    ]) {
      expect(() => parseCliArgs(argv), argv.join(" ")).toThrow(UsageError);
      expect(() => parseCliArgs(argv), argv.join(" ")).toThrow(/needs a non-empty path/);
    }
  });

  it("parses --replace <hash> and --queue on writes only, and not both at once", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(parseCliArgs(["ping", "3", "--replace", hash])).toEqual({ cmd: "ping", id: 3n, replace: hash });
    expect(parseCliArgs(["fund-bounty", OWNER, "2", "0.5", "--queue"])).toMatchObject({ cmd: "fund-bounty", queue: true });
    expect(parseCliArgs(["reveal", OWNER, "2", "--publish", "--replace", hash])).toMatchObject({ publish: true, replace: hash });
    const bad: [string[], RegExp][] = [
      [["ping", "3", "--replace", "0x1234"], /--replace needs the hash/],
      [["ping", "3", "--replace"], /needs a value/],
      [["ping", "3", "--replace", hash, "--queue"], /do not go together/],
      [["read", OWNER, "2", "--queue"], /does not take --queue/],
      [["info", OWNER, "2", "--replace", hash], /does not take --replace/],
    ];
    for (const [argv, re] of bad) {
      expect(() => parseCliArgs(argv), argv.join(" ")).toThrow(UsageError);
      expect(() => parseCliArgs(argv), argv.join(" ")).toThrow(re);
    }
  });

  it("the help says the relayer API key is for mainnet and optional on Sepolia", () => {
    expect(USAGE).toMatch(/ZAMA_RELAYER_API_KEY \(mainnet; optional on Sepolia\)/);
  });

  it("the help says a funder cannot withdraw while the owner keeps pinging", () => {
    expect(USAGE).toMatch(/fund-bounty[^\n]*\n[^\n]*locked while the owner keeps pinging/);
  });

  it("rejects bad owners, amounts, arity and flags", () => {
    const bad: [string[], RegExp][] = [
      [["fund-bounty", "0x123", "1", "1"], /<owner> must be an address/],
      [["fund-bounty", OWNER, "1", "0"], /greater than zero/],
      [["reveal", OWNER], /missing arguments/],
      [["reveal", OWNER, "1", "2"], /too many arguments/],
      [["read", OWNER, "1", "--publish"], /does not take --publish/],
      [["status", "extra"], /too many arguments/],
      [["ping", "1", "--frobnicate"], /unknown flag/],
      [["explode"], /unknown command/],
    ];
    for (const [argv, re] of bad) expect(() => parseCliArgs(argv), argv.join(" ")).toThrow(re);
  });
});
