import {
  callOperation,
  type CallOperation
} from "#compiler/ir/operations/index.js";
import { Invocation } from "#compiler/ir/invocation.js";
import type { BodyNode } from "#ir/block.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import {
  resourceRead as resourceReadOperation,
  resourceWrite as resourceWriteOperation
} from "#compiler/ir/operations/resource.js";
import { valueId } from "#compiler/ir/values/id.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  cpuStatusFlagResolvers,
  guestMemoryResource
} from "#test/support/execution-model.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import type { OperandWidth } from "#core/types.js";
import {
  DynamicByteOriginRef,
  resourceRef,
  type ResourceByteOperand,
  type ResourceReadMode,
  type ResourceEffect
} from "#compiler/ir/resource.js";
import { covers } from "#ir/aliasing.js";

type TestValueId = ValueId | number;
type OperationOf<Kind extends Operation["kind"]> = Extract<Operation, { kind: Kind }>;

export type MemoryReadOperation = OperationOf<"resource.read">;
export type MemoryWriteOperation = OperationOf<"resource.write">;
export type StatusFlagCallOperation = CallOperation & Readonly<{
  outputs: readonly [ValueId];
}>;

export const compilerTestResource = resourceRef("test.compiler-storage");

export function compilerTestValues(): ValueTable {
  const values = new ValueTable();

  // Static resource operations need their zero base to precede node outputs.
  values.const(0);
  return values;
}

export function compilerTestResourceEffect(
  region: number,
  byteLength = 4
): ResourceEffect {
  return {
    space: "resource",
    resource: compilerTestResource,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: region * 4, byteLength }
    }
  };
}

export function resourceReadNode(
  values: ValueTable,
  output: TestValueId,
  region: number,
  width: OperandWidth = 32,
  signed?: true
): MemoryReadOperation {
  const source = {
    effect: compilerTestResourceEffect(region, width / 8),
    address: { base: values.const(0), displacement: region * 4 },
    width
  };
  const outputId = valueId(output);

  return signed === true
    ? resourceReadOperation.create(
        { source, mode: { kind: "signed" } },
        () => outputId
      )
    : resourceReadOperation.create({ source }, () => outputId);
}

export function resourceWriteNode(
  values: ValueTable,
  region: number,
  value: TestValueId,
  width: OperandWidth = 32
): MemoryWriteOperation {
  return resourceWriteOperation.create(
    {
      destination: {
        effect: compilerTestResourceEffect(region, width / 8),
        address: { base: values.const(0), displacement: region * 4 },
        width
      },
      value: valueId(value)
    }
  );
}

export function operandRead(
  output: TestValueId,
  source: ResourceByteOperand,
  mode?: ResourceReadMode
): MemoryReadOperation {
  const outputId = valueId(output);

  return resourceReadOperation.create(
    mode === undefined ? { source } : { source, mode },
    () => outputId
  );
}

export function operandWrite(
  destination: ResourceByteOperand,
  value: TestValueId
): MemoryWriteOperation {
  return resourceWriteOperation.create(
    {
      destination,
      value: valueId(value)
    }
  );
}

export function memoryReadOperation(output: TestValueId, address: TestValueId, width: OperandWidth): MemoryReadOperation;
export function memoryReadOperation(output: TestValueId, address: TestValueId, width: OperandWidth, signed: true): MemoryReadOperation;
export function memoryReadOperation(
  output: TestValueId,
  address: TestValueId,
  width: OperandWidth,
  signed?: true
): MemoryReadOperation {
  const outputId = valueId(output);
  const addressId = valueId(address);
  const range = {
    basis: {
      kind: "dynamic" as const,
      origin: new DynamicByteOriginRef()
    },
    slice: { byteOffset: 0, byteLength: width / 8 }
  };
  return signed === true
    ? resourceReadOperation.create({
        source: {
          effect: { space: "resource", resource: guestMemoryResource, range },
          address: { base: addressId, displacement: 0 },
          width
        },
        mode: { kind: "signed" }
      }, () => outputId)
    : resourceReadOperation.create({
        source: {
          effect: { space: "resource", resource: guestMemoryResource, range },
          address: { base: addressId, displacement: 0 },
          width
        }
      }, () => outputId);
}

export function memoryWriteOperation(
  address: TestValueId,
  value: TestValueId,
  width: OperandWidth
): MemoryWriteOperation {
  const range = {
    basis: {
      kind: "dynamic" as const,
      origin: new DynamicByteOriginRef()
    },
    slice: { byteOffset: 0, byteLength: width / 8 }
  };

  return resourceWriteOperation.create(
    {
      destination: {
        effect: { space: "resource", resource: guestMemoryResource, range },
        address: { base: valueId(address), displacement: 0 },
        width
      },
      value: valueId(value),
    }
  );
}

export function statusFlagCallOperation(
  output: TestValueId,
  flag: X86StatusFlag
): StatusFlagCallOperation {
  return callOperation.create(
    {
      invocation: Invocation.create({
        target: cpuStatusFlagResolvers.get(flag),
        arguments: []
      })
    },
    () => valueId(output)
  ) as StatusFlagCallOperation;
}

export function isMemoryRead(node: BodyNode): node is MemoryReadOperation {
  return node.kind === "resource.read" &&
    node.effect.resource === guestMemoryResource &&
    node.outputs.length === 1;
}

export function isMemoryWrite(node: BodyNode): node is MemoryWriteOperation {
  return node.kind === "resource.write" &&
    node.effect.resource === guestMemoryResource;
}

export function isResourceRead(node: BodyNode): node is MemoryReadOperation {
  return node.kind === "resource.read" && node.outputs.length === 1;
}

export function isResourceWrite(node: BodyNode): node is MemoryWriteOperation {
  return node.kind === "resource.write";
}

export function resourceEffectsEqual(
  left: ResourceEffect,
  right: ResourceEffect
): boolean {
  return covers(left, right) && covers(right, left);
}

export function resourceWriteValue(operation: MemoryWriteOperation): ValueId {
  return operation.inputs[1].value;
}

export function isStatusFlagCall(node: BodyNode): node is StatusFlagCallOperation {
  return node.kind === "call" &&
    node.outputs.length === 1 &&
    statusFlagForTarget(node.invocation.target) !== undefined;
}


export function resolvedStatusFlag(operation: StatusFlagCallOperation): X86StatusFlag {
  const flag = statusFlagForTarget(operation.invocation.target);

  if (flag === undefined) {
    throw new Error("unknown status-flag resolver");
  }
  return flag;
}

function statusFlagForTarget(
  target: Invocation["target"]
): X86StatusFlag | undefined {
  if (target.references.functions.length !== 1) {
    return undefined;
  }
  const [definition] = target.references.functions;

  return x86StatusFlags.find((flag) =>
    definition?.ref.id === cpuStatusFlagResolvers.get(flag).ref.id
  );
}
