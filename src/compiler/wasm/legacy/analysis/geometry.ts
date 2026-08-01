import { assert } from "#common/assert.js";
import type { Region, RegionNode } from "#compiler/ir/region.js";
import type { RegionPathStep, RegionSite, SiteId } from "./model.js";

type RegionInfo = Readonly<{
  sites: SiteId[];
  ancestry: readonly Region[];
  owner: SiteId | undefined;
  isLoop: boolean;
}>;

export class FunctionGeometry {
  readonly #sites: RegionSite[] = [];
  readonly #regions = new Map<Region, RegionInfo>();

  constructor(root: Region) {
    this.#regions.set(root, {
      sites: [],
      ancestry: [root],
      owner: undefined,
      isLoop: false
    });
  }

  sites(): readonly RegionSite[] {
    return this.#sites;
  }

  siteOf(region: Region, nodeIndex: number): SiteId {
    const regionInfo = this.#regions.get(region);

    assert(regionInfo !== undefined, "region is not part of this analysis");
    assert(Number.isInteger(nodeIndex), `region node index must be an integer, got ${nodeIndex}`);
    const site = regionInfo.sites[nodeIndex];

    assert(site !== undefined, `region has no site at node index ${nodeIndex}`);
    return site;
  }

  path(ancestor: Region, descendant: Region): readonly RegionPathStep[] | undefined {
    const ancestorInfo = this.#regions.get(ancestor);
    const descendantInfo = this.#regions.get(descendant);
    const ancestorPath = ancestorInfo?.ancestry;
    const descendantPath = descendantInfo?.ancestry;

    if (ancestorPath === undefined || descendantPath?.[ancestorPath.length - 1] !== ancestor) {
      return undefined;
    }
    const result: RegionPathStep[] = [];

    for (let index = ancestorPath.length; index < descendantPath.length; index += 1) {
      const region = descendantPath[index];

      assert(region !== undefined, "missing region on descendant path");
      const regionInfo = this.#regions.get(region);

      assert(regionInfo !== undefined, "descendant region has no analysis info");
      const owner = regionInfo.owner;

      assert(owner !== undefined, "descendant region has no owner");
      result.push({ region, owner });
    }

    return result;
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

  regionEndSite(region: Region): SiteId {
    return this.siteOf(region, region.nodes.length);
  }

  isLoopRegion(region: Region): boolean {
    return this.#regions.get(region)?.isLoop === true;
  }

  registerNested(region: Region, owner: SiteId, isLoop = false): void {
    assert(!this.#regions.has(region), "region object has more than one owner");
    const ownerRegion = this.site(owner).region;
    const ownerInfo = this.#regions.get(ownerRegion);

    assert(ownerInfo !== undefined, "nested region owner has no analysis info");
    this.#regions.set(region, {
      sites: [],
      ancestry: [...ownerInfo.ancestry, region],
      owner,
      isLoop
    });
  }

  addNode(region: Region, nodeIndex: number, node: RegionNode): SiteId {
    const regionInfo = this.#regions.get(region);

    assert(regionInfo !== undefined, "region is not part of this analysis");
    const id = siteId(this.#sites.length);

    this.#sites.push({ id, kind: "node", region, nodeIndex, node });
    regionInfo.sites.push(id);
    return id;
  }

  addEnd(region: Region): SiteId {
    const regionInfo = this.#regions.get(region);

    assert(regionInfo !== undefined, "region is not part of this analysis");
    const id = siteId(this.#sites.length);

    this.#sites.push({
      id,
      kind: "regionEnd",
      region,
      nodeIndex: region.nodes.length
    });
    regionInfo.sites.push(id);
    return id;
  }

  site(id: SiteId): RegionSite {
    const site = this.#sites[id];

    assert(site !== undefined && site.id === id, `unknown function analysis site ${id}`);
    return site;
  }

  #commonDominator(a: SiteId, b: SiteId): SiteId {
    const aSite = this.site(a);
    const bSite = this.site(b);
    const region = this.#commonRegion(aSite.region, bSite.region);
    const index = Math.min(
      this.#projectedIndex(aSite, region),
      this.#projectedIndex(bSite, region)
    );

    return this.siteOf(region, index);
  }

  #commonRegion(a: Region, b: Region): Region {
    const aPath = this.#regions.get(a)?.ancestry;
    const bPath = this.#regions.get(b)?.ancestry;

    assert(aPath !== undefined && bPath !== undefined, "site region has no ancestry");
    let common: Region | undefined;

    for (let index = 0; index < Math.min(aPath.length, bPath.length); index += 1) {
      if (aPath[index] !== bPath[index]) {
        break;
      }
      common = aPath[index];
    }

    assert(common !== undefined, "sites share no region ancestor");
    return common;
  }

  #projectedIndex(site: RegionSite, region: Region): number {
    if (site.region === region) {
      return site.nodeIndex;
    }
    const regionPath = this.#regions.get(region)?.ancestry;
    const sitePath = this.#regions.get(site.region)?.ancestry;

    assert(
      regionPath !== undefined && sitePath?.[regionPath.length - 1] === region,
      "site is outside its dominating region"
    );
    const child = sitePath[regionPath.length];

    assert(child !== undefined, "site has no projected child region");
    const childInfo = this.#regions.get(child);

    assert(childInfo !== undefined, "projected child region has no analysis info");
    const owner = childInfo.owner;

    assert(owner !== undefined, "projected child region has no owner");
    const ownerSite = this.site(owner);

    assert(
      ownerSite.kind === "node" && ownerSite.region === region,
      "projected child region has the wrong owner"
    );
    return ownerSite.nodeIndex;
  }
}

function siteId(raw: number): SiteId {
  return raw as SiteId;
}
