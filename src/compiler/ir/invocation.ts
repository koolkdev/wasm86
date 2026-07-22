import { assert } from "#common/assert.js";
import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ValueInput } from "#compiler/ir/values/types.js";
import type { ModuleBindings } from "#compiler/program/bindings.js";
import type { FunctionType } from "#compiler/program/function-type.js";
import type { FunctionRef, TableRef } from "#compiler/program/refs.js";
import type { ValueUseEmitter } from "#ir/node.js";

export type InvocationEmitTarget = Readonly<{
  body: WasmFunctionBodyEncoder;
  bindings: ModuleBindings;
}>;

export type DirectFunctionTarget = CallTarget & Readonly<{
  ref: FunctionRef;
  isAvailableTo(owner: object): boolean;
}>;

export type CallTargetReferences = Readonly<{
  functions: readonly DirectFunctionTarget[];
  types: readonly FunctionType[];
  tables: readonly TableRef[];
}>;

export interface CallTarget {
  readonly type: FunctionType;
  readonly effects: StorageEffects;
  readonly targetInputs: readonly ValueInput[];
  readonly references: CallTargetReferences;
  emitCall(context: InvocationEmitTarget): void;
  emitReturnCall(context: InvocationEmitTarget): void;
}

export type IndirectCallTargetArgs = Readonly<{
  table: TableRef;
  type: FunctionType;
  effects: StorageEffects;
  elementIndex: ValueInput;
}>;

export class IndirectCallTarget implements CallTarget {
  private constructor(
    readonly table: TableRef,
    readonly type: FunctionType,
    readonly effects: StorageEffects,
    readonly elementIndex: ValueInput
  ) {
    assert(
      elementIndex.type === "i32",
      `indirect call table element index must be i32, got ${elementIndex.type}`
    );
  }

  static create({
    table,
    type,
    effects,
    elementIndex
  }: IndirectCallTargetArgs): IndirectCallTarget {
    return new IndirectCallTarget(table, type, effects, elementIndex);
  }

  get targetInputs(): readonly [ValueInput] {
    return [this.elementIndex];
  }

  get references(): CallTargetReferences {
    return { functions: [], types: [this.type], tables: [this.table] };
  }

  emitCall(context: InvocationEmitTarget): void {
    context.body.callIndirect(
      context.bindings.typeIndex(this.type),
      context.bindings.tableIndex(this.table)
    );
  }

  emitReturnCall(context: InvocationEmitTarget): void {
    context.body.returnCallIndirect(
      context.bindings.typeIndex(this.type),
      context.bindings.tableIndex(this.table)
    );
  }
}

export type InvocationArgs = Readonly<{
  target: CallTarget;
  arguments: readonly ValueInput[];
}>;

// A call's target and typed inputs, independent of how its results are consumed.
export class Invocation {
  readonly arguments: readonly ValueInput[];
  readonly inputs: readonly ValueInput[];

  private constructor(
    readonly target: CallTarget,
    sourceArguments: readonly ValueInput[]
  ) {
    this.arguments = [...sourceArguments];
    assert(
      this.arguments.length === target.type.parameters.length,
      `call target expects ${target.type.parameters.length} arguments, got ${this.arguments.length}`
    );
    for (const [index, input] of this.arguments.entries()) {
      const expected = target.type.parameters[index];

      assert(expected !== undefined, `call target has no parameter ${index}`);
      assert(
        input.type === expected,
        `call target argument ${index} must be ${expected}, got ${input.type}`
      );
    }

    this.inputs = [...this.arguments, ...target.targetInputs];
  }

  static create({ target, arguments: inputs }: InvocationArgs): Invocation {
    return new Invocation(target, inputs);
  }

  emitInputs(values: ValueUseEmitter): void {
    for (const input of this.inputs) {
      values.emitUse(input.value);
    }
  }
}
