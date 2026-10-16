// Opt-in end-to-end test of lib/fhevm.ts + lib/envelope.ts + the ABI against a
// local Anvil running the forge-fhevm host stack (cleartext KMS), through the
// real @zama-fhe/sdk. Skipped unless DMS_LOCAL_RPC and DMS_LOCAL_CONTRACT are set.
//
//   anvil --port 18545 --chain-id 31337 --silent &
//   (cd <forge-fhevm> && ./deploy-local.sh --anvil-port 18545)
//   deploy DeadManSwitch(0, 0, 0) to it
//   DMS_LOCAL_RPC=http://127.0.0.1:18545 DMS_LOCAL_CONTRACT=0x… npx vitest run lib/fhevm.local.test.ts
//
// It advances chain time (evm_increaseTime) and briefly turns automine off
// (create-retry cases), so it refuses the shared :8545 node unless
// DMS_LOCAL_ALLOW_WARP=1.

import { beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.DMS_LOCAL_RPC;
// Placeholder keeps client construction valid while the suite is collected but skipped.
const RPC_URL = RPC ?? "http://127.0.0.1:1";
const CONTRACT = process.env.DMS_LOCAL_CONTRACT as Hex | undefined;
const enabled = !!RPC && !!CONTRACT;

describe.skipIf(!enabled)("local fhEVM end-to-end (Anvil + forge-fhevm, cleartext KMS)", () => {
  let fhevm: typeof import("./fhevm");
  let envelope: typeof import("./envelope");
  let hooks: Pick<typeof import("./hooks"), "scanSwitchCreated" | "observeAttempt" | "readAttemptFresh">;
  let abi: typeof import("./abi").dmsAbi;

  const chain = defineChain({
    id: 31337, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const owner = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil #1
  const hunter = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // anvil #2
  const pub = createPublicClient({ chain, transport: http(RPC_URL) });
  const wOwner = createWalletClient({ account: owner, chain, transport: http(RPC_URL) });
  const wHunter = createWalletClient({ account: hunter, chain, transport: http(RPC_URL) });

  beforeAll(async () => {
    if (/:8545\/?$/.test(RPC!) && process.env.DMS_LOCAL_ALLOW_WARP !== "1") {
      throw new Error("refusing to evm_increaseTime on the shared :8545 node; use a private Anvil");
    }
    process.env.NEXT_PUBLIC_ENABLE_LOCAL_CHAIN = "1";
    process.env.NEXT_PUBLIC_RPC_URL_31337 = RPC;
    process.env.NEXT_PUBLIC_CONTRACT_31337 = CONTRACT;
    fhevm = await import("./fhevm");
    envelope = await import("./envelope");
    hooks = await import("./hooks");
    abi = (await import("./abi")).dmsAbi;
  });

  it("create → (sealed while alive) → markDark → KMS decrypt → verify → revealKey → publish", async () => {
    const secret = `local e2e ${Date.now()} — ünïcødé ✓`;
    const sealed = await envelope.sealText(secret);
    const stages: string[] = [];

    const { handle, inputProof } = await fhevm.encryptDek({
      chainId: 31337, contractAddress: CONTRACT!, userAddress: owner.address, dek: sealed.dek,
      onProgress: (p) => stages.push(p.stage),
    });
    expect(stages).toContain("loading-sdk");
    expect(stages).toContain("encrypting");
    expect(handle).toMatch(/^0x[0-9a-f]{64}$/);

    const id = BigInt(Date.now());
    let hash = await wOwner.writeContract({
      address: CONTRACT!, abi, functionName: "createSwitch",
      args: [{ id, pingInterval: 60n, plaintextCommitment: sealed.commitment }, sealed.ciphertextHex, handle, inputProof],
    });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");

    // Discovery from logs (chunked) finds it with the creation-time values.
    const latest = await pub.getBlockNumber();
    const found = await hooks.scanSwitchCreated(pub as never, CONTRACT!, latest > 50n ? latest - 50n : 0n, latest, 7n, owner.address);
    const listing = found.find((s) => s.id === id);
    expect(listing?.encKeyHandle).toBe(handle);
    expect(listing?.plaintextCommitment).toBe(sealed.commitment);

    // While alive the KMS (mock) must refuse.
    const early = await fhevm.publicDecryptDek({ chainId: 31337, handle }).then(() => null, (e) => e);
    expect(early).toBeInstanceOf(fhevm.FhevmError);
    expect(["NOT_DECRYPTABLE_YET", "DECRYPT_FAILED"]).toContain(early.code);

    await pub.request({ method: "evm_increaseTime" as never, params: [61] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });

    hash = await wHunter.writeContract({ address: CONTRACT!, abi, functionName: "markDark", args: [owner.address, id] });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");

    const dec = await fhevm.publicDecryptDek({ chainId: 31337, handle });
    expect(dec.dataKey).toBe(sealed.dekHex);
    const check = await envelope.checkKey(dec.dekBytes, sealed.ciphertextHex, sealed.commitment);
    expect(check.status).toBe("ok");

    hash = await wHunter.writeContract({
      address: CONTRACT!, abi, functionName: "revealKey", args: [owner.address, id, dec.dataKey, dec.decryptionProof],
    });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");

    const info = await pub.readContract({ address: CONTRACT!, abi, functionName: "getSwitchInfo", args: [owner.address, id] });
    expect(info.state).toBe(4); // REVEALED
    expect(info.revealedKey).toBe(sealed.dekHex);

    // Anyone, from chain state alone:
    const ct = await pub.readContract({ address: CONTRACT!, abi, functionName: "getCiphertext", args: [owner.address, id] });
    const fromChain = await envelope.checkKey(info.revealedKey, ct, info.plaintextCommitment);
    expect(fromChain.status).toBe("ok");
    if (fromChain.status !== "ok") return;
    expect(envelope.toDisplayText(fromChain.plaintext).text).toBe(secret);

    hash = await wHunter.writeContract({
      address: CONTRACT!, abi, functionName: "publishPlaintext",
      args: [owner.address, id, fromChain.saltHex, fromChain.plaintextHex],
    });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");
  }, 300_000);

  it("create retries stay on one switch id: unconfirmed is polled, an ambiguous send is adopted, a same-id double send yields one switch", async () => {
    const ca = await import("./createAttempt");
    const sw = await import("./switch");
    const mine = () => pub.request({ method: "evm_mine" as never, params: [] as never });
    const automine = (on: boolean) => pub.request({ method: "evm_setAutomine" as never, params: [on] as never });
    const store = ca.createAttemptStore(() => null);
    const sent: Hex[] = [];
    let nextId = BigInt(Date.now()) * 1000n;
    const send: import("./createAttempt").CreateDeps["send"] = async (a, p, pingInterval, value) => {
      const h = await wOwner.writeContract({
        address: CONTRACT!, abi, functionName: "createSwitch", value,
        // Fixed gas: estimation must not see a same-id tx still in the mempool.
        gas: 3_000_000n,
        args: [{ id: a.id, pingInterval, plaintextCommitment: p.commitment }, p.ciphertext, p.encKey, p.inputProof],
      });
      sent.push(h);
      return h;
    };
    const lostHash: typeof send = async (...args) => { await send(...args); throw new Error("WalletConnect: request expired"); };
    const waitForReceipt = async (hash: Hex) => (await pub.waitForTransactionReceipt({ hash })).status;
    const base: Omit<import("./createAttempt").CreateDeps, "send" | "waitForReceipt"> = {
      ctx: { chainId: 31337, contract: CONTRACT!, owner: owner.address },
      store,
      outcome: null,
      freshId: () => ++nextId,
      readSwitch: async (o, id) => sw.toSwitchInfo(
        await pub.readContract({ address: CONTRACT!, abi, functionName: "getSwitchInfo", args: [o, id] }) as never),
      readMinBounty: async () => 0n,
      prepare: async () => {
        const s = await envelope.sealText(`retry ${Date.now()}`);
        const { handle, inputProof } = await fhevm.encryptDek({
          chainId: 31337, contractAddress: CONTRACT!, userAddress: owner.address, dek: s.dek,
        });
        return { commitment: s.commitment, ciphertext: s.ciphertextHex, encKey: handle, inputProof };
      },
      onStage: () => {},
    };
    const input = { pingInterval: 3600n, bountyWei: 0n };
    const switchesWithId = async (id: bigint) => {
      const latest = await pub.getBlockNumber({ cacheTime: 0 }); // viem caches it for 4 s; we just mined
      const found = await hooks.scanSwitchCreated(pub as never, CONTRACT!, latest > 20n ? latest - 20n : 0n, latest, 1000n, owner.address);
      return found.filter((s) => s.id === id).length;
    };

    // 1. Broadcast, then the receipt wait times out (tx sits in the mempool).
    await automine(false);
    try {
      const r = await ca.runCreate({
        ...base, send, waitForReceipt: async (hash) => (await pub.waitForTransactionReceipt({ hash, timeout: 1_500 })).status,
      }, input);
      expect(r.kind).toBe("unconfirmed");
      const a = store.get()!;
      expect(a).toMatchObject({ submitted: true, hash: sent[0] });
      let { obs } = await hooks.observeAttempt(pub as never, a, 0);
      expect(obs).toMatchObject({ state: 0, receipt: "none", txKnown: true });
      expect(ca.classifyAttempt(a, obs)).toBe("pending");
      await expect(ca.runCreate({ ...base, outcome: "pending", send, waitForReceipt }, input))
        .rejects.toMatchObject({ block: "pending" });
      await mine();
      ({ obs } = await hooks.observeAttempt(pub as never, a, 0));
      expect(obs).toMatchObject({ state: 1, receipt: "success" });
      expect(ca.classifyAttempt(a, obs)).toBe("landed");
      expect(sent).toHaveLength(1);
      expect(await switchesWithId(a.id)).toBe(1);

      // A hash the node has never seen (dropped, or replaced by a cancel), and no switch: vanished.
      const gone = { ...a, id: a.id + 1n, hash: `0x${"5a".repeat(32)}` as Hex };
      ({ obs } = await hooks.observeAttempt(pub as never, gone, ca.VANISHED_AFTER_POLLS - 1));
      expect(obs).toMatchObject({ state: 0, receipt: "none", txKnown: false, unknownPolls: ca.VANISHED_AFTER_POLLS });
      expect(ca.classifyAttempt(gone, obs)).toBe("vanished");
    } finally {
      await automine(true);
    }

    // 2. The wallet broadcast (and it was mined) but no hash came back: the retry adopts it.
    store.set(null);
    await expect(ca.runCreate({ ...base, send: lostHash, waitForReceipt }, input)).rejects.toThrow(/expired/);
    const a2 = store.get()!;
    expect(a2).toMatchObject({ submitted: true, hash: null });
    const r2 = await ca.runCreate({ ...base, send, waitForReceipt }, input);
    expect(r2).toMatchObject({ kind: "created", adopted: true, pingInterval: 3600n });
    expect(r2.kind === "created" && r2.attempt.id).toBe(a2.id);
    expect(sent).toHaveLength(2); // the retry sent nothing
    expect(await switchesWithId(a2.id)).toBe(1);

    // 3. Same thing, but the lost tx is still in the mempool when the retry sends:
    //    both land in one block, the retry reverts AlreadyExists, and the run adopts the first.
    store.set(null);
    await automine(false);
    try {
      await expect(ca.runCreate({ ...base, send: lostHash, waitForReceipt }, input)).rejects.toThrow(/expired/);
      const a3 = store.get()!;
      const r3 = await ca.runCreate({
        ...base, send, waitForReceipt: async (hash) => { await mine(); return waitForReceipt(hash); },
      }, input);
      expect(r3).toMatchObject({ kind: "created", adopted: true });
      expect(r3.kind === "created" && r3.attempt.id).toBe(a3.id);
      expect((await pub.getTransactionReceipt({ hash: sent[2]! })).status).toBe("success");
      const reverted = await pub.getTransactionReceipt({ hash: sent[3]! });
      expect(reverted.status).toBe("reverted");
      expect(await switchesWithId(a3.id)).toBe(1);

      // R3: the poll of the reverted retry, through an RPC whose "latest" (state and
      // head) is one block behind its receipts, as a load-balanced RPC can be.
      const behind = reverted.blockNumber - 1n;
      const lagging = {
        ...pub,
        readContract: (args: Parameters<typeof pub.readContract>[0]) =>
          pub.readContract({ ...args, blockNumber: (args as { blockNumber?: bigint }).blockNumber ?? behind } as never),
        getBlockNumber: async () => behind,
      };
      const polled = { ...a3, submitted: true, hash: sent[3]! };
      const { obs } = await hooks.observeAttempt(lagging as never, polled, 0);
      expect(obs).toMatchObject({ receipt: "reverted", state: 1 });
      expect(ca.classifyAttempt(polled, obs)).toBe("landed");
      // ...and the re-check before the attempt could be dropped finds it too.
      expect(await hooks.readAttemptFresh(lagging as never, polled)).toMatchObject({ exists: true });
      const keep = ca.createAttemptStore(() => null);
      keep.set(polled);
      expect(await ca.dropAttempt(keep, (x) => hooks.readAttemptFresh(lagging as never, x), async () => {}))
        .toMatchObject({ kind: "landed" });
      // Without the confirming read, the lagging node alone shows no switch.
      expect((await lagging.readContract({
        address: CONTRACT!, abi, functionName: "getSwitchInfo", args: [owner.address, a3.id],
      }) as { owner: string }).owner).toBe("0x0000000000000000000000000000000000000000");
    } finally {
      await automine(true);
    }
  }, 300_000);

  it("a forged ciphertext is caught by checkKey even though the KMS proof is valid", async () => {
    const real = await envelope.sealText("the real secret");
    const other = await envelope.sealText("a different secret"); // different DEK
    const { handle, inputProof } = await fhevm.encryptDek({
      chainId: 31337, contractAddress: CONTRACT!, userAddress: owner.address, dek: real.dek,
    });
    const id = BigInt(Date.now()) + 7n;
    // Owner uploads a ciphertext that the encrypted DEK does not open.
    let hash = await wOwner.writeContract({
      address: CONTRACT!, abi, functionName: "createSwitch",
      args: [{ id, pingInterval: 60n, plaintextCommitment: other.commitment }, other.ciphertextHex, handle, inputProof],
    });
    await pub.waitForTransactionReceipt({ hash });
    await pub.request({ method: "evm_increaseTime" as never, params: [61] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });
    hash = await wHunter.writeContract({ address: CONTRACT!, abi, functionName: "markDark", args: [owner.address, id] });
    await pub.waitForTransactionReceipt({ hash });
    const dec = await fhevm.publicDecryptDek({ chainId: 31337, handle });
    const check = await envelope.checkKey(dec.dekBytes, other.ciphertextHex, other.commitment);
    expect(check.status).toBe("invalid-key");
    if (check.status === "invalid-key") expect(check.warning).toBe(envelope.INVALID_KEY_WARNING);
  }, 300_000);
});
