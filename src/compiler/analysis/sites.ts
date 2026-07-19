import { assert } from "#common/assert.js";
import type { Body, BodyNode } from "#ir/block.js";
import type {
  BodyPathStep,
  BodySite,
  SiteId
} from "./model.js";

type BodyInfo = Readonly<{
  sites: SiteId[];
  ancestry: readonly Body[];
  owner: SiteId | undefined;
  isLoop: boolean;
}>;

export class SiteIndex {
  readonly #sites: BodySite[] = [];
  readonly #bodies = new Map<Body, BodyInfo>();

  constructor(root: Body) {
    this.#bodies.set(root, {
      sites: [],
      ancestry: [root],
      owner: undefined,
      isLoop: false
    });
  }

  sites(): readonly BodySite[] {
    return this.#sites;
  }

  siteOf(body: Body, nodeIndex: number): SiteId {
    const bodyInfo = this.#bodies.get(body);

    assert(bodyInfo !== undefined, "body is not part of this analysis");
    assert(Number.isInteger(nodeIndex), `body node index must be an integer, got ${nodeIndex}`);
    const site = bodyInfo.sites[nodeIndex];

    assert(site !== undefined, `body has no site at node index ${nodeIndex}`);
    return site;
  }

  path(ancestor: Body, descendant: Body): readonly BodyPathStep[] | undefined {
    const ancestorInfo = this.#bodies.get(ancestor);
    const descendantInfo = this.#bodies.get(descendant);
    const ancestorPath = ancestorInfo?.ancestry;
    const descendantPath = descendantInfo?.ancestry;

    if (
      ancestorPath === undefined ||
      descendantPath?.[ancestorPath.length - 1] !== ancestor
    ) {
      return undefined;
    }
    const result: BodyPathStep[] = [];

    for (let index = ancestorPath.length; index < descendantPath.length; index += 1) {
      const body = descendantPath[index];

      assert(body !== undefined, "missing body on descendant path");
      const bodyInfo = this.#bodies.get(body);

      assert(bodyInfo !== undefined, "descendant body has no analysis info");
      const owner = bodyInfo.owner;

      assert(owner !== undefined, "descendant body has no owner");
      result.push({ body, owner });
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

  bodyEndSite(body: Body): SiteId {
    return this.siteOf(body, body.nodes.length);
  }

  isLoopBody(body: Body): boolean {
    return this.#bodies.get(body)?.isLoop === true;
  }

  registerNested(
    body: Body,
    owner: SiteId,
    isLoop = false
  ): void {
    assert(!this.#bodies.has(body), "body object has more than one owner");
    const ownerBody = this.site(owner).body;
    const ownerInfo = this.#bodies.get(ownerBody);

    assert(ownerInfo !== undefined, "nested body owner has no analysis info");
    this.#bodies.set(body, {
      sites: [],
      ancestry: [...ownerInfo.ancestry, body],
      owner,
      isLoop
    });
  }

  addNode(body: Body, nodeIndex: number, node: BodyNode): SiteId {
    const bodyInfo = this.#bodies.get(body);

    assert(bodyInfo !== undefined, "body is not part of this analysis");
    const id = siteId(this.#sites.length);

    this.#sites.push({ id, kind: "node", body, nodeIndex, node });
    bodyInfo.sites.push(id);
    return id;
  }

  addEnd(body: Body): SiteId {
    const bodyInfo = this.#bodies.get(body);

    assert(bodyInfo !== undefined, "body is not part of this analysis");
    const id = siteId(this.#sites.length);

    this.#sites.push({
      id,
      kind: "bodyEnd",
      body,
      nodeIndex: body.nodes.length
    });
    bodyInfo.sites.push(id);
    return id;
  }

  site(id: SiteId): BodySite {
    const site = this.#sites[id];

    assert(site !== undefined && site.id === id, `unknown body analysis site ${id}`);
    return site;
  }

  #commonDominator(a: SiteId, b: SiteId): SiteId {
    const aSite = this.site(a);
    const bSite = this.site(b);
    const body = this.#commonBody(aSite.body, bSite.body);
    const index = Math.min(
      this.#projectedIndex(aSite, body),
      this.#projectedIndex(bSite, body)
    );

    return this.siteOf(body, index);
  }

  #commonBody(a: Body, b: Body): Body {
    const aPath = this.#bodies.get(a)?.ancestry;
    const bPath = this.#bodies.get(b)?.ancestry;

    assert(aPath !== undefined && bPath !== undefined, "site body has no ancestry");
    let common: Body | undefined;

    for (let index = 0; index < Math.min(aPath.length, bPath.length); index += 1) {
      if (aPath[index] !== bPath[index]) {
        break;
      }
      common = aPath[index];
    }

    assert(common !== undefined, "sites share no body ancestor");
    return common;
  }

  #projectedIndex(site: BodySite, body: Body): number {
    if (site.body === body) {
      return site.nodeIndex;
    }
    const bodyPath = this.#bodies.get(body)?.ancestry;
    const sitePath = this.#bodies.get(site.body)?.ancestry;

    assert(
      bodyPath !== undefined && sitePath?.[bodyPath.length - 1] === body,
      "site is outside its dominating body"
    );
    const child = sitePath[bodyPath.length];

    assert(child !== undefined, "site has no projected child body");
    const childInfo = this.#bodies.get(child);

    assert(childInfo !== undefined, "projected child body has no analysis info");
    const owner = childInfo.owner;

    assert(owner !== undefined, "projected child body has no owner");
    const ownerSite = this.site(owner);

    assert(
      ownerSite.kind === "node" && ownerSite.body === body,
      "projected child body has the wrong owner"
    );
    return ownerSite.nodeIndex;
  }
}

function siteId(raw: number): SiteId {
  return raw as SiteId;
}
