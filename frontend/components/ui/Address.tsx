import { explorerAddress } from "@/lib/contracts";
import { CopyButton } from "./Copy";

/**
 * The address of a party (a switch's owner, a publisher, the admin), shown in
 * full. A shortened 0x1234…abcd keeps 32 bits, which a vanity generator
 * matches in hours on a CPU, so a lookalike could pass for someone else.
 * Wraps rather than truncating; links to the explorer when the chain has one.
 */
export function Address({
  address, chainId, copyTitle = "Copy address", className = "",
}: {
  address: string;
  chainId: number;
  copyTitle?: string;
  className?: string;
}) {
  const href = explorerAddress(chainId, address);
  const cls = `value min-w-0 break-all ${className}`;
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      {href ? (
        <a className={`${cls} underline-offset-2 hover:text-fg hover:underline`} href={href} target="_blank" rel="noreferrer">
          {address}
        </a>
      ) : (
        <span className={cls}>{address}</span>
      )}
      <CopyButton value={address} title={copyTitle} />
    </span>
  );
}
