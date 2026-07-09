import type { Action, OpAction } from "#ir/actions.js";
import type {
  CpuResolveFlagOp,
  MemoryCheckOp,
  MemoryAccessKind,
  MemoryReadOp,
  MemoryWriteOp,
  StateReadOp,
  StateWriteOp
} from "#ir/ops.js";
import type { StateSlot } from "#ir/slots.js";
import { valueId, type ValueId } from "#ir/values.js";
import type { X86StatusFlag } from "#x86/flags.js";
import type { OperandWidth } from "#x86/types.js";

type TestValueId = ValueId | number;

export type StateReadFact = Readonly<{
  output: ValueId;
  slot: StateSlot;
  signed?: true;
}>;

export type StateWriteFact = Readonly<{
  slot: StateSlot;
  value: ValueId;
}>;

export type MemoryReadFact = Readonly<{
  output: ValueId;
  address: ValueId;
  width: OperandWidth;
  signed?: true;
}>;

export type MemoryWriteFact = Readonly<{
  address: ValueId;
  value: ValueId;
  width: OperandWidth;
}>;

export type MemoryCheckFact = Readonly<{
  output: ValueId;
  address: ValueId;
  byteLength: ValueId;
  access: MemoryAccessKind;
}>;

export type StateReadAction = OpAction & Readonly<{ op: StateReadOp; output: ValueId }>;
export type StateWriteAction = OpAction & Readonly<{ op: StateWriteOp }>;
export type MemoryReadAction = OpAction & Readonly<{ op: MemoryReadOp; output: ValueId }>;
export type MemoryWriteAction = OpAction & Readonly<{ op: MemoryWriteOp }>;
export type MemoryCheckAction = OpAction & Readonly<{ op: MemoryCheckOp; output: ValueId }>;
export type ResolveFlagAction = OpAction & Readonly<{ op: CpuResolveFlagOp; output: ValueId }>;

export function stateRead(output: TestValueId, slot: StateSlot): StateReadAction;
export function stateRead(output: TestValueId, slot: StateSlot, signed: true): StateReadAction;
export function stateRead(output: TestValueId, slot: StateSlot, signed?: true): StateReadAction {
  const outputId = valueId(output);

  return signed === true
    ? { kind: "op", output: outputId, op: { kind: "state.read", slot, signed: true } }
    : { kind: "op", output: outputId, op: { kind: "state.read", slot } };
}

export function stateWrite(slot: StateSlot, value: TestValueId): StateWriteAction {
  return { kind: "op", op: { kind: "state.write", slot, value: valueId(value) } };
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

  return signed === true
    ? { kind: "op", output: outputId, op: { kind: "memory.read", address: addressId, width, signed: true } }
    : { kind: "op", output: outputId, op: { kind: "memory.read", address: addressId, width } };
}

export function memoryWrite(address: TestValueId, value: TestValueId, width: OperandWidth): MemoryWriteAction {
  return { kind: "op", op: { kind: "memory.write", address: valueId(address), value: valueId(value), width } };
}

export function memoryCheck(
  output: TestValueId,
  address: TestValueId,
  byteLength: TestValueId,
  access: MemoryAccessKind
): MemoryCheckAction {
  return {
    kind: "op",
    output: valueId(output),
    op: { kind: "memory.check", address: valueId(address), byteLength: valueId(byteLength), access }
  };
}

export function resolveFlag(output: TestValueId, flag: X86StatusFlag): ResolveFlagAction {
  return { kind: "op", output: valueId(output), op: { kind: "cpu.resolveFlag", flag } };
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

export function isResolveFlag(action: Action): action is ResolveFlagAction {
  return action.kind === "op" && action.op.kind === "cpu.resolveFlag" && "output" in action && action.output !== undefined;
}

export function stateReadFact(action: OpAction): StateReadFact | undefined {
  if (action.op.kind !== "state.read") {
    return undefined;
  }

  return action.op.signed === true
    ? { output: action.output!, slot: action.op.slot, signed: true }
    : { output: action.output!, slot: action.op.slot };
}

export function stateWriteFact(action: OpAction): StateWriteFact | undefined {
  if (action.op.kind !== "state.write") {
    return undefined;
  }

  return { slot: action.op.slot, value: action.op.value };
}

export function memoryReadFact(action: OpAction): MemoryReadFact | undefined {
  if (action.op.kind !== "memory.read") {
    return undefined;
  }

  return action.op.signed === true
    ? { output: action.output!, address: action.op.address, width: action.op.width, signed: true }
    : { output: action.output!, address: action.op.address, width: action.op.width };
}

export function memoryWriteFact(action: OpAction): MemoryWriteFact | undefined {
  if (action.op.kind !== "memory.write") {
    return undefined;
  }

  return { address: action.op.address, value: action.op.value, width: action.op.width };
}

export function memoryCheckFact(action: OpAction): MemoryCheckFact | undefined {
  if (action.op.kind !== "memory.check") {
    return undefined;
  }

  return {
    output: action.output!,
    address: action.op.address,
    byteLength: action.op.byteLength,
    access: action.op.access
  };
}
