import { assert } from "#common/assert.js";
import type { BodyAnalysis, SiteId } from "#compiler/analysis/model.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Body, IrBlock } from "#ir/block.js";
import { valueDependsOn } from "#ir/traverse.js";

type LoopBoundary = Readonly<{
  owner: SiteId;
  scoped: Set<ValueId>;
}>;

export class LoopAnchors {
  readonly #loops = new Map<Body, LoopBoundary>();

  constructor(
    private readonly block: IrBlock,
    private readonly analysis: BodyAnalysis
  ) {
    const addScoped = (
      value: ValueId,
      loops: readonly LoopBoundary[]
    ): void => {
      for (const loop of loops) {
        loop.scoped.add(value);
      }
    };
    const visit = (body: Body, loops: readonly LoopBoundary[]): void => {
      for (const [index, node] of body.nodes.entries()) {
        for (const output of node.outputs) {
          addScoped(output, loops);
        }
        if (node.category === "operation") {
          continue;
        }

        for (const nested of node.nestedBodies) {
          if (nested.scope.kind !== "loop") {
            visit(nested.body, loops);
            continue;
          }
          const loop: LoopBoundary = {
            owner: analysis.siteOf(body, index),
            scoped: new Set(nested.scope.inputs)
          };

          this.#loops.set(nested.body, loop);
          for (const input of nested.scope.inputs) {
            addScoped(input, loops);
          }
          visit(nested.body, [...loops, loop]);
        }
      }
    };

    // Inputs and subtree outputs are scoped to one loop iteration.
    visit(block.body, []);
  }

  lift(value: ValueId, anchor: SiteId): SiteId {
    let result = anchor;

    while (true) {
      const next = this.#next(value, result);

      if (next === undefined) {
        return result;
      }

      result = next;
    }
  }

  allows(value: ValueId, floor: SiteId, anchor: SiteId): boolean {
    let current = floor;

    while (true) {
      if (current === anchor) {
        return true;
      }

      const next = this.#next(value, current);

      if (next === undefined) {
        return false;
      }

      current = next;
    }
  }

  #next(value: ValueId, anchor: SiteId): SiteId | undefined {
    // Trapping recipes stay in their guarded region.
    if (!this.block.values.isNonTrapping(value)) {
      return undefined;
    }

    const site = this.analysis.sites()[anchor];

    assert(site !== undefined && site.id === anchor, `unknown placement site ${anchor}`);
    const loop = this.#loops.get(site.body);

    return loop !== undefined &&
        !valueDependsOn(this.block.values, value, loop.scoped)
      ? loop.owner
      : undefined;
  }
}
