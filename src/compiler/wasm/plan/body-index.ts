import { assert } from "#common/assert.js";
import {
  siteId,
  type BlockId,
  type BodySite,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";

type BlockEntry = {
  readonly ownerSite: SiteId | undefined;
  readonly depth: number;
  endSite: SiteId | undefined;
};

export type BlockPathStep = Readonly<{
  block: BlockId;
  ownerSite: SiteId;
}>;

// The body stream remains canonical. This index caches only block ownership,
// nesting depth, and end positions for repeated structural queries.
export class WasmBodyIndex {
  readonly #body: WasmBody;
  readonly #blocks: (BlockEntry | undefined)[] = [];

  constructor(body: WasmBody) {
    this.#body = body;
    this.#addBlock(body.entryBlock, undefined, 0);

    for (const [rawSite, site] of body.sites.entries()) {
      const id = siteId(rawSite);
      const block = this.#block(site.block);
      const childDepth = block.depth + 1;

      assert(block.endSite === undefined, `Wasm body block ${site.block} has sites after its end`);
      switch (site.event.kind) {
        case "if":
        case "switch":
          for (const child of site.event.arms) {
            this.#addBlock(child, id, childDepth);
          }
          break;
        case "loop":
          this.#addBlock(site.event.body, id, childDepth);
          break;
        case "end":
          block.endSite = id;
          break;
        default:
          break;
      }
    }
  }

  site(id: SiteId): BodySite {
    const site = this.#body.sites[id];

    assert(site !== undefined, `unknown Wasm body site ${id}`);
    return site;
  }

  endSite(block: BlockId): SiteId {
    const endSite = this.#block(block).endSite;

    assert(endSite !== undefined, `Wasm body block ${block} has no end`);
    return endSite;
  }

  loopOwner(block: BlockId): SiteId | undefined {
    const ownerSite = this.#block(block).ownerSite;

    if (ownerSite === undefined) {
      return undefined;
    }
    const event = this.site(ownerSite).event;

    return event.kind === "loop" && event.body === block ? ownerSite : undefined;
  }

  // The path excludes the ancestor and starts at its immediate child.
  path(ancestor: BlockId, descendant: BlockId): readonly BlockPathStep[] | undefined {
    this.#block(ancestor);
    const reverse: BlockPathStep[] = [];
    let cursor = descendant;

    while (cursor !== ancestor) {
      const ownerSite = this.#block(cursor).ownerSite;

      if (ownerSite === undefined) {
        return undefined;
      }
      reverse.push({ block: cursor, ownerSite });
      cursor = this.site(ownerSite).block;
    }
    reverse.reverse();
    return reverse;
  }

  dominatingSite(sites: readonly SiteId[]): SiteId {
    let result: SiteId | undefined;

    for (const site of sites) {
      this.site(site);
      result = result === undefined ? site : this.#commonDominator(result, site);
    }
    assert(result !== undefined, "cannot find a dominating site for no sites");
    return result;
  }

  #block(id: BlockId): BlockEntry {
    const block = this.#blocks[id];

    assert(block !== undefined, `unknown Wasm body block ${id}`);
    return block;
  }

  #addBlock(id: BlockId, ownerSite: SiteId | undefined, depth: number): void {
    assert(this.#blocks[id] === undefined, `Wasm body block ${id} has more than one owner`);
    this.#blocks[id] = { ownerSite, depth, endSite: undefined };
  }

  #commonDominator(a: SiteId, b: SiteId): SiteId {
    let aSite = a;
    let bSite = b;
    let aBlock = this.site(a).block;
    let bBlock = this.site(b).block;
    let aDepth = this.#block(aBlock).depth;
    let bDepth = this.#block(bBlock).depth;

    while (aDepth > bDepth) {
      const projected = this.#projectToParent(aBlock);

      aSite = projected.site;
      aBlock = projected.block;
      aDepth -= 1;
    }
    while (bDepth > aDepth) {
      const projected = this.#projectToParent(bBlock);

      bSite = projected.site;
      bBlock = projected.block;
      bDepth -= 1;
    }
    while (aBlock !== bBlock) {
      const projectedA = this.#projectToParent(aBlock);
      const projectedB = this.#projectToParent(bBlock);

      aSite = projectedA.site;
      aBlock = projectedA.block;
      bSite = projectedB.site;
      bBlock = projectedB.block;
    }
    return aSite < bSite ? aSite : bSite;
  }

  #projectToParent(block: BlockId): Readonly<{ block: BlockId; site: SiteId }> {
    const ownerSite = this.#block(block).ownerSite;

    assert(ownerSite !== undefined, "entry block has no parent projection");
    return { block: this.site(ownerSite).block, site: ownerSite };
  }
}
