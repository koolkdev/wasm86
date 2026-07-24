import type { Operation } from "#compiler/ir/operations/index.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  controlCompletes,
  type Control
} from "#compiler/ir/controls/index.js";

export type RegionNode = Operation | Control;

// `result` is the fallthrough value a body delivers when its owning control
// declares an output; escaping bodies carry none.
export type Region = Readonly<{
  nodes: readonly RegionNode[];
  result?: ValueId;
}>;

export function regionCompletes(body: Region): boolean {
  const last = body.nodes[body.nodes.length - 1];

  return last?.category === "control" &&
    controlCompletes(last, { regionCompletes });
}
