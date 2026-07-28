import type { Invocation } from "#compiler/ir/invocation.js";
import type { RegionNode } from "#compiler/ir/region.js";
import type { CallOperation, Operation } from "#compiler/ir/operations/index.js";
import {
  resourceRead as resourceReadOperation,
  resourceWrite as resourceWriteOperation
} from "#compiler/ir/operations/resource.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { IntegerWidth, ValueId } from "#compiler/ir/values/types.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import { cpuStatusFlagResolvers, guestMemoryResource } from "#test/support/execution-model.js";
import {
  DynamicByteOriginRef,
  resourceRef,
  type ResourceByteOperand,
  type ResourceReadMode,
  type ResourceEffect
} from "#compiler/ir/resource.js";

type OperationOf<Kind extends Operation["kind"]> = Extract<Operation, { kind: Kind }>;

export type MemoryReadOperation = OperationOf<"resource.read">;
export type MemoryWriteOperation = OperationOf<"resource.write">;
export type StatusFlagCallOperation = CallOperation &
  Readonly<{
    output: ValueId;
  }>;

const compilerTestResource = resourceRef("test.compiler-storage");

export function compilerTestValues(): ValueTable {
  const values = new ValueTable();

  // Static resource operations need their zero base to precede node outputs.
  values.const(0);
  return values;
}

export function compilerTestResourceEffect(region: number, byteLength = 4): ResourceEffect {
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
  output: ValueId,
  region: number,
  width: IntegerWidth = 32,
  signed?: true
): MemoryReadOperation {
  const source = {
    effect: compilerTestResourceEffect(region, width / 8),
    address: { base: values.const(0), displacement: region * 4 },
    width
  };
  return signed === true
    ? resourceReadOperation.create({ source, mode: { kind: "signed" } }, () => output)
    : resourceReadOperation.create({ source }, () => output);
}

export function resourceWriteNode(
  values: ValueTable,
  region: number,
  value: ValueId,
  width: IntegerWidth = 32
): MemoryWriteOperation {
  return resourceWriteOperation.create({
    destination: {
      effect: compilerTestResourceEffect(region, width / 8),
      address: { base: values.const(0), displacement: region * 4 },
      width
    },
    value
  });
}

export function operandRead(
  output: ValueId,
  source: ResourceByteOperand,
  mode?: ResourceReadMode
): MemoryReadOperation {
  return resourceReadOperation.create(
    mode === undefined ? { source } : { source, mode },
    () => output
  );
}

export function operandWrite(
  destination: ResourceByteOperand,
  value: ValueId
): MemoryWriteOperation {
  return resourceWriteOperation.create({
    destination,
    value
  });
}

export function memoryReadOperation(
  output: ValueId,
  address: ValueId,
  width: IntegerWidth
): MemoryReadOperation;
export function memoryReadOperation(
  output: ValueId,
  address: ValueId,
  width: IntegerWidth,
  signed: true
): MemoryReadOperation;
export function memoryReadOperation(
  output: ValueId,
  address: ValueId,
  width: IntegerWidth,
  signed?: true
): MemoryReadOperation {
  const range = {
    basis: {
      kind: "dynamic" as const,
      origin: new DynamicByteOriginRef()
    },
    slice: { byteOffset: 0, byteLength: width / 8 }
  };
  return signed === true
    ? resourceReadOperation.create(
        {
          source: {
            effect: { space: "resource", resource: guestMemoryResource, range },
            address: { base: address, displacement: 0 },
            width
          },
          mode: { kind: "signed" }
        },
        () => output
      )
    : resourceReadOperation.create(
        {
          source: {
            effect: { space: "resource", resource: guestMemoryResource, range },
            address: { base: address, displacement: 0 },
            width
          }
        },
        () => output
      );
}

export function memoryWriteOperation(
  address: ValueId,
  value: ValueId,
  width: IntegerWidth
): MemoryWriteOperation {
  const range = {
    basis: {
      kind: "dynamic" as const,
      origin: new DynamicByteOriginRef()
    },
    slice: { byteOffset: 0, byteLength: width / 8 }
  };

  return resourceWriteOperation.create({
    destination: {
      effect: { space: "resource", resource: guestMemoryResource, range },
      address: { base: address, displacement: 0 },
      width
    },
    value
  });
}

export function isMemoryRead(node: RegionNode): node is MemoryReadOperation {
  return node.kind === "resource.read" && node.source.effect.resource === guestMemoryResource;
}

export function isMemoryWrite(node: RegionNode): node is MemoryWriteOperation {
  return node.kind === "resource.write" && node.destination.effect.resource === guestMemoryResource;
}

export function isStatusFlagCall(node: RegionNode): node is StatusFlagCallOperation {
  return (
    node.kind === "call" &&
    node.output !== undefined &&
    statusFlagForTarget(node.invocation.target) !== undefined
  );
}

export function resolvedStatusFlag(operation: StatusFlagCallOperation): X86StatusFlag {
  const flag = statusFlagForTarget(operation.invocation.target);

  if (flag === undefined) {
    throw new Error("unknown status-flag resolver");
  }
  return flag;
}

function statusFlagForTarget(target: Invocation["target"]): X86StatusFlag | undefined {
  if (target.kind !== "direct") {
    return undefined;
  }

  return x86StatusFlags.find((flag) => target.ref.id === cpuStatusFlagResolvers.get(flag).ref.id);
}
