import type { ResourceEffect } from "#compiler/function/resource.js";
import type { RegionNode } from "#compiler/function/region.js";

export type RegionNodeSink = Readonly<{
  append(node: RegionNode): "retained" | "routed";
  nodes(): readonly RegionNode[];
}>;

export class BufferedRegionNodeSink implements RegionNodeSink {
  readonly #nodes: RegionNode[] = [];

  append(node: RegionNode): "retained" {
    this.#nodes.push(node);
    return "retained";
  }

  nodes(): readonly RegionNode[] {
    return [...this.#nodes];
  }
}

export type ResourceReadPlacement = "entry" | "body";

export class LoopBodySink implements RegionNodeSink {
  readonly #appendEntry: (node: RegionNode) => void;
  readonly #resourceReadPlacement: (effect: ResourceEffect) => ResourceReadPlacement;
  readonly #nodes: RegionNode[] = [];

  constructor(
    appendEntry: (node: RegionNode) => void,
    resourceReadPlacement: (effect: ResourceEffect) => ResourceReadPlacement
  ) {
    this.#appendEntry = appendEntry;
    this.#resourceReadPlacement = resourceReadPlacement;
  }

  append(node: RegionNode): "retained" | "routed" {
    if (
      node.category === "operation" &&
      node.kind === "resource.read" &&
      this.#resourceReadPlacement(node.source.effect) === "entry"
    ) {
      this.#appendEntry(node);
      return "routed";
    }

    this.#nodes.push(node);
    return "retained";
  }

  nodes(): readonly RegionNode[] {
    return [...this.#nodes];
  }
}
