"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { useAccount } from "wagmi";
import { chainLabel, deploymentOf, deploymentsFor, isSupportedChainId, type Deployment } from "@/lib/contracts";
import { ChainScope, useSwitchOnDeployments } from "@/lib/hooks";
import { switchPath } from "@/lib/switch";
import { SwitchCard } from "@/components/switch/SwitchCard";
import { SwitchChooser, SwitchLookupFailed } from "@/components/switch/SwitchChooser";
import { Address } from "@/components/ui/Address";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/Loading";
import { upperFirst } from "@/components/ui/NetworkGuard";
import { Note } from "@/components/ui/Note";

const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Route segments and `?contract=` are user-supplied: validate before they
 * reach any RPC call. `contract` is null for a link that names none (links
 * from before switch links carried it).
 */
const parseRoute = (p: { chainId?: string; owner?: string; id?: string }, contractParam: string | null) => {
  if (!p.chainId || !/^\d{1,12}$/.test(p.chainId)) return null;
  const chainId = Number(p.chainId);
  const raw = p.owner ?? "";
  const owner = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!isAddress(owner, { strict: false })) return null;
  if (!p.id || !/^\d{1,78}$/.test(p.id)) return null;
  const id = BigInt(p.id);
  if (id === 0n || id > UINT256_MAX) return null;
  if (contractParam !== null && !isAddress(contractParam, { strict: false })) return null;
  return { chainId, owner: getAddress(owner), id, contract: contractParam === null ? null : getAddress(contractParam) };
};

/**
 * One switch's page. The link names its deployment (`?contract=`, lib/switch.ts
 * switchPath): the chain's current one, or a previous one whose switches are
 * still live (lib/contracts.ts deploymentsFor). A contract this site does not
 * know is refused: nothing is read from it or sent to it. A link that names no
 * contract is looked up on every deployment of the chain (ResolveLink).
 */
export default function SwitchDetailPage() {
  const params = useParams<{ chainId: string; owner: string; id: string }>();
  const search = useSearchParams();
  const { isConnected, chainId: walletChainId } = useAccount();
  const parsed = parseRoute(params ?? {}, search?.get("contract") ?? null);

  if (!parsed) {
    return (
      <EmptyState
        icon="alert"
        title="That link isn't valid"
        body="A switch link looks like /switch/<chainId>/<owner address>/<id>, with a decimal id. Its ?contract= part, when present, is the address of the deployment the switch lives on."
      />
    );
  }

  const { chainId, owner, id, contract } = parsed;
  if (!isSupportedChainId(chainId)) {
    return (
      <EmptyState
        icon="alert"
        title={`${upperFirst(chainLabel(chainId))} is not supported`}
        body="Switches live on Ethereum mainnet or Sepolia, where Zama's fhEVM is deployed."
      />
    );
  }
  const deployments = deploymentsFor(chainId);
  if (deployments.length === 0) {
    return (
      <EmptyState
        icon="alert"
        title={`No deployment on ${chainLabel(chainId)}`}
        body="This build has no DeadManSwitch address for that network."
      />
    );
  }
  const named = contract ? deploymentOf(chainId, contract) : undefined;
  if (contract && !named) {
    return (
      <EmptyState
        icon="alert"
        title="Unknown contract"
        body={`This link names contract ${contract}, which is not a DeadManSwitch deployment this site knows on ${chainLabel(chainId)}. Nothing is read from it or sent to it.`}
      />
    );
  }

  return (
    <ChainScope value={chainId}>
      <div className="mx-auto max-w-3xl space-y-4">
        <header>
          <h1 className="page-title">Switch <span className="value">#{id.toString()}</span></h1>
          <p className="page-lede">
            {/* In full: a shortened owner can be matched by a vanity lookalike. */}
            {chainLabel(chainId)} · owner <Address address={owner} chainId={chainId} copyTitle="Copy owner address" className="text-xs sm:text-sm" />
          </p>
        </header>

        {isConnected && walletChainId !== chainId && (
          <Note tone="info" title={`This switch lives on ${chainLabel(chainId)}`}>
            <p className="text-sm">
              Your wallet is on {walletChainId ? chainLabel(walletChainId) : "another network"}. Everything below is
              read from {chainLabel(chainId)}; actions will ask you to switch networks first.
            </p>
          </Note>
        )}

        {named || deployments.length === 1
          ? <SwitchOn chainId={chainId} deployment={named ?? deployments[0]!} owner={owner} id={id} />
          : <ResolveLink chainId={chainId} owner={owner} id={id} />}
      </div>
    </ChainScope>
  );
}

/** The switch on one deployment: which contract it is, then its card. */
function SwitchOn({ chainId, deployment, owner, id }: { chainId: number; deployment: Deployment; owner: `0x${string}`; id: bigint }) {
  return (
    <>
      <p className="flex max-w-none flex-wrap items-center gap-x-1.5 text-xs text-fg-muted">
        Contract <Address address={deployment.address} chainId={chainId} copyTitle="Copy contract address" className="text-xs" />
        {!deployment.current && <span>· an older deployment of this app</span>}
      </p>
      <SwitchCard handle={{ contractAddr: deployment.address, owner, id }} variant="detail" />
    </>
  );
}

/**
 * A link that names no contract. After a redeploy the same (owner, id) can be
 * a different switch on each deployment, or exist only on the older one. Each
 * deployment is read first; nothing is shown as "no such switch" while one is
 * still out. Shown: the switch where it exists; when it exists on more than
 * one, a chooser with no actions (SwitchChooser), since a ping meant for one
 * would leave the other to go dark; when a deployment could not be read, no
 * actions either (SwitchLookupFailed): it may hold the other one.
 */
function ResolveLink({ chainId, owner, id }: { chainId: number; owner: `0x${string}`; id: bigint }) {
  const rows = useSwitchOnDeployments(owner, id);
  if (rows.some((r) => !r.info && !r.error)) return <SkeletonCard />;
  const found = rows.filter((r) => r.info?.exists);
  const unread = rows.filter((r) => !r.info && r.error);
  if (unread.length > 0) return <SwitchLookupFailed chainId={chainId} owner={owner} id={id} rows={rows} />;
  const shown = found.find((r) => r.deployment.current) ?? found[0] ?? rows[0]!;
  const linkTo = (d: Deployment) => switchPath(chainId, { contractAddr: d.address, owner, id });
  return (
    <>
      {found.length === 1 && !shown.deployment.current && (
        <Note tone="info" title="Found on an older deployment">
          <p className="text-sm">
            This link names no contract. Switch #{id.toString()} of this owner is on an older deployment of this app,
            which still works for it. Its own link:{" "}
            <Link href={linkTo(shown.deployment)} className="value break-all underline-offset-2 hover:underline">
              {linkTo(shown.deployment)}
            </Link>
          </p>
        </Note>
      )}
      {found.length > 1
        ? <SwitchChooser chainId={chainId} owner={owner} id={id} choices={found.map((r) => ({ deployment: r.deployment, info: r.info! }))} />
        : <SwitchOn chainId={chainId} deployment={shown.deployment} owner={owner} id={id} />}
    </>
  );
}
