import { assert } from "#common/assert.js";
import type { StorageAccess } from "#compiler/function/storage.js";
import { mayAlias } from "#compiler/function/storage.js";
import {
  BodyEvent,
  siteId,
  type BlockId,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { wasmValueId, type WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { WasmBodyIndex } from "./body-index.js";

export type ValueDemand = Readonly<{
  value: WasmValueId;
  consumedAt: SiteId;
}>;

export type OperationDefinition = Readonly<{
  kind: "operation";
  site: SiteId;
  operands: readonly WasmValueId[];
  reads: readonly StorageAccess[];
  hasWrites: boolean;
}>;

type JoinDefinition = Readonly<{
  kind: "join";
  site: SiteId;
  dependencies: readonly ValueDemand[];
}>;

type ValueDefinition = OperationDefinition | JoinDefinition;

type WriteSite = Readonly<{
  site: SiteId;
  writes: readonly StorageAccess[];
}>;

// A body-order pass records definitions, root demands, writes, and loop
// ownership. A value-order pass then propagates evaluation safety and the
// innermost loop required by each expression. Placement discards this analysis.
export class PlacementAnalysis {
  readonly index: WasmBodyIndex;
  readonly #definitions: (ValueDefinition | undefined)[];
  readonly #requiredLoops: (BlockId | undefined)[];
  readonly #canSpeculateEvaluation: Uint8Array;
  readonly #firstSites: (SiteId | undefined)[] = [];
  readonly #writeSites: WriteSite[] = [];
  readonly #rootDemands: ValueDemand[] = [];
  readonly #authoredOperationSites: SiteId[] = [];

  constructor(private readonly body: WasmBody) {
    this.index = new WasmBodyIndex(body);
    this.#definitions = new Array(body.values.length);
    this.#requiredLoops = new Array(body.values.length);
    this.#canSpeculateEvaluation = new Uint8Array(body.values.length);
    this.#scanBody();
    this.#analyzeValues();
  }

  definition(value: WasmValueId): ValueDefinition | undefined {
    this.body.values.node(value);
    return this.#definitions[value];
  }

  requiredLoop(value: WasmValueId): BlockId | undefined {
    this.body.values.node(value);
    return this.#requiredLoops[value];
  }

  canSpeculateEvaluation(value: WasmValueId): boolean {
    this.body.values.node(value);
    return this.#canSpeculateEvaluation[value] !== 0;
  }

  canEvaluateWithAvailableValues(
    value: WasmValueId,
    isAvailable: (candidate: WasmValueId) => boolean
  ): boolean {
    this.body.values.node(value);
    const safety = new Map<WasmValueId, boolean>();
    const pending = [value];

    while (pending.length !== 0) {
      const current = pending[pending.length - 1];

      assert(current !== undefined, "evaluation-safety stack lost its current value");
      if (safety.has(current)) {
        pending.pop();
        continue;
      }
      if (this.#canSpeculateEvaluation[current] !== 0 || isAvailable(current)) {
        safety.set(current, true);
        pending.pop();
        continue;
      }
      if (!this.body.values.canSpeculateInstruction(current)) {
        safety.set(current, false);
        pending.pop();
        continue;
      }

      const inputs = this.body.values.node(current).inputs;
      let unresolved: WasmValueId | undefined;

      for (const input of inputs) {
        const inputSafety = safety.get(input);

        if (inputSafety === false) {
          safety.set(current, false);
          break;
        }
        if (inputSafety === undefined) {
          unresolved = input;
          break;
        }
      }
      if (safety.has(current)) {
        pending.pop();
      } else if (unresolved !== undefined) {
        assert(unresolved < current, `Wasm input ${unresolved} must precede value ${current}`);
        pending.push(unresolved);
      } else {
        safety.set(current, true);
        pending.pop();
      }
    }

    const result = safety.get(value);

    assert(result !== undefined, `evaluation safety for value ${value} was not resolved`);
    return result;
  }

  rootDemands(): readonly ValueDemand[] {
    return this.#rootDemands;
  }

  authoredOperationSites(): readonly SiteId[] {
    return this.#authoredOperationSites;
  }

  crossesAliasingWrite(reads: readonly StorageAccess[], producer: SiteId, anchor: SiteId): boolean {
    if (reads.length === 0) {
      return false;
    }
    const producerSite = this.index.site(producer);
    const anchorSite = this.index.site(anchor);
    const path = this.index.path(producerSite.block, anchorSite.block);

    assert(path !== undefined, "operation anchor leaves its definition scope");
    // Split the half-open interval at each selected child. Restarting at that
    // child's first site excludes sibling arms while retaining nested writes.
    let start = siteId(producer + 1);

    for (const step of path) {
      if (this.#hasAliasingWrite(start, step.ownerSite, reads)) {
        return true;
      }
      start = this.#firstSite(step.block);
    }
    return this.#hasAliasingWrite(start, anchor, reads);
  }

  #scanBody(): void {
    const enclosingLoops = new Map<BlockId, BlockId | undefined>([
      [this.body.entryBlock, undefined]
    ]);

    for (const [raw, site] of this.body.sites.entries()) {
      const id = siteId(raw);

      assert(
        enclosingLoops.has(site.block),
        `Wasm body block ${site.block} has no placement scope`
      );
      const currentLoop = enclosingLoops.get(site.block);
      const event = site.event;
      const { category, effects, operands, output } = BodyEvent.describe(event);

      if (this.#firstSites[site.block] === undefined) {
        this.#firstSites[site.block] = id;
      }
      if (effects.writes.length !== 0) {
        this.#writeSites.push({ site: id, writes: effects.writes });
      }

      if (category === "operation") {
        if (output !== undefined) {
          this.#define(output, {
            kind: "operation",
            site: id,
            operands,
            reads: effects.reads,
            hasWrites: effects.writes.length !== 0
          });
          this.#requiredLoops[output] = currentLoop;
        } else if (effects.writes.length !== 0) {
          this.#authoredOperationSites.push(id);
        }
      } else if ((event.kind === "if" || event.kind === "switch") && output !== undefined) {
        // Arm results are dependencies of the join, not roots: a dead join
        // does not make otherwise-unused arm values live.
        this.#define(output, {
          kind: "join",
          site: id,
          dependencies: event.arms.map((arm) => {
            const consumedAt = this.index.endSite(arm);
            const end = this.index.site(consumedAt).event;

            assert(end.kind === "end", `join arm ${arm} has no end event`);
            assert(end.result !== undefined, `join arm ${arm} has no result`);
            return { value: end.result, consumedAt };
          })
        });
        this.#requiredLoops[output] = currentLoop;
      }

      // Structural events always demand their operands. Operations seed demand
      // here only when writes retain an outputless operation; the reverse sweep
      // discovers write-retained operations whose output is dead.
      if (category !== "operation" || (output === undefined && effects.writes.length !== 0)) {
        for (const value of operands) {
          this.#rootDemands.push({ value, consumedAt: id });
        }
      }

      switch (event.kind) {
        case "if":
        case "switch":
          for (const arm of event.arms) {
            this.#addEnclosingLoop(enclosingLoops, arm, currentLoop);
          }
          break;
        case "loop":
          this.#addEnclosingLoop(enclosingLoops, event.body, event.body);
          for (const input of event.inputs) {
            this.body.values.node(input);
            assert(this.#requiredLoops[input] === undefined, `loop input ${input} has two owners`);
            this.#requiredLoops[input] = event.body;
          }
          break;
        default:
          break;
      }
    }
  }

  #analyzeValues(): void {
    for (let raw = 0; raw < this.body.values.length; raw += 1) {
      const value = wasmValueId(raw);
      const node = this.body.values.node(value);
      let canSpeculate = this.body.values.canSpeculateInstruction(value);

      for (const input of node.inputs) {
        assert(input < value, `Wasm input ${input} must precede value ${value}`);
        canSpeculate = canSpeculate && this.#canSpeculateEvaluation[input] !== 0;
      }
      this.#canSpeculateEvaluation[value] = canSpeculate ? 1 : 0;

      switch (node.kind) {
        case "producerOutput":
          assert(this.#definitions[value] !== undefined, `output value ${value} has no definition`);
          break;
        case "loopInput":
          assert(this.#requiredLoops[value] !== undefined, `loop input ${value} has no owner`);
          break;
        case "unary":
        case "binary":
        case "compare":
        case "eqz":
        case "convert":
        case "select": {
          let requiredLoop: BlockId | undefined;

          for (const input of node.inputs) {
            requiredLoop = this.#deeperLoop(requiredLoop, this.#requiredLoops[input]);
          }
          this.#requiredLoops[value] = requiredLoop;
          break;
        }
        case "const":
        case "unreachable":
        case "parameter":
          break;
      }
    }
  }

  #hasAliasingWrite(start: SiteId, end: SiteId, reads: readonly StorageAccess[]): boolean {
    let low = 0;
    let high = this.#writeSites.length;

    while (low < high) {
      const middle = (low + high) >>> 1;
      const write = this.#writeSites[middle];

      assert(write !== undefined, "missing write site");
      if (write.site < start) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    for (let index = low; index < this.#writeSites.length; index += 1) {
      const write = this.#writeSites[index];

      assert(write !== undefined, "missing write site");
      if (write.site >= end) {
        break;
      }
      if (write.writes.some((effect) => reads.some((read) => mayAlias(read, effect)))) {
        return true;
      }
    }
    return false;
  }

  #define(value: WasmValueId, definition: ValueDefinition): void {
    this.body.values.node(value);
    assert(this.#definitions[value] === undefined, `Wasm value ${value} has two definitions`);
    this.#definitions[value] = definition;
  }

  #addEnclosingLoop(
    enclosingLoops: Map<BlockId, BlockId | undefined>,
    block: BlockId,
    loop: BlockId | undefined
  ): void {
    assert(!enclosingLoops.has(block), `Wasm body block ${block} has two placement scopes`);
    enclosingLoops.set(block, loop);
  }

  #deeperLoop(a: BlockId | undefined, b: BlockId | undefined): BlockId | undefined {
    if (a === undefined) {
      return b;
    }
    if (b === undefined || a === b) {
      return a;
    }
    if (this.index.path(a, b) !== undefined) {
      return b;
    }
    if (this.index.path(b, a) !== undefined) {
      return a;
    }
    assert(false, `Wasm value combines unrelated loops ${a} and ${b}`);
  }

  #firstSite(block: BlockId): SiteId {
    const site = this.#firstSites[block];

    assert(site !== undefined, `Wasm body block ${block} has no first site`);
    return site;
  }
}
