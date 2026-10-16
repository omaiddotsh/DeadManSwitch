// The test wallet: an EIP-1193 provider injected into the page before any app
// script runs (context.addInitScript). It forwards JSON-RPC to Anvil, whose
// dev accounts are unlocked, so eth_sendTransaction needs no signing. It
// announces itself over EIP-6963, so RainbowKit lists it under "Installed"
// and the tests connect through the real connect modal.
//
// Playwright serialises installInjectedWallet with Function.prototype.toString:
// the function must stay self-contained (no imports, no outer variables, no
// helpers a transpiler would hoist). Types are erased, so local type aliases
// are fine.

export interface InjectedWalletConfig {
  /** Anvil's JSON-RPC URL; the wallet forwards every non-wallet method there. */
  rpcUrl: string;
  /** Chain id the RPC actually serves (31337). */
  rpcChainId: number;
  /** Selectable accounts, by index. */
  accounts: readonly string[];
  /** Account selected on first load (later loads keep the persisted choice). */
  accountIndex: number;
  /** Chain the wallet reports on first load. */
  chainId: number;
  /** Chains wallet_switchEthereumChain accepts without a wallet_addEthereumChain first. */
  knownChainIds: readonly number[];
  /** localStorage key that keeps account, chain and authorisation across page loads. */
  storageKey: string;
  /** EIP-6963 provider info. The icon must be a data:image URI for RainbowKit to list it. */
  info: { uuid: string; name: string; icon: string; rdns: string };
  /** Also set window.ethereum (as extension wallets do). Off by default: EIP-6963 alone is the modern path. */
  exposeWindowEthereum: boolean;
}

/** Methods a real wallet would prompt for; only these can be "rejected by the user". */
export const PROMPT_METHODS = [
  "eth_requestAccounts",
  "wallet_requestPermissions",
  "eth_sendTransaction",
  "personal_sign",
  "eth_sign",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "wallet_sendCalls",
] as const;
export type PromptMethod = (typeof PROMPT_METHODS)[number];

export interface WalletLogEntry {
  at: number;
  method: string;
  ok: boolean;
  /** Error code of a failed request. */
  code?: number;
  message?: string;
  /** eth_sendTransaction: the hash returned, and the call's target and selector. */
  hash?: string;
  to?: string;
  /** Selector and the first two ABI words of the calldata (createSwitch: the switch id and interval). */
  dataHead?: string;
  from?: string;
  value?: string;
  /** Sent although the dapp was told it failed (failNext "lose-response"). */
  broadcast?: boolean;
}

/**
 * How the next matching request fails:
 *  - "reject": the user rejects it (4001), nothing is sent;
 *  - "lose-response": the wallet broadcasts the transaction, then reports an
 *    internal error instead of the hash (a dropped WalletConnect session, a
 *    wallet RPC failing after the broadcast). Only for eth_sendTransaction.
 */
export type FailureMode = "reject" | "lose-response";

export interface WalletSnapshot {
  account: string;
  accountIndex: number;
  chainId: number;
  authorized: boolean;
  pendingRejection: string | null;
  /** Requests the wallet is holding (holdNext), as a wallet waiting for the user to confirm. */
  held: number;
}

/** The control surface the tests reach through page.evaluate (window.__dmsE2EWallet). */
export interface WalletControlApi {
  setAccount(index: number): void;
  setChainId(chainId: number): void;
  rejectNext(method: string | null): void;
  failNext(method: string | null, mode: FailureMode): void;
  clearRejection(): void;
  /** Hold the next `method` (or any prompt) until releaseHeld(), as a wallet prompt left open. */
  holdNext(method: string | null): void;
  /** Disarm holdNext and let every held request go on; returns how many there were. */
  releaseHeld(): number;
  disconnect(): void;
  snapshot(): WalletSnapshot;
  log(): WalletLogEntry[];
}

export function installInjectedWallet(cfg: InjectedWalletConfig): void {
  // Only the top-level document gets a wallet (not the iframes third-party SDKs create).
  if (window.top !== window) return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__dmsE2EWallet) return;

  const PROMPTS = [
    "eth_requestAccounts", "wallet_requestPermissions", "eth_sendTransaction", "personal_sign", "eth_sign",
    "eth_signTypedData_v4", "wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_sendCalls",
  ];

  type Persisted = { accountIndex: number; chainId: number; authorized: boolean; knownChainIds: number[] };
  type Listener = (...args: unknown[]) => void;
  type LogEntry = {
    at: number; method: string; ok: boolean; code?: number; message?: string;
    hash?: string; to?: string; dataHead?: string; from?: string; value?: string; broadcast?: boolean;
  };
  type TxParams = { from?: string; to?: string; data?: string; value?: string };

  const load = (): Partial<Persisted> => {
    try {
      const raw = window.localStorage.getItem(cfg.storageKey);
      return raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
    } catch {
      return {};
    }
  };
  const saved = load();
  const state: Persisted = {
    accountIndex:
      typeof saved.accountIndex === "number" && saved.accountIndex >= 0 && saved.accountIndex < cfg.accounts.length
        ? saved.accountIndex
        : cfg.accountIndex,
    chainId: typeof saved.chainId === "number" ? saved.chainId : cfg.chainId,
    authorized: saved.authorized === true,
    knownChainIds: Array.isArray(saved.knownChainIds) ? saved.knownChainIds : cfg.knownChainIds.slice(),
  };
  const persist = () => {
    try {
      window.localStorage.setItem(cfg.storageKey, JSON.stringify(state));
    } catch {
      /* storage unavailable (opaque origin): state lives for this document only */
    }
  };

  const account = (): string => cfg.accounts[state.accountIndex] as string;
  const hexChainId = (): string => `0x${state.chainId.toString(16)}`;
  const rpcError = (code: number, message: string, data?: unknown) =>
    Object.assign(new Error(message), { code, data });

  // ---- events ----
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const l of Array.from(listeners.get(event) ?? [])) {
      try {
        l(...args);
      } catch (e) {
        console.error(`[test wallet] ${event} listener threw`, e);
      }
    }
  };

  // ---- request log (for assertions and failure reports) ----
  const log: LogEntry[] = [];
  const record = (e: LogEntry) => {
    log.push(e);
    if (log.length > 1000) log.shift();
  };

  // ---- one-shot failure (user rejection, or a response lost after the broadcast) ----
  let rejection: { method: string | null; mode: "reject" | "lose-response" } | null = null;
  const takeFailure = (method: string): "reject" | "lose-response" | null => {
    if (!rejection || !PROMPTS.includes(method)) return null;
    if (rejection.method !== null && rejection.method !== method) return null;
    if (rejection.mode === "lose-response" && method !== "eth_sendTransaction") return null;
    const mode = rejection.mode;
    rejection = null;
    return mode;
  };

  // ---- held prompts (a confirmation the user has not answered yet) ----
  let hold: { method: string | null } | null = null;
  const held: (() => void)[] = [];
  const takeHold = (method: string): boolean => {
    if (!hold || !PROMPTS.includes(method)) return false;
    if (hold.method !== null && hold.method !== method) return false;
    hold = null;
    return true;
  };

  // ---- forwarding ----
  let nextId = 1;
  const forward = async (method: string, params: unknown): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(cfg.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: params ?? [] }),
      });
    } catch (e) {
      throw rpcError(-32603, `test wallet: cannot reach ${cfg.rpcUrl}: ${String(e)}`);
    }
    const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw rpcError(body.error.code, body.error.message, body.error.data);
    return body.result;
  };

  const setChainId = (chainId: number) => {
    if (!state.knownChainIds.includes(chainId)) state.knownChainIds.push(chainId);
    if (chainId === state.chainId) {
      persist();
      return;
    }
    state.chainId = chainId;
    persist();
    emit("chainChanged", hexChainId());
  };

  const permissions = () =>
    state.authorized
      ? [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: [account()] }] }]
      : [];

  const chainIdParam = (params: unknown): number => {
    const raw = (params as { chainId?: string }[] | undefined)?.[0]?.chainId;
    return typeof raw === "string" ? Number(raw) : NaN;
  };

  const handle = async (method: string, params: unknown): Promise<unknown> => {
    if (takeHold(method)) await new Promise<void>((resolve) => held.push(resolve));
    const failure = takeFailure(method);
    if (failure === "reject") throw rpcError(4001, "User rejected the request.");
    switch (method) {
      case "eth_chainId":
        return hexChainId();
      case "net_version":
        return String(state.chainId);
      case "eth_accounts":
        return state.authorized ? [account()] : [];
      case "eth_requestAccounts":
        state.authorized = true;
        persist();
        return [account()];
      case "wallet_requestPermissions":
        state.authorized = true;
        persist();
        return permissions();
      case "wallet_getPermissions":
        return permissions();
      case "wallet_revokePermissions":
        state.authorized = false;
        persist();
        return null;
      case "wallet_switchEthereumChain": {
        const id = chainIdParam(params);
        if (!state.knownChainIds.includes(id)) throw rpcError(4902, `Unrecognized chain ID ${id}.`);
        setChainId(id);
        return null;
      }
      case "wallet_addEthereumChain": {
        // As MetaMask: add the chain, then (the user approving) switch to it.
        const id = chainIdParam(params);
        if (!Number.isSafeInteger(id) || id <= 0) throw rpcError(-32602, "Invalid chainId.");
        setChainId(id);
        return null;
      }
      case "eth_sendTransaction": {
        if (!state.authorized) throw rpcError(4100, "test wallet: not connected to this site.");
        const tx = (params as TxParams[] | undefined)?.[0];
        const from = tx?.from;
        if (!from || from.toLowerCase() !== account().toLowerCase()) {
          throw rpcError(4100, `test wallet: transaction from ${String(from)}, but the selected account is ${account()}.`);
        }
        if (state.chainId !== cfg.rpcChainId) {
          throw rpcError(-32603, `test wallet: no RPC for chain ${state.chainId}; it can only send on ${cfg.rpcChainId}.`);
        }
        const hash = await forward(method, params);
        if (failure === "lose-response") {
          // An internal error, as a wallet whose answer got lost would report; the marker is for the log only.
          throw Object.assign(rpcError(-32603, "test wallet: the transaction was broadcast, then the response was lost."), {
            e2eBroadcastHash: String(hash),
          });
        }
        return hash;
      }
      default:
        if (method.startsWith("wallet_")) throw rpcError(4200, `test wallet: ${method} is not supported.`);
        return forward(method, params);
    }
  };

  const provider = {
    isDmsTestWallet: true,
    async request(args: { method: string; params?: unknown }): Promise<unknown> {
      const method = args?.method;
      if (typeof method !== "string") throw rpcError(-32600, "test wallet: request without a method.");
      const tx = method === "eth_sendTransaction" ? (args.params as TxParams[] | undefined)?.[0] : undefined;
      const txInfo = tx
        ? { to: tx.to, from: tx.from, value: tx.value, dataHead: typeof tx.data === "string" ? tx.data.slice(0, 138) : undefined }
        : {};
      try {
        const result = await handle(method, args.params);
        record({ at: Date.now(), method, ok: true, ...txInfo, ...(tx ? { hash: String(result) } : {}) });
        return result;
      } catch (e) {
        const err = e as { code?: number; message?: string; e2eBroadcastHash?: string };
        const lost = err.e2eBroadcastHash ? { broadcast: true, hash: err.e2eBroadcastHash } : {};
        record({ at: Date.now(), method, ok: false, code: err.code, message: err.message, ...txInfo, ...lost });
        throw e;
      }
    },
    on(event: string, listener: Listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return provider;
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return provider;
    },
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return provider;
    },
  };

  const control = {
    setAccount(index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= cfg.accounts.length) {
        throw new Error(`test wallet: no account #${index}`);
      }
      if (index === state.accountIndex) return;
      state.accountIndex = index;
      persist();
      if (state.authorized) emit("accountsChanged", [account()]);
    },
    setChainId,
    rejectNext(method: string | null) {
      rejection = { method, mode: "reject" };
    },
    failNext(method: string | null, mode: "reject" | "lose-response") {
      rejection = { method, mode };
    },
    clearRejection() {
      rejection = null;
    },
    holdNext(method: string | null) {
      hold = { method };
    },
    releaseHeld() {
      hold = null;
      const all = held.splice(0);
      for (const go of all) go();
      return all.length;
    },
    disconnect() {
      state.authorized = false;
      persist();
      emit("accountsChanged", []);
    },
    snapshot() {
      return {
        account: account(),
        accountIndex: state.accountIndex,
        chainId: state.chainId,
        authorized: state.authorized,
        pendingRejection: rejection ? `${rejection.mode}: ${rejection.method ?? "any prompt"}` : null,
        held: held.length,
      };
    },
    log() {
      return log.slice();
    },
  };
  Object.defineProperty(window, "__dmsE2EWallet", { value: Object.freeze(control), configurable: false });

  if (cfg.exposeWindowEthereum && !w.ethereum) {
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: false });
  }

  // EIP-6963: announce now and whenever a dapp asks.
  const detail = Object.freeze({ info: Object.freeze({ ...cfg.info }), provider });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}
