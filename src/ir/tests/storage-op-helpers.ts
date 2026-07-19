import { assert } from "#common/assert.js";
import type { Action, CallAction, OpAction } from "#ir/actions.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import {
  resourceRead as resourceReadOperation,
  resourceWrite as resourceWriteOperation
} from "#compiler/ir/operations/resource.js";
import { valueId } from "#compiler/ir/values/id.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { cpuStatusFlagResolvers } from "#cpu/state.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import type { OperandWidth } from "#core/types.js";
import { guestMemoryResource } from "#memory/resource.js";
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

export type MemoryReadAction = OpAction & Readonly<{
  op: OperationOf<"resource.read">;
  output: ValueId;
}>;
export type MemoryWriteAction = OpAction & Readonly<{ op: OperationOf<"resource.write"> }>;
export type StatusFlagCallAction = CallAction & Readonly<{
  outputs: readonly [ValueId];
}>;

export const compilerTestResource = resourceRef("test.compiler-storage");

export function compilerTestValues(): ValueTable {
  const values = new ValueTable();

  // Static resource operations need their zero base to precede action outputs.
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

export function resourceReadAction(
  values: ValueTable,
  output: TestValueId,
  region: number,
  width: OperandWidth = 32,
  signed?: true
): MemoryReadAction {
  const source = {
    effect: compilerTestResourceEffect(region, width / 8),
    address: { base: values.const(0), displacement: region * 4 },
    width
  };
  const op = signed === true
    ? resourceReadOperation.create({ source, mode: { kind: "signed" } })
    : resourceReadOperation.create({ source });

  return { kind: "op", output: valueId(output), op };
}

export function resourceWriteAction(
  values: ValueTable,
  region: number,
  value: TestValueId,
  width: OperandWidth = 32
): MemoryWriteAction {
  return {
    kind: "op",
    op: resourceWriteOperation.create({
      destination: {
        effect: compilerTestResourceEffect(region, width / 8),
        address: { base: values.const(0), displacement: region * 4 },
        width
      },
      value: valueId(value)
    })
  };
}

export function operandRead(
  output: TestValueId,
  source: ResourceByteOperand,
  mode?: ResourceReadMode
): MemoryReadAction {
  const op = resourceReadOperation.create(
    mode === undefined ? { source } : { source, mode }
  );

  return { kind: "op", output: valueId(output), op };
}

export function operandWrite(
  destination: ResourceByteOperand,
  value: TestValueId
): MemoryWriteAction {
  return {
    kind: "op",
    op: resourceWriteOperation.create({
      destination,
      value: valueId(value)
    })
  };
}

export function memoryRead(output: TestValueId, address: TestValueId, width: OperandWidth): MemoryReadAction;
export function memoryRead(output: TestValueId, address: TestValueId, width: OperandWidth, signed: true): MemoryReadAction;
export function memoryRead(
  output: TestValueId,
  address: TestValueId,
  width: OperandWidth,
  signed?: true
): MemoryReadAction {
  const outputId = valueId(output);
  const addressId = valueId(address);
  const range = {
    basis: {
      kind: "dynamic" as const,
      origin: new DynamicByteOriginRef()
    },
    slice: { byteOffset: 0, byteLength: width / 8 }
  };
  const op = signed === true
    ? resourceReadOperation.create({
        source: {
          effect: { space: "resource", resource: guestMemoryResource, range },
          address: { base: addressId, displacement: 0 },
          width
        },
        mode: { kind: "signed" }
      })
    : resourceReadOperation.create({
        source: {
          effect: { space: "resource", resource: guestMemoryResource, range },
          address: { base: addressId, displacement: 0 },
          width
        }
      });

  return { kind: "op", output: outputId, op };
}

export function memoryWrite(address: TestValueId, value: TestValueId, width: OperandWidth): MemoryWriteAction {
  const range = {
    basis: {
      kind: "dynamic" as const,
      origin: new DynamicByteOriginRef()
    },
    slice: { byteOffset: 0, byteLength: width / 8 }
  };

  return {
    kind: "op",
    op: resourceWriteOperation.create({
      destination: {
        effect: { space: "resource", resource: guestMemoryResource, range },
        address: { base: valueId(address), displacement: 0 },
        width
      },
      value: valueId(value),
    })
  };
}

export function statusFlagCall(
  output: TestValueId,
  flag: X86StatusFlag
): StatusFlagCallAction {
  return {
    kind: "call",
    target: cpuStatusFlagResolvers.get(flag),
    arguments: [],
    outputs: [valueId(output)]
  };
}

export function isMemoryRead(action: Action): action is MemoryReadAction {
  return action.kind === "op" &&
    action.op.kind === "resource.read" &&
    action.op.effect.resource === guestMemoryResource &&
    "output" in action &&
    action.output !== undefined;
}

export function isMemoryWrite(action: Action): action is MemoryWriteAction {
  return action.kind === "op" &&
    action.op.kind === "resource.write" &&
    action.op.effect.resource === guestMemoryResource;
}

export function isResourceRead(action: Action): action is MemoryReadAction {
  return action.kind === "op" &&
    action.op.kind === "resource.read" &&
    action.output !== undefined;
}

export function isResourceWrite(action: Action): action is MemoryWriteAction {
  return action.kind === "op" && action.op.kind === "resource.write";
}

export function resourceEffectsEqual(
  left: ResourceEffect,
  right: ResourceEffect
): boolean {
  return covers(left, right) && covers(right, left);
}

export function resourceWriteValue(action: MemoryWriteAction): ValueId {
  const input = action.op.inputs.at(-1);

  assert(input !== undefined, "resource write is missing its value input");
  return input.value;
}

export function isStatusFlagCall(action: Action): action is StatusFlagCallAction {
  return action.kind === "call" &&
    action.outputs.length === 1 &&
    x86StatusFlags.some((flag) => action.target === cpuStatusFlagResolvers.get(flag));
}

export function resolvedStatusFlag(action: StatusFlagCallAction): X86StatusFlag {
  const flag = x86StatusFlags.find((candidate) =>
    action.target === cpuStatusFlagResolvers.get(candidate)
  );

  if (flag === undefined) {
    throw new Error(`unknown status-flag resolver ${action.target.ref.id}`);
  }
  return flag;
}
