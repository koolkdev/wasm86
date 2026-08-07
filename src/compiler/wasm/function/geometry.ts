import { assert } from "#common/assert.js";
import type { BlockId, BlockInfo, SiteId, SiteRecord, WasmBody } from "./body.js";

type BlockStep = Readonly<{ block: BlockId; ownerSite: SiteId }>;

export function blockInfo(body: WasmBody, block: BlockId): BlockInfo {
  const info = body.blocks[block];

  assert(info !== undefined, `unknown Wasm body block ${block}`);
  return info;
}

export function siteRecord(body: WasmBody, site: SiteId): SiteRecord {
  const record = body.sites[site];

  assert(record !== undefined, `unknown Wasm body site ${site}`);
  return record;
}

function siteAt(body: WasmBody, block: BlockId, nodeIndex: number): SiteId {
  assert(Number.isInteger(nodeIndex), `block node index must be an integer, got ${nodeIndex}`);
  const site = blockInfo(body, block).sites[nodeIndex];

  assert(site !== undefined, `block has no site at node index ${nodeIndex}`);
  return site;
}

// The path excludes the ancestor and starts at its immediate child.
export function blockPath(
  body: WasmBody,
  ancestor: BlockId,
  descendant: BlockId
): readonly BlockStep[] | undefined {
  const reverse: BlockStep[] = [];
  let cursor = descendant;

  while (cursor !== ancestor) {
    const info = blockInfo(body, cursor);

    if (info.parent === undefined) {
      return undefined;
    }
    const { ownerSite } = info;

    assert(ownerSite !== undefined, "nested block has no owner");
    reverse.push({ block: cursor, ownerSite });
    cursor = info.parent;
  }
  reverse.reverse();
  return reverse;
}

export function loopBoundary(body: WasmBody, block: BlockId): BlockInfo | undefined {
  const info = blockInfo(body, block);

  return info.isLoop ? info : undefined;
}

export function dominatingSite(body: WasmBody, sites: readonly SiteId[]): SiteId {
  let result: SiteId | undefined;

  for (const site of sites) {
    siteRecord(body, site);
    result = result === undefined ? site : commonDominator(body, result, site);
  }
  assert(result !== undefined, "cannot find a dominating site for no sites");
  return result;
}

function commonDominator(body: WasmBody, a: SiteId, b: SiteId): SiteId {
  const aSite = siteRecord(body, a);
  const bSite = siteRecord(body, b);
  let aBlock = aSite.block;
  let aInfo = blockInfo(body, aBlock);
  let bBlock = bSite.block;
  let bInfo = blockInfo(body, bBlock);

  while (aInfo.depth > bInfo.depth) {
    aBlock = parentBlock(aInfo);
    aInfo = blockInfo(body, aBlock);
  }
  while (bInfo.depth > aInfo.depth) {
    bBlock = parentBlock(bInfo);
    bInfo = blockInfo(body, bBlock);
  }
  while (aBlock !== bBlock) {
    aBlock = parentBlock(aInfo);
    aInfo = blockInfo(body, aBlock);
    bBlock = parentBlock(bInfo);
    bInfo = blockInfo(body, bBlock);
  }
  return siteAt(
    body,
    aBlock,
    Math.min(projectedIndex(body, aSite, aBlock), projectedIndex(body, bSite, aBlock))
  );
}

// A site outside the ancestor projects onto the node index of the control that
// owns the branch it sits in.
function projectedIndex(body: WasmBody, site: SiteRecord, ancestor: BlockId): number {
  if (site.block === ancestor) {
    return site.nodeIndex;
  }
  let child = blockInfo(body, site.block);

  while (child.parent !== ancestor) {
    child = blockInfo(body, parentBlock(child));
  }
  const { ownerSite } = child;

  assert(ownerSite !== undefined, "projected child block has no owner");
  const owner = siteRecord(body, ownerSite);

  assert(owner.block === ancestor, "projected child block has the wrong owner");
  return owner.nodeIndex;
}

function parentBlock(info: BlockInfo): BlockId {
  const { parent } = info;

  assert(parent !== undefined, "site block has no parent");
  return parent;
}
