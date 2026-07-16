import type { Action, CallAction, OpAction } from "#ir/actions.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import {
  memoryCheck as memoryCheckOperation,
  memoryRead as memoryReadOperation,
  memoryResolve as memoryResolveOperation,
  memoryWrite as memoryWriteOperation
} from "#compiler/ir/operations/memory.js";
import {
  stateRead as stateReadOperation,
  stateWrite as stateWriteOperation
} from "#compiler/ir/operations/state.js";
import type { StateSlot } from "#ir/slots.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { statusFlagResolvers } from "#core/flags/resolvers.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import type { OperandWidth } from "#core/types.js";

type TestValueId = ValueId | number;
type OperationOf<Kind extends Operation["kind"]> = Extract<Operation, { kind: Kind }>;

export type StateReadAction = OpAction & Readonly<{
  op: OperationOf<"state.read">;
  output: ValueId;
}>;
export type StateWriteAction = OpAction & Readonly<{ op: OperationOf<"state.write"> }>;
export type MemoryReadAction = OpAction & Readonly<{
  op: OperationOf<"memory.read">;
  output: ValueId;
}>;
export type MemoryWriteAction = OpAction & Readonly<{ op: OperationOf<"memory.write"> }>;
export type MemoryCheckAction = OpAction & Readonly<{
  op: OperationOf<"memory.check">;
  output: ValueId;
}>;
export type MemoryResolveAction = OpAction & Readonly<{
  op: OperationOf<"memory.resolve">;
  output: ValueId;
}>;
export type StatusFlagCallAction = CallAction & Readonly<{
  outputs: readonly [ValueId];
}>;

export function stateRead(output: TestValueId, slot: StateSlot): StateReadAction;
export function stateRead(output: TestValueId, slot: StateSlot, signed: true): StateReadAction;
export function stateRead(output: TestValueId, slot: StateSlot, signed?: true): StateReadAction {
  const outputId = valueId(output);
  const op = signed === true
    ? stateReadOperation.create({ slot, signed: true })
    : stateReadOperation.create({ slot });

  return { kind: "op", output: outputId, op };
}

export function stateWrite(slot: StateSlot, value: TestValueId): StateWriteAction {
  return {
    kind: "op",
    op: stateWriteOperation.create({ slot, value: valueId(value) })
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
  const op = signed === true
    ? memoryReadOperation.create({
        address: addressId,
        byteOffset: 0,
        width,
        signed: true
      })
    : memoryReadOperation.create({ address: addressId, byteOffset: 0, width });

  return { kind: "op", output: outputId, op };
}

export function memoryWrite(address: TestValueId, value: TestValueId, width: OperandWidth): MemoryWriteAction {
  return {
    kind: "op",
    op: memoryWriteOperation.create({
      address: valueId(address),
      byteOffset: 0,
      value: valueId(value),
      width
    })
  };
}

export function memoryCheck(
  output: TestValueId,
  address: TestValueId,
  byteLength: TestValueId
): MemoryCheckAction {
  return {
    kind: "op",
    output: valueId(output),
    op: memoryCheckOperation.create({
      address: valueId(address),
      byteLength: valueId(byteLength)
    })
  };
}

export function memoryResolve(
  output: TestValueId,
  address: TestValueId,
  byteLength: TestValueId
): MemoryResolveAction {
  return {
    kind: "op",
    output: valueId(output),
    op: memoryResolveOperation.create({
      address: valueId(address),
      byteLength: valueId(byteLength)
    })
  };
}

export function statusFlagCall(
  output: TestValueId,
  flag: X86StatusFlag,
  sourceKind: TestValueId,
  operandA: TestValueId,
  operandB: TestValueId,
  concrete: TestValueId
): StatusFlagCallAction {
  return {
    kind: "call",
    target: statusFlagResolvers.get(flag),
    arguments: [sourceKind, operandA, operandB, concrete].map((value) => ({
      value: valueId(value),
      type: "i32" as const
    })),
    outputs: [valueId(output)]
  };
}

export function isStateRead(action: Action): action is StateReadAction {
  return action.kind === "op" && action.op.kind === "state.read" && "output" in action && action.output !== undefined;
}

export function isStateWrite(action: Action): action is StateWriteAction {
  return action.kind === "op" && action.op.kind === "state.write";
}

export function isMemoryRead(action: Action): action is MemoryReadAction {
  return action.kind === "op" && action.op.kind === "memory.read" && "output" in action && action.output !== undefined;
}

export function isMemoryWrite(action: Action): action is MemoryWriteAction {
  return action.kind === "op" && action.op.kind === "memory.write";
}

export function isMemoryCheck(action: Action): action is MemoryCheckAction {
  return action.kind === "op" && action.op.kind === "memory.check" && "output" in action && action.output !== undefined;
}

export function isMemoryResolve(action: Action): action is MemoryResolveAction {
  return action.kind === "op" && action.op.kind === "memory.resolve" && "output" in action && action.output !== undefined;
}

export function isStatusFlagCall(action: Action): action is StatusFlagCallAction {
  return action.kind === "call" &&
    action.outputs.length === 1 &&
    x86StatusFlags.some((flag) => action.target === statusFlagResolvers.get(flag));
}

export function resolvedStatusFlag(action: StatusFlagCallAction): X86StatusFlag {
  const flag = x86StatusFlags.find((candidate) =>
    action.target === statusFlagResolvers.get(candidate)
  );

  if (flag === undefined) {
    throw new Error(`unknown status-flag resolver ${action.target.ref.id}`);
  }
  return flag;
}
