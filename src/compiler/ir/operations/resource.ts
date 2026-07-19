import { assert } from "#common/assert.js";
import type { WasmMemoryImmediate } from "#compiler/encoder/memory.js";
import {
  type ResourceByteOperand,
  type ResourceEffect,
  type ResourceReadMode
} from "#compiler/ir/resource.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { IntegerWidth, WidthBounds } from "#compiler/ir/values/types.js";
import type {
  OperationDefinition,
  OperationNode,
  OperationResult
} from "./definition.js";

type ResourceReadData = Readonly<{
  effect: ResourceEffect;
  displacement: number;
  width: IntegerWidth;
  signed?: true;
}>;

type ResourceReadCreateArgs = Readonly<{
  source: ResourceByteOperand;
  mode?: ResourceReadMode;
}>;

type ResourceReadOperation = OperationNode<
  "resource.read",
  ResourceReadData,
  OperationResult
>;

export const resourceRead: OperationDefinition<
  ResourceReadCreateArgs,
  ResourceReadOperation
> = {
  kind: "resource.read",

  create(op) {
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

    return {
      kind: "resource.read",
      effect: op.source.effect,
      displacement: op.source.address.displacement,
      width: op.source.width,
      ...(signed ? { signed: true } : {}),
      inputs: [{ value: op.source.address.base, type: "i32" }],
      result: readResult(
        op.source.width,
        signed,
        bounds
      ),
      effects: {
        reads: [op.source.effect],
        writes: []
      }
    };
  },

  emit(operation, target, inputs) {
    inputs.use(0);
    const immediate = resourceImmediate(
      target.resourceIndex(operation.effect.resource),
      operation.width,
      operation.displacement
    );

    switch (operation.width) {
      case 8:
        operation.signed === true
          ? target.body.i32Load8S(immediate)
          : target.body.i32Load8U(immediate);
        return;
      case 16:
        operation.signed === true
          ? target.body.i32Load16S(immediate)
          : target.body.i32Load16U(immediate);
        return;
      case 32:
        target.body.i32Load(immediate);
        return;
    }
  }
};

type ResourceWriteData = Readonly<{
  effect: ResourceEffect;
  displacement: number;
  width: IntegerWidth;
}>;

type ResourceWriteCreateArgs = Readonly<{
  destination: ResourceByteOperand;
  value: ValueId;
}>;

type ResourceWriteOperation = OperationNode<
  "resource.write",
  ResourceWriteData,
  undefined
>;

export const resourceWrite: OperationDefinition<
  ResourceWriteCreateArgs,
  ResourceWriteOperation
> = {
  kind: "resource.write",

  create(op) {
    return {
      kind: "resource.write",
      effect: op.destination.effect,
      displacement: op.destination.address.displacement,
      width: op.destination.width,
      inputs: [
        { value: op.destination.address.base, type: "i32" },
        { value: op.value, type: "i32" }
      ],
      result: undefined,
      effects: {
        reads: [],
        writes: [op.destination.effect]
      }
    };
  },

  emit(operation, target, inputs) {
    inputs.use(0);
    inputs.use(1);
    const immediate = resourceImmediate(
      target.resourceIndex(operation.effect.resource),
      operation.width,
      operation.displacement
    );

    switch (operation.width) {
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
};

export type ResourceOperation =
  | ReturnType<typeof resourceRead.create>
  | ReturnType<typeof resourceWrite.create>;

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
