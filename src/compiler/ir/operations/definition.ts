import { assert } from "#common/assert.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type {
  ValueId,
  ValueInput,
  ValueType,
  WidthBounds
} from "#compiler/ir/values/types.js";
import type {
  RegionCompletionContext,
  RegionNodeBase
} from "#compiler/ir/node.js";
import type { Region } from "#compiler/ir/region.js";

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
export abstract class OperationBase implements RegionNodeBase {
  readonly category = "operation";
  // Inputs are typed dependencies in eager evaluation order. Repeated values
  // are repeated semantic uses and remain repeated entries.
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

  completes(_context: RegionCompletionContext): false {
    return false;
  }

  mapBodies(_map: (body: Region) => Region): this {
    return this;
  }

  abstract readonly kind: string;
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
