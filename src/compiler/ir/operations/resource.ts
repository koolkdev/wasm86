import { assert } from "#common/assert.js";
import { type ResourceByteOperand, type ResourceReadMode } from "#compiler/ir/resource.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  type OperationDefinition,
  type OperationNodeBase,
  type OperationProduction,
  type OperationResult
} from "./definition.js";

type ResourceReadCreateArgs = Readonly<{
  source: ResourceByteOperand;
  mode?: ResourceReadMode;
}>;

export type ResourceReadOperation = OperationNodeBase &
  Readonly<{
    kind: "resource.read";
    source: ResourceByteOperand;
    mode?: ResourceReadMode;
    output: ValueId;
  }>;

export const resourceRead: OperationDefinition<
  ResourceReadCreateArgs,
  ResourceReadOperation,
  readonly [OperationProduction]
> = {
  kind: "resource.read",
  create: ({ source, mode }, allocateOutput) => {
    assert(
      mode === undefined || mode.kind === "signed" || mode.kind === "unsigned",
      "unknown resource read mode"
    );
    assert(
      mode?.kind !== "signed" || source.width !== 32,
      "a 32-bit resource read has no signed extension"
    );
    const result = readResult(source.width, mode);
    const node = {
      category: "operation" as const,
      kind: "resource.read" as const,
      source,
      output: allocateOutput(result)
    };

    return mode === undefined ? node : { ...node, mode };
  },
  describe: (operation) => {
    const { source } = operation;
    const result = readResult(source.width, operation.mode);

    return {
      inputs: [{ value: source.address.base, type: "i32" }],
      productions: [{ result, output: operation.output }],
      effects: { reads: [source.effect], writes: [] },
      referencedResources: [source.effect.resource]
    };
  }
};

export type ResourceWriteArgs = Readonly<{
  destination: ResourceByteOperand;
  value: ValueId;
}>;

export type ResourceWriteOperation = OperationNodeBase &
  Readonly<{
    kind: "resource.write";
    destination: ResourceByteOperand;
    value: ValueId;
  }>;

export const resourceWrite: OperationDefinition<
  ResourceWriteArgs,
  ResourceWriteOperation,
  readonly []
> = {
  kind: "resource.write",
  create: ({ destination, value }) => ({
    category: "operation",
    kind: "resource.write",
    destination,
    value
  }),
  describe: (operation) => ({
    inputs: [
      { value: operation.destination.address.base, type: "i32" },
      { value: operation.value, type: "i32" }
    ],
    productions: [],
    effects: { reads: [], writes: [operation.destination.effect] },
    referencedResources: [operation.destination.effect.resource]
  })
};

export type ResourceOperation = ResourceReadOperation | ResourceWriteOperation;

const i32Result: OperationResult = { type: "i32" };

function readResult(
  width: ResourceByteOperand["width"],
  mode: ResourceReadMode | undefined
): OperationResult {
  if (mode?.kind === "unsigned" && mode.bounds !== undefined) {
    return { type: "i32", bounds: mode.bounds };
  }
  if (width === 32) {
    return i32Result;
  }
  return {
    type: "i32",
    bounds: mode?.kind === "signed" ? signExtended(width) : fitsUnsigned(width)
  };
}
