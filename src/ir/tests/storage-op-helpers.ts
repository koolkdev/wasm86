import type { Action, EdgeFlushAction, OpAction } from "#ir/actions.js";
import type { CpuResolveFlagOp, MemoryReadOp, MemoryWriteOp, StateReadOp, StateWriteOp } from "#ir/ops.js";
import type { StateSlot } from "#ir/slots.js";
import type { ValueId } from "#ir/values.js";
import type { X86StatusFlag } from "#x86/flags.js";
import type { OperandWidth } from "#x86/types.js";

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

export type StateReadAction = OpAction & Readonly<{ op: StateReadOp; output: ValueId }>;
export type StateWriteAction = OpAction & Readonly<{ op: StateWriteOp }>;
export type MemoryReadAction = OpAction & Readonly<{ op: MemoryReadOp; output: ValueId }>;
export type MemoryWriteAction = OpAction & Readonly<{ op: MemoryWriteOp }>;
export type ResolveFlagAction = OpAction & Readonly<{ op: CpuResolveFlagOp; output: ValueId }>;

export function stateRead(output: ValueId, slot: StateSlot): StateReadAction;
export function stateRead(output: ValueId, slot: StateSlot, signed: true): StateReadAction;
export function stateRead(output: ValueId, slot: StateSlot, signed?: true): StateReadAction {
  return signed === true
    ? { kind: "op", output, op: { kind: "state.read", slot, signed: true } }
    : { kind: "op", output, op: { kind: "state.read", slot } };
}

export function stateWrite(slot: StateSlot, value: ValueId): StateWriteAction {
  return { kind: "op", op: { kind: "state.write", slot, value } };
}

export function memoryRead(output: ValueId, address: ValueId, width: OperandWidth): MemoryReadAction;
export function memoryRead(output: ValueId, address: ValueId, width: OperandWidth, signed: true): MemoryReadAction;
export function memoryRead(
  output: ValueId,
  address: ValueId,
  width: OperandWidth,
  signed?: true
): MemoryReadAction {
  return signed === true
    ? { kind: "op", output, op: { kind: "memory.read", address, width, signed: true } }
    : { kind: "op", output, op: { kind: "memory.read", address, width } };
}

export function memoryWrite(address: ValueId, value: ValueId, width: OperandWidth): MemoryWriteAction {
  return { kind: "op", op: { kind: "memory.write", address, value, width } };
}

export function resolveFlag(output: ValueId, flag: X86StatusFlag): ResolveFlagAction {
  return { kind: "op", output, op: { kind: "cpu.resolveFlag", flag } };
}

export function isStateRead(action: Action | EdgeFlushAction): action is StateReadAction {
  return action.kind === "op" && action.op.kind === "state.read" && "output" in action && action.output !== undefined;
}

export function isStateWrite(action: Action | EdgeFlushAction): action is StateWriteAction {
  return action.kind === "op" && action.op.kind === "state.write";
}

export function isMemoryRead(action: Action | EdgeFlushAction): action is MemoryReadAction {
  return action.kind === "op" && action.op.kind === "memory.read" && "output" in action && action.output !== undefined;
}

export function isMemoryWrite(action: Action | EdgeFlushAction): action is MemoryWriteAction {
  return action.kind === "op" && action.op.kind === "memory.write";
}

export function isResolveFlag(action: Action | EdgeFlushAction): action is ResolveFlagAction {
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
