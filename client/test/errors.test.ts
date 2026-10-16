// Revert decoding of errors that Zama's host contracts bubble up through DeadManSwitch calls, along the path
// chain.ts takes for a write (getContractError against dmsAbiWithHostErrors).

import { encodeErrorResult, getContractError, parseAbi, RawContractError } from "viem";
import { describe, expect, it } from "vitest";
import { describeError, dmsAbiWithHostErrors, ERROR_HINTS, revertErrorName } from "../src/errors.js";
import { DMS, SELF } from "./watcherStub.js";

/** What Dms.send throws when the createSwitch simulation reverts with `data`. */
const createSwitchReverts = (data: `0x${string}`) =>
  getContractError(new RawContractError({ data }), {
    abi: dmsAbiWithHostErrors,
    address: DMS,
    args: [],
    functionName: "createSwitch",
    sender: SELF,
  });

describe("host errors", () => {
  it("names the FHE executor's InvalidType() and the ACL's SenderNotAllowed(address), with a hint, instead of 'unknown error'", () => {
    const abi = parseAbi(["error InvalidType()", "error SenderNotAllowed(address sender)"]);
    const cases = [
      ["InvalidType", encodeErrorResult({ abi, errorName: "InvalidType" })],
      ["SenderNotAllowed", encodeErrorResult({ abi, errorName: "SenderNotAllowed", args: [SELF] })],
    ] as const;
    for (const [name, data] of cases) {
      const err = createSwitchReverts(data);
      expect(revertErrorName(err)).toBe(name);
      const text = describeError(err);
      expect(text.startsWith(`reverted: ${name}`), text).toBe(true);
      expect(text.endsWith(` — ${ERROR_HINTS[name] ?? "<no hint>"}`), text).toBe(true);
      expect(describeError(err)).not.toMatch(/unknown error/);
    }
  });

  it("every hint names an error the CLI can decode", () => {
    const names = new Set<string>(dmsAbiWithHostErrors.filter((e) => e.type === "error").map((e) => e.name));
    expect(Object.keys(ERROR_HINTS).filter((k) => !names.has(k))).toEqual([]);
  });
});
