import { assert } from "#common/assert.js";
import type {
  BodyAnalysis,
  BodySite,
  SiteId
} from "#compiler/analysis/model.js";
import {
  emitOperation as emitCompilerOperation,
  type Operation
} from "#compiler/ir/operations/index.js";
import type { CellRef } from "#compiler/refs/cell.js";
import type {
  OperationEmitTarget,
  OperationValueEmitter
} from "#compiler/ir/operations/definition.js";
import type { ValueEmitContext } from "#compiler/ir/values/definition.js";
import type { ValueId, ValueType } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { PlacementIndex } from "#compiler/placement/index.js";
import type { PlacementPlan } from "#compiler/placement/model.js";
import type { ExternalValueId } from "#ir/operands.js";
import type { CallAction, ReturnCallAction } from "#ir/actions.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { wasmValueType, type WasmValueType } from "#compiler/encoder/types.js";

export type ValueEmitterContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  values: ValueTable;
  analysis: BodyAnalysis;
  plan: PlacementPlan;
  index: PlacementIndex;
  // Physical plan local -> the scratch local reserved for this fragment.
  locals: readonly number[];
  // External id -> the Wasm local supplied by the embedding.
  externalLocals: ReadonlyMap<ExternalValueId, number>;
  functionIndex(target: FunctionDefinition): number;
  resourceIndex(resource: ResourceRef): number;
}>;

// Executes a placement plan mechanically. Mutable state records only which
// planned sources have already been emitted and the current structural site.
export class ValueEmitter implements OperationValueEmitter {
  readonly #context: ValueEmitterContext;
  readonly #body: WasmFunctionBodyEncoder;
  readonly #values: ValueTable;
  readonly #analysis: BodyAnalysis;
  readonly #plan: PlacementPlan;
  readonly #realized: Uint8Array;
  readonly #sites: SiteId[] = [];
  readonly #operationTarget: OperationEmitTarget;
  readonly #valueContext: ValueEmitContext;

  constructor(context: ValueEmitterContext) {
    assert(
      context.locals.length === context.plan.localTypes.length,
      "placement local table does not match its plan"
    );
    assert(
      context.index.captures.length === context.analysis.sites().length,
      "placement capture index does not match its sites"
    );
    this.#context = context;
    this.#body = context.body;
    this.#values = context.values;
    this.#analysis = context.analysis;
    this.#plan = context.plan;
    this.#realized = new Uint8Array(context.values.size());

    this.#operationTarget = {
      body: context.body,
      withTemporaryLocal: (type, callback) => {
        context.scratch.withLocals([wasmTypeForValue(type)], ([local]) => callback(local));
      },
      cellLocal: (cell) => this.#cellLocal(cell),
      resourceIndex: (resource) => context.resourceIndex(resource)
    };
    this.#valueContext = {
      body: context.body,
      emitUse: (id) => this.emitUse(id),
      emitActionOutput: (id) => this.#emitSource(id),
      emitExternal: (external) => {
        const local = context.externalLocals.get(external);

        assert(local !== undefined, `no local bound for external value ${external}`);
        context.body.localGet(local);
      },
      emitParameter: (index) => context.body.localGet(index),
      emitLoopInput: (id) => context.body.localGet(this.valueLocal(id))
    };
  }

  withSite(site: SiteId, emit: () => void): void {
    const record = this.#analysis.sites()[site];

    assert(record !== undefined && record.id === site, `unknown placement site ${site}`);
    this.#sites.push(site);
    try {
      if (!isStructuredHeader(record)) {
        this.#emitCapturesAt(site);
      }
      emit();
    } finally {
      assert(this.#sites.pop() === site, "placement site stack changed");
    }
  }

  emitOperation(operation: Operation): void {
    emitCompilerOperation(this.#operationTarget, this, operation);
  }

  emitCall(action: CallAction): void {
    for (const argument of action.arguments) {
      this.emitUse(argument.value);
    }
    this.#body.callFunction(this.#context.functionIndex(action.target));
  }

  emitReturnCall(action: ReturnCallAction): void {
    for (const argument of action.arguments) {
      this.emitUse(argument.value);
    }
    this.#body.returnCallFunction(this.#context.functionIndex(action.target));
  }

  constValue(value: ValueId): number | undefined {
    return this.#values.constValue(value);
  }

  // Structured actions call this after all header operands and before control
  // selects or enters a nested body.
  emitCaptures(): void {
    const site = this.#currentSite();
    const record = this.#analysis.sites()[site];

    assert(record !== undefined && isStructuredHeader(record), `site ${site} is not structured`);
    this.#emitCapturesAt(site);
  }

  emitUse(value: ValueId): void {
    const mode = this.#values.captureMode(value);

    if (mode === "reemit") {
      this.#values.emit(value, this.#valueContext);
      return;
    }

    const placement = this.#plan.values[value];

    assert(placement !== undefined, `value ${value} has no placement`);
    if (this.#realized[value] !== 0) {
      this.#body.localGet(this.valueLocal(value));
      return;
    }

    assert(placement.kind === "atUse", `value ${value} used before its ${placement.kind} deadline`);
    assert(
      placement.anchor === this.#currentSite(),
      `value ${value} realized outside its anchor`
    );
    this.#emitSource(value);

    if (placement.local !== undefined) {
      this.#body.localTee(this.#local(placement.local));
    }
    this.#realized[value] = 1;
  }

  markControlOutput(value: ValueId): void {
    const placement = this.#plan.values[value];

    assert(
      placement?.kind === "control" &&
        this.#analysis.controlProducer(value) !== undefined,
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
    return this.#local(local);
  }

  #local(local: number): number {
    assert(Number.isInteger(local) && local >= 0, `invalid placement local ${local}`);
    const wasmLocal = this.#context.locals[local];

    assert(wasmLocal !== undefined, `placement local ${local} is not allocated`);
    return wasmLocal;
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
    for (const value of this.#context.index.captures[site] ?? []) {
      this.#capture(value, site);
    }
  }

  #capture(value: ValueId, deadline: SiteId): void {
    const placement = this.#plan.values[value];
    const site = this.#currentSite();

    assert(
      site === deadline &&
        placement?.kind === "capture" &&
        placement.anchor === deadline,
      `value ${value} has the wrong capture deadline`
    );
    assert(this.#realized[value] === 0, `value ${value} was realized twice`);
    this.#emitSource(value);
    this.#body.localSet(this.valueLocal(value));
    this.#realized[value] = 1;
  }

  #emitSource(value: ValueId): void {
    switch (this.#values.captureMode(value)) {
      case "producer": {
        const producer = this.#analysis.producer(value);

        assert(producer !== undefined, `action output ${value} has no producer`);
        switch (producer.action.kind) {
          case "op":
            this.emitOperation(producer.action.op);
            return;
          case "call":
            this.emitCall(producer.action);
            return;
        }
      }
      case "compute":
        this.#values.emit(value, this.#valueContext);
        return;
      case "reemit":
        assert(false, `value ${value} cannot have a planned source`);
    }
  }

  #currentSite(): SiteId {
    const site = this.#sites[this.#sites.length - 1];

    assert(site !== undefined, "value realization occurred outside a placement site");
    return site;
  }

  #cellLocal(cell: CellRef): number {
    const local = this.#plan.cellLocals.get(cell);

    assert(local !== undefined, "cell has no planned local");
    return this.#local(local);
  }
}

export function wasmTypeForValue(type: ValueType): WasmValueType {
  return type === "i32" ? wasmValueType.i32 : wasmValueType.i64;
}

function isStructuredHeader(site: BodySite): boolean {
  return site.kind === "action" &&
    (site.action.kind === "if" ||
      site.action.kind === "switch" ||
      site.action.kind === "loop");
}
