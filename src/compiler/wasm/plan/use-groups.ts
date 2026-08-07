import {
  bodyEvent,
  type BlockId,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import {
  blockInfo,
  blockPath,
  dominatingSite,
  siteRecord
} from "#compiler/wasm/function/geometry.js";

// A non-speculatable recipe cannot move to a structured control header merely
// because several selected bodies use it. Give each mutually exclusive body
// its own static evaluation; header and continuation uses form another group.
export function groupSelectedUses(
  body: WasmBody,
  uses: readonly SiteId[]
): readonly (readonly SiteId[])[] | undefined {
  const anchor = dominatingSite(body, uses);
  const site = siteRecord(body, anchor);
  const event = bodyEvent(body, anchor);

  if (uses.includes(anchor) || (event.kind !== "if" && event.kind !== "switch")) {
    return undefined;
  }
  const groups = new Map<BlockId | undefined, SiteId[]>();

  for (const use of uses) {
    const useSite = body.sites[use];
    const first =
      useSite === undefined ? undefined : blockPath(body, site.block, useSite.block)?.[0];
    const selectedBody = first?.ownerSite === anchor ? first.block : undefined;
    const group = groups.get(selectedBody);

    if (group === undefined) {
      groups.set(selectedBody, [use]);
    } else {
      group.push(use);
    }
  }

  return groups.size > 1 ? [...groups.values()] : undefined;
}

// A branch hint is also a code-placement hint. When the non-main path exits,
// cheap selected expressions can remain on that path instead of being shared
// in the parent flow.
export function groupHintedUses(
  body: WasmBody,
  uses: readonly SiteId[]
): readonly [readonly SiteId[], readonly SiteId[]] | undefined {
  const anchor = dominatingSite(body, uses);
  const site = siteRecord(body, anchor);
  const event = bodyEvent(body, anchor);

  if (uses.includes(anchor) || event.kind !== "if") {
    return undefined;
  }
  // The then arm is the control's first body, the else arm its second.
  const otherArm = event.hint === "unlikely" ? 0 : event.hint === "likely" ? 1 : undefined;
  const otherBlock = otherArm === undefined ? undefined : event.arms[otherArm];

  if (otherBlock === undefined || !blockInfo(body, otherBlock).completes) {
    return undefined;
  }
  const main: SiteId[] = [];
  const other: SiteId[] = [];

  for (const use of uses) {
    const useSite = body.sites[use];
    const first =
      useSite === undefined ? undefined : blockPath(body, site.block, useSite.block)?.[0];

    if (first?.ownerSite === anchor && blockInfo(body, first.block).armIndex === otherArm) {
      other.push(use);
    } else {
      main.push(use);
    }
  }

  return main.length === 0 || other.length === 0 ? undefined : [main, other];
}
