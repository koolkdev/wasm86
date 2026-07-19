import { assert } from "#common/assert.js";
import type { WasmMemoryImmediate } from "#compiler/encoder/memory.js";
import {
  type ResourceByteOperand,
  type ResourceEffect,
  type ResourceReadMode
} from "#compiler/ir/resource.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import type {
  IntegerWidth,
  ValueId,
  ValueInput,
  WidthBounds
} from "#compiler/ir/values/types.js";
import type { ValueUseEmitter } from "#ir/node.js";
import {
  OperationBase,
  type OperationEmitTarget,
  type OperationFactory,
  type OperationOutputAllocator,
  type OperationResult
} from "./definition.js";

type ResourceReadCreateArgs = Readonly<{
  source: ResourceByteOperand;
  mode?: ResourceReadMode;
}>;

export class ResourceReadOperation extends OperationBase {
  static readonly kind = "resource.read";
  readonly kind = ResourceReadOperation.kind;
  readonly effect: ResourceEffect;
  readonly displacement: number;
  readonly width: IntegerWidth;
  readonly signed?: true;
  declare readonly inputs: readonly [ValueInput];
  declare readonly results: readonly [OperationResult];

  private constructor(
    op: ResourceReadCreateArgs,
    allocateOutput: OperationOutputAllocator
  ) {
    const mode = op.mode;

    assert(
      mode === undefined || mode.kind === "signed" || mode.kind === "unsigned",
      "unknown resource read mode"
    );
    assert(
      mode?.kind !== "signed" || op.source.width !== 32,
      "a 32-bit resource read has no signed extension"
    );
    const signed = mode?.kind === "signed";
    const bounds = mode?.kind === "unsigned" ? mode.bounds : undefined;
    const effect = op.source.effect;
    const displacement = op.source.address.displacement;
    const width = op.source.width;
    const inputs: readonly [ValueInput] = [
      { value: op.source.address.base, type: "i32" }
    ];
    const result = readResult(width, signed, bounds);
    const results: readonly [OperationResult] = [result];
    const outputs: readonly [ValueId] = [allocateOutput(result)];

    super({
      inputs,
      results,
      outputs,
      directEffects: { reads: [effect], writes: [] },
      referencedResources: [effect.resource]
    });
    this.effect = effect;
    this.displacement = displacement;
    this.width = width;
    if (signed) {
      this.signed = true;
    }
  }

  static create(
    op: ResourceReadCreateArgs,
    allocateOutput: OperationOutputAllocator
  ): ResourceReadOperation {
    return new ResourceReadOperation(op, allocateOutput);
  }

  emit(target: OperationEmitTarget, values: ValueUseEmitter): void {
    values.emitUse(this.inputs[0].value);
    const immediate = resourceImmediate(
      target.bindings.resourceIndex(this.effect.resource),
      this.width,
      this.displacement
    );

    switch (this.width) {
      case 8:
        this.signed
          ? target.body.i32Load8S(immediate)
          : target.body.i32Load8U(immediate);
        return;
      case 16:
        this.signed
          ? target.body.i32Load16S(immediate)
          : target.body.i32Load16U(immediate);
        return;
      case 32:
        target.body.i32Load(immediate);
        return;
    }
  }
}

export const resourceRead = ResourceReadOperation satisfies OperationFactory<
  ResourceReadCreateArgs,
  ResourceReadOperation
>;

export type ResourceWriteArgs = Readonly<{
  destination: ResourceByteOperand;
  value: ValueId;
}>;

export class ResourceWriteOperation extends OperationBase {
  static readonly kind = "resource.write";
  readonly kind = ResourceWriteOperation.kind;
  readonly effect: ResourceEffect;
  readonly displacement: number;
  readonly width: IntegerWidth;
  declare readonly inputs: readonly [ValueInput, ValueInput];
  declare readonly results: readonly [];

  private constructor(op: ResourceWriteArgs) {
    const effect = op.destination.effect;
    const displacement = op.destination.address.displacement;
    const width = op.destination.width;
    const inputs: readonly [ValueInput, ValueInput] = [
      { value: op.destination.address.base, type: "i32" },
      { value: op.value, type: "i32" }
    ];

    super({
      inputs,
      results: [],
      outputs: [],
      directEffects: { reads: [], writes: [effect] },
      referencedResources: [effect.resource]
    });
    this.effect = effect;
    this.displacement = displacement;
    this.width = width;
  }

  static create(op: ResourceWriteArgs): ResourceWriteOperation {
    return new ResourceWriteOperation(op);
  }

  emit(target: OperationEmitTarget, values: ValueUseEmitter): void {
    values.emitUse(this.inputs[0].value);
    values.emitUse(this.inputs[1].value);
    const immediate = resourceImmediate(
      target.bindings.resourceIndex(this.effect.resource),
      this.width,
      this.displacement
    );

    switch (this.width) {
      case 8:
        target.body.i32Store8(immediate);
        return;
      case 16:
        target.body.i32Store16(immediate);
        return;
      case 32:
        target.body.i32Store(immediate);
        return;
    }
  }
}

export const resourceWrite = ResourceWriteOperation satisfies OperationFactory<
  ResourceWriteArgs,
  ResourceWriteOperation
>;

export type ResourceOperation =
  | ResourceReadOperation
  | ResourceWriteOperation;

const i32Result: OperationResult = { type: "i32" };

function readResult(
  width: IntegerWidth,
  signed: boolean,
  refinement: WidthBounds | undefined
): OperationResult {
  if (refinement !== undefined) {
    return { type: "i32", bounds: refinement };
  }
  if (width === 32) {
    return i32Result;
  }
  return { type: "i32", bounds: signed ? signExtended(width) : fitsUnsigned(width) };
}

function resourceImmediate(
  memoryIndex: number,
  width: IntegerWidth,
  displacement: number
): WasmMemoryImmediate {
  return {
    align: naturalAlignment[width],
    offset: displacement,
    memoryIndex
  };
}

const naturalAlignment: Readonly<Record<IntegerWidth, number>> = {
  8: 0,
  16: 1,
  32: 2
};
