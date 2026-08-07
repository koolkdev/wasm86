import type { RegionNode } from "#compiler/function/region.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { RegionBuilder } from "./region.js";

export type RegionNodeSink = Readonly<{
  // Retain the node and return undefined, or return another region to route it
  // through.
  route(node: RegionNode): RegionBuilder | undefined;
  nodes(): readonly RegionNode[];
}>;

export class BufferedRegionNodeSink implements RegionNodeSink {
  readonly #nodes: RegionNode[] = [];

  route(node: RegionNode): undefined {
    this.#nodes.push(node);
  }

  nodes(): readonly RegionNode[] {
    return this.#nodes;
  }
}

export type ResourceReadPlacement = "entry" | "body";

export class LoopBodySink implements RegionNodeSink {
  readonly #entry: RegionBuilder;
  readonly #resourceReadPlacement: (effect: ResourceEffect) => ResourceReadPlacement;
  readonly #nodes: RegionNode[] = [];

  constructor(
    entry: RegionBuilder,
    resourceReadPlacement: (effect: ResourceEffect) => ResourceReadPlacement
  ) {
    this.#entry = entry;
    this.#resourceReadPlacement = resourceReadPlacement;
  }

  route(node: RegionNode): RegionBuilder | undefined {
    if (
      node.category === "operation" &&
      node.kind === "resource.read" &&
      this.#resourceReadPlacement(node.source.effect) === "entry"
    ) {
      return this.#entry;
    }

    this.#nodes.push(node);
    return undefined;
  }

  nodes(): readonly RegionNode[] {
    return this.#nodes;
  }
}
