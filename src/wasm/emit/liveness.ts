import { assert } from "#common/assert.js";
import type { Body, IrBlock } from "#ir/block.js";
import { opAccess } from "#ir/ops.js";
import { actionOutput, finishOperands, nestedBodies } from "#ir/traverse.js";
import { valueChildren, valueId, type ValueId } from "#ir/values.js";

// The semantic value reachability needed outside emission. It deliberately
// says nothing about how many times the emitter pushes a value or where an op
// is scheduled.
export type BlockLiveness = Readonly<{
  isLive(id: ValueId): boolean;
}>;

export function analyzeLiveness(
  block: IrBlock,
  exportedOutputs: Iterable<ValueId> = []
): BlockLiveness {
  return new LivenessAnalysis(block, exportedOutputs);
}

class LivenessAnalysis implements BlockLiveness {
  readonly #block: IrBlock;
  readonly #live = new Set<ValueId>();
  // Action/control output leaves have dependencies outside the value node
  // itself: op operands or the results of each switch arm.
  readonly #outputDependencies = new Map<ValueId, readonly ValueId[]>();

  constructor(block: IrBlock, exportedOutputs: Iterable<ValueId>) {
    this.#block = block;
    this.#recordBody(block.body);

    for (const output of exportedOutputs) {
      this.#markLive(output);
    }

    this.#propagate();
  }

  isLive(id: ValueId): boolean {
    this.#block.values.node(id);
    return this.#live.has(id);
  }

  #recordBody(body: Body): void {
    for (const action of body.actions) {
      switch (action.kind) {
        case "op": {
          const access = opAccess(action.op);
          const output = actionOutput(action, access);

          if (output === undefined) {
            for (const input of access.valueInputs) {
              this.#markLive(input);
            }
            break;
          }

          assert(!this.#outputDependencies.has(output), `value ${output} already has an output producer`);
          this.#outputDependencies.set(output, access.valueInputs);
          break;
        }
        case "if":
          this.#markLive(action.condition);
          break;
        case "switch": {
          this.#markLive(action.selector);

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
            this.#markLive(cell.seed);
          }
          break;
        case "loopContinue":
          for (const update of action.updates) {
            this.#markLive(update);
          }
          break;
        case "finish":
          for (const operand of finishOperands(action.finish)) {
            this.#markLive(operand);
          }
          break;
      }

      for (const nested of nestedBodies(action)) {
        this.#recordBody(nested);
      }
    }
  }

  // ValueTable construction and producer validation establish a topological
  // id order. Walking it backwards therefore settles every live parent's
  // dependencies before their ids are reached.
  #propagate(): void {
    for (let rawId = this.#block.values.size() - 1; rawId >= 0; rawId -= 1) {
      const id = valueId(rawId);

      if (!this.#live.has(id)) {
        continue;
      }

      const dependencies = this.#outputDependencies.get(id) ??
        valueChildren(this.#block.values.node(id));

      for (const dependency of dependencies) {
        this.#markLive(dependency);
      }
    }
  }

  #markLive(id: ValueId): void {
    this.#block.values.node(id);
    this.#live.add(id);
  }
}
