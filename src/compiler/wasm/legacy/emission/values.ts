import { assert } from "#common/assert.js";
import type { FunctionAnalysis, RegionSite, SiteId } from "#compiler/wasm/legacy/analysis/model.js";
import { describeNode } from "#compiler/ir/node.js";
import type { VariableRef } from "#compiler/ir/variable.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId, ValueType } from "#compiler/ir/values/types.js";
import type { PlacementIndex } from "#compiler/wasm/legacy/placement/index.js";
import type { PlacementPlan } from "#compiler/wasm/legacy/placement/model.js";
import type { ModuleBindings } from "#compiler/wasm/module/bindings.js";
import type { WasmLocalResolver } from "#compiler/wasm/encoder/function-body.js";
import { wasmInstruction } from "#compiler/wasm/encoder/instructions.js";
import type { WasmInstructionWriter } from "#compiler/wasm/encoder/instruction-writer.js";
import { wasmValueType, type WasmValueType } from "#compiler/wasm/encoder/types.js";
import { emitOperation } from "./operations.js";
import { emitValueNode } from "./value-instructions.js";

// Executes a placement plan and lowers demanded value recipes. Mutable state
// records only which planned sources have already been emitted and the current
// structural site.
export class ValueEmitter {
  readonly #body: WasmInstructionWriter;
  readonly #bindings: ModuleBindings;
  readonly #values: ValueTable;
  readonly #analysis: FunctionAnalysis;
  readonly #plan: PlacementPlan;
  readonly #captures: PlacementIndex["captures"];
  readonly #resolveLocal: WasmLocalResolver;
  readonly #realized: Uint8Array;
  readonly #sites: SiteId[] = [];

  constructor(
    context: Readonly<{
      body: WasmInstructionWriter;
      values: ValueTable;
      analysis: FunctionAnalysis;
      plan: PlacementPlan;
      index: PlacementIndex;
      resolveLocal: WasmLocalResolver;
      bindings: ModuleBindings;
    }>
  ) {
    assert(
      context.index.captures.length === context.analysis.sites().length,
      "placement capture index does not match its sites"
    );
    this.#body = context.body;
    this.#bindings = context.bindings;
    this.#values = context.values;
    this.#analysis = context.analysis;
    this.#plan = context.plan;
    this.#captures = context.index.captures;
    this.#resolveLocal = context.resolveLocal;
    this.#realized = new Uint8Array(context.values.size());
  }

  withSite(site: SiteId, emit: () => void): void {
    const record = this.#analysis.sites()[site];

    assert(record !== undefined && record.id === site, `unknown placement site ${site}`);
    this.#sites.push(site);
    try {
      if (!capturesAfterOperands(record)) {
        this.#emitCapturesAt(site);
      }
      emit();
    } finally {
      assert(this.#sites.pop() === site, "placement site stack changed");
    }
  }

  constValue(value: ValueId): number | undefined {
    return this.#values.constValue(value);
  }

  // Nodes with child bodies call this after their header operands and before
  // selecting or entering a child.
  emitCaptures(): void {
    const site = this.#currentSite();
    const record = this.#analysis.sites()[site];

    assert(
      record !== undefined && capturesAfterOperands(record),
      `site ${site} has no nested bodies`
    );
    this.#emitCapturesAt(site);
  }

  emitUse(value: ValueId): void {
    const mode = this.#values.captureMode(value);

    if (mode === "reemit") {
      this.#emitValue(value);
      return;
    }

    const placement = this.#plan.values[value];

    assert(placement !== undefined, `value ${value} has no placement`);
    if (this.#realized[value] !== 0) {
      this.#body.write(wasmInstruction.local.get, this.valueLocal(value));
      return;
    }

    assert(placement.kind === "atUse", `value ${value} used before its ${placement.kind} deadline`);
    assert(placement.anchor === this.#currentSite(), `value ${value} realized outside its anchor`);
    this.#emitSource(value);

    if (placement.local !== undefined) {
      this.#body.write(wasmInstruction.local.tee, this.#resolveLocal(placement.local));
    }
    this.#realized[value] = 1;
  }

  markControlOutput(value: ValueId): void {
    const placement = this.#plan.values[value];

    assert(
      placement?.kind === "control" && this.#analysis.controlProducer(value) !== undefined,
      `value ${value} is not a control output`
    );
    assert(
      placement.anchor === this.#currentSite(),
      `control output ${value} completed outside its anchor`
    );
    this.valueLocal(value);
    assert(this.#realized[value] === 0, `control output ${value} was realized twice`);
    this.#realized[value] = 1;
  }

  valueLocal(value: ValueId): number {
    const local = this.#plan.values[value]?.local;

    assert(local !== undefined, `value ${value} has no planned local`);
    return this.#resolveLocal(local);
  }

  variableLocal(variable: VariableRef): number {
    const local = this.#plan.variableLocals.get(variable);

    assert(local !== undefined, "variable has no planned local");
    return this.#resolveLocal(local);
  }

  assertComplete(): void {
    const missing: number[] = [];

    for (const [value, placement] of this.#plan.values.entries()) {
      if (
        placement !== undefined &&
        placement.kind !== "loopInput" &&
        this.#realized[value] === 0
      ) {
        missing.push(value);
      }
    }

    assert(missing.length === 0, `planned values never realized: ${missing.join(", ")}`);
    assert(this.#sites.length === 0, "placement site was not closed");
  }

  #emitCapturesAt(site: SiteId): void {
    for (const value of this.#captures[site] ?? []) {
      this.#capture(value, site);
    }
  }

  #capture(value: ValueId, deadline: SiteId): void {
    const placement = this.#plan.values[value];
    const site = this.#currentSite();

    assert(
      site === deadline && placement?.kind === "capture" && placement.anchor === deadline,
      `value ${value} has the wrong capture deadline`
    );
    assert(this.#realized[value] === 0, `value ${value} was realized twice`);
    this.#emitSource(value);
    this.#body.write(wasmInstruction.local.set, this.valueLocal(value));
    this.#realized[value] = 1;
  }

  #emitSource(value: ValueId): void {
    switch (this.#values.captureMode(value)) {
      case "producer": {
        const producer = this.#analysis.producer(value);

        assert(producer !== undefined, `node output ${value} has no producer`);
        emitOperation(this.#body, this.#bindings, this, producer.operation);
        return;
      }
      case "compute":
        this.#emitValue(value);
        return;
      case "reemit":
        assert(false, `value ${value} cannot have a planned source`);
    }
  }

  #emitValue(value: ValueId): void {
    for (const child of this.#values.children(value)) {
      this.emitUse(child);
    }

    const node = this.#values.node(value);

    if (node.kind === "nodeOutput") {
      assert(false, `node output ${value} must emit through its producer`);
      return;
    }
    if (node.kind === "loopInput") {
      this.#body.write(wasmInstruction.local.get, this.valueLocal(value));
      return;
    }
    emitValueNode(this.#body, node);
  }

  #currentSite(): SiteId {
    const site = this.#sites[this.#sites.length - 1];

    assert(site !== undefined, "value realization occurred outside a placement site");
    return site;
  }
}

export function wasmTypeForValue(type: ValueType): WasmValueType {
  return type === "i32" ? wasmValueType.i32 : wasmValueType.i64;
}

function capturesAfterOperands(site: RegionSite): boolean {
  return site.kind === "node" && describeNode(site.node).nestedBodies.length !== 0;
}
