import { assert } from "#common/assert.js";
import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type {
  ValueId,
  ValueInput,
  ValueType,
  WidthBounds
} from "#compiler/ir/values/types.js";
import type { CellRef } from "#compiler/refs/cell.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";
import type {
  BodyCompletionContext,
  BodyNodeBase,
  ValueUseEmitter
} from "#ir/node.js";
import type { Body } from "#ir/block.js";

// i64 results structurally carry no i32 width bounds.
export type OperationResult =
  | Readonly<{ type: "i32"; bounds?: WidthBounds }>
  | Readonly<{ type: "i64" }>;

export function operationResult(type: ValueType): OperationResult {
  switch (type) {
    case "i32":
      return { type: "i32" };
    case "i64":
      return { type: "i64" };
  }
}

// Lowering-only services available to every operation occurrence. An
// occurrence's direct `emit` function uses only the capabilities it needs.
export type OperationEmitTarget = Readonly<{
  body: WasmFunctionBodyEncoder;
  cellLocal: (cell: CellRef) => number;
  resourceIndex: (resource: ResourceRef) => number;
  functionIndex: (target: FunctionDefinition) => number;
}>;

export type OperationOutputAllocator = (result: OperationResult) => ValueId;

type OperationFacts = Readonly<{
  inputs: readonly ValueInput[];
  results: readonly OperationResult[];
  outputs: readonly ValueId[];
  directEffects: StorageEffects;
  referencedResources?: readonly ResourceRef[];
}>;

// Operations have no hidden trap or mandatory-execution fact. Output demand
// retains result-producing work; declared writes retain observable work.
// Volatile reads or architectural traps require an effects/liveness model
// extension before they can become operation kinds.
export abstract class OperationBase implements BodyNodeBase {
  readonly category = "operation";
  // Repeated values are repeated semantic uses and remain repeated entries.
  readonly inputs: readonly ValueInput[];
  readonly results: readonly OperationResult[];
  readonly operands: readonly ValueId[];
  readonly outputs: readonly ValueId[];
  readonly nestedBodies: readonly [] = [];
  readonly directEffects: StorageEffects;
  readonly referencedResources: readonly ResourceRef[];

  protected constructor({
    inputs,
    results,
    outputs,
    directEffects,
    referencedResources = []
  }: OperationFacts) {
    assert(
      outputs.length === results.length,
      "operation outputs do not align with its results"
    );
    this.inputs = inputs;
    this.results = results;
    this.operands = inputs.map((input) => input.value);
    this.outputs = outputs;
    this.directEffects = directEffects;
    this.referencedResources = referencedResources;
  }

  completes(_context: BodyCompletionContext): false {
    return false;
  }

  mapBodies(_map: (body: Body) => Body): this {
    return this;
  }

  abstract readonly kind: string;
  abstract emit(
    target: OperationEmitTarget,
    values: ValueUseEmitter
  ): void;
}

// Construction is the only separate factory concern. Every returned
// occurrence already carries all of its facts and methods directly.
export type OperationFactory<
  CreateArgs,
  Entry extends OperationBase
> = Readonly<{
  kind: Entry["kind"];
  create: (
    args: CreateArgs,
    allocateOutput: OperationOutputAllocator
  ) => Entry;
}>;
