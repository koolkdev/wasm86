import type { InvocationEmitTarget } from "#compiler/ir/invocation.js";
import {
  noStorageEffects,
  type StorageEffects
} from "#compiler/ir/effects.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Body } from "#ir/block.js";
import type {
  BodyCompletionContext,
  BodyNodeBase,
  NestedBody,
  ValueUseEmitter
} from "#ir/node.js";

export type ControlEmitTarget = BodyCompletionContext & InvocationEmitTarget &
  Readonly<{
    emitCaptures: () => void;
    emitBody: (body: Body, resultLocal?: number) => void;
    controlOutputLocal: (output: ValueId) => number | undefined;
    markControlOutput: (output: ValueId) => void;
    valueLocal: (value: ValueId) => number;
    withNestedControl: (emit: () => void, labels?: number) => void;
    withLoopBody: (locals: readonly number[], emit: () => void) => void;
    currentLoopLocals: () => readonly number[];
    emitLoopBranch: () => void;
    emitExit: (result: ValueId) => void;
    emitDispatch: (targetEip: ValueId) => void;
    sealCompletedStructuredControl: () => void;
  }>;

// A control is one final node: shared body facts plus its category-specific
// realization capability. Concrete control types add their semantic fields.
export abstract class ControlBase implements BodyNodeBase {
  readonly category = "control";
  readonly directEffects: StorageEffects = noStorageEffects;

  abstract readonly kind: string;
  abstract readonly operands: readonly ValueId[];
  abstract readonly outputs: readonly ValueId[];
  abstract readonly nestedBodies: readonly NestedBody[];
  abstract completes(context: BodyCompletionContext): boolean;
  abstract mapBodies(map: (body: Body) => Body): ControlBase;
  abstract emit(
    target: ControlEmitTarget,
    values: ValueUseEmitter
  ): void;
}

export abstract class TerminalControlBase extends ControlBase {
  readonly outputs: readonly [] = [];
  readonly nestedBodies: readonly [] = [];

  completes(_context: BodyCompletionContext): true {
    return true;
  }

  mapBodies(_map: (body: Body) => Body): this {
    return this;
  }
}
