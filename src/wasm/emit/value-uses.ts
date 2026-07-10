import { assert } from "#common/assert.js";
import type { Body, IrBlock } from "#ir/block.js";
import { opAccess } from "#ir/ops.js";
import { actionOutput, finishOperands, nestedBodies } from "#ir/traverse.js";
import { valueChildren, valueId, type ValueId } from "#ir/values.js";
import type { BlockLiveness } from "./liveness.js";

// Counts concrete consuming sites emitted for each value. Compound captures
// and stable action/switch output bindings use them to release physical locals
// after their final emitted get; repeated borrowed gets are covered by a pin.
export type ValueUses = Readonly<{
  useCount(id: ValueId): number;
}>;

export function analyzeValueUses(
  block: IrBlock,
  liveness: BlockLiveness,
  exportedOutputs: Iterable<ValueId> = []
): ValueUses {
  return new ValueUseAnalysis(block, liveness, exportedOutputs);
}

class ValueUseAnalysis implements ValueUses {
  readonly #block: IrBlock;
  readonly #liveness: BlockLiveness;
  readonly #useCounts = new Map<ValueId, number>();
  // Action/control output leaves carry dependencies outside their value node.
  readonly #outputDependencies = new Map<ValueId, readonly ValueId[]>();

  constructor(
    block: IrBlock,
    liveness: BlockLiveness,
    exportedOutputs: Iterable<ValueId>
  ) {
    this.#block = block;
    this.#liveness = liveness;
    this.#recordBody(block.body);

    for (const output of exportedOutputs) {
      this.#addUse(output);
    }

    this.#propagate();
  }

  useCount(id: ValueId): number {
    this.#block.values.node(id);
    return this.#useCounts.get(id) ?? 0;
  }

  #recordBody(body: Body): void {
    for (const action of body.actions) {
      switch (action.kind) {
        case "op": {
          const access = opAccess(action.op);
          const output = actionOutput(action, access);

          if (output === undefined) {
            for (const input of access.valueInputs) {
              this.#addUse(input);
            }
            break;
          }

          assert(!this.#outputDependencies.has(output), `value ${output} already has an output producer`);
          this.#outputDependencies.set(output, access.valueInputs);
          break;
        }
        case "if":
          this.#addUse(action.condition);
          break;
        case "switch": {
          this.#addUse(action.selector);

          const results = nestedBodies(action).map((nested) => {
            const result = nested.result;

            assert(result !== undefined, "switch arm has no result");
            return result;
          });

          assert(
            !this.#outputDependencies.has(action.output),
            `value ${action.output} already has an output producer`
          );
          this.#outputDependencies.set(action.output, results);
          break;
        }
        case "loop":
          for (const cell of action.carried) {
            this.#addUse(cell.seed);
          }
          break;
        case "loopContinue":
          for (const update of action.updates) {
            this.#addUse(update);
          }
          break;
        case "finish":
          for (const operand of finishOperands(action.finish)) {
            this.#addUse(operand);
          }
          break;
      }

      for (const nested of nestedBodies(action)) {
        this.#recordBody(nested);
      }
    }
  }

  // A compound or producer computes once for however many counted replays it
  // has, so its dependencies are charged once per child edge, not once per
  // replay. Topological value ids make one descending pass sufficient.
  #propagate(): void {
    for (let rawId = this.#block.values.size() - 1; rawId >= 0; rawId -= 1) {
      const id = valueId(rawId);
      const uses = this.#useCounts.get(id) ?? 0;

      if (!this.#liveness.isLive(id)) {
        assert(uses === 0, `dead value ${id} has emitter uses`);
        continue;
      }

      assert(uses > 0, `live value ${id} has no emitter uses`);

      const dependencies = this.#outputDependencies.get(id) ??
        valueChildren(this.#block.values.node(id));

      for (const dependency of dependencies) {
        this.#addUse(dependency);
      }
    }
  }

  #addUse(id: ValueId): void {
    this.#block.values.node(id);
    this.#useCounts.set(id, (this.#useCounts.get(id) ?? 0) + 1);
  }
}
