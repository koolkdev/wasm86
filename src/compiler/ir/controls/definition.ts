import type { InvocationEmitTarget } from "#compiler/ir/invocation.js";
import {
  noStorageEffects,
  type StorageEffects
} from "#compiler/ir/effects.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Region } from "#compiler/ir/region.js";
import type {
  RegionCompletionContext,
  RegionNodeBase,
  NestedRegion,
  ValueUseEmitter
} from "#compiler/ir/node.js";

export type BranchHint = "unlikely" | "likely";

export type ControlEmitTarget = RegionCompletionContext & InvocationEmitTarget &
  Readonly<{
    emitCaptures: () => void;
    emitBody: (body: Region, resultLocal?: number) => void;
    controlOutputLocal: (output: ValueId) => number | undefined;
    markControlOutput: (output: ValueId) => void;
    valueLocal: (value: ValueId) => number;
    withNestedControl: (emit: () => void, labels?: number) => void;
    withLoopBody: (locals: readonly number[], emit: () => void) => void;
    currentLoopLocals: () => readonly number[];
    emitLoopBranch: () => void;
    sealCompletedStructuredControl: () => void;
  }>;

// A control is one final node: shared body facts plus its category-specific
// realization capability. Concrete control types add their semantic fields.
export abstract class ControlBase implements RegionNodeBase {
  readonly category = "control";
  readonly directEffects: StorageEffects = noStorageEffects;

  abstract readonly kind: string;
  abstract readonly operands: readonly ValueId[];
  abstract readonly outputs: readonly ValueId[];
  abstract readonly nestedBodies: readonly NestedRegion[];
  abstract completes(context: RegionCompletionContext): boolean;
  abstract mapBodies(map: (body: Region) => Region): ControlBase;
  abstract emit(
    target: ControlEmitTarget,
    values: ValueUseEmitter
  ): void;
}

export abstract class TerminalControlBase extends ControlBase {
  readonly outputs: readonly [] = [];
  readonly nestedBodies: readonly [] = [];

  completes(_context: RegionCompletionContext): true {
    return true;
  }

  mapBodies(_map: (body: Region) => Region): this {
    return this;
  }
}
