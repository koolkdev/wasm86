import type { RunResult, RunResultDetails } from "#x86/execution/run-result.js";
import { runResultFromState, StopReason } from "#x86/execution/run-result.js";
import type { GuestMemory, MemoryFault } from "#x86/memory/guest-memory.js";
import {
  getFlag,
  getRegisterAlias,
  getReg32,
  hasEvenParityLowByte,
  setFlag,
  setRegisterAlias,
  setReg32,
  u32,
  type CpuState
} from "#x86/state/cpu-state.js";
import { buildIr } from "#x86/ir/build/builder.js";
import { CONDITIONS, type FlagBoolExpr } from "#x86/ir/model/conditions.js";
import {
  defineFlagProducer,
  flagProducerInputsFromRecord,
  type FlagExpr,
  type FlagName,
  type ValueExpr
} from "#x86/ir/model/flags.js";
import type {
  IrBinaryOperator,
  IrFlagSetOp,
  IrOp,
  IrUnaryOperator,
  MemRef,
  SemanticOperandInfo,
  StorageRef,
  ValueRef,
  VarRef
} from "#x86/ir/model/types.js";
import type { IsaDecodedInstruction, IsaOperandBinding } from "#x86/isa/decoder/types.js";
import { widthMask, type MemOperand, type OperandWidth, type Reg32 } from "#x86/isa/types.js";

export type DirectExecutionOptions = Readonly<{
  memory?: GuestMemory;
}>;

type ExecutionContext = Readonly<{
  state: CpuState;
  instruction: IsaDecodedInstruction;
  memory: GuestMemory | undefined;
  vars: Map<number, number>;
}>;

type ValueResult =
  | Readonly<{ kind: "value"; value: number }>
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "memoryFault"; fault: MemoryFault }>;

type WriteResult =
  | Readonly<{ kind: "ok" }>
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{ kind: "memoryFault"; fault: MemoryFault }>;

export function executeDirectInstruction(
  state: CpuState,
  instruction: IsaDecodedInstruction,
  options: DirectExecutionOptions = {}
): RunResult {
  const context: ExecutionContext = { state, instruction, memory: options.memory, vars: new Map() };
  const program = buildIr(instruction.spec.semantics, {
    operandInfo: instruction.operands.map(semanticOperandInfoForBinding),
    memoryGuards: true
  });

  for (const op of program) {
    const result = executeOp(context, op);

    if (result !== undefined) {
      return result;
    }
  }

  return stop(state, StopReason.UNSUPPORTED);
}

function semanticOperandInfoForBinding(binding: IsaOperandBinding): SemanticOperandInfo {
  switch (binding.kind) {
    case "reg":
      return { storage: "reg" };
    case "mem":
      return { storage: "mem" };
    case "imm":
      return { storage: "imm" };
    case "relTarget":
      return { storage: "relTarget" };
  }
}

function executeOp(context: ExecutionContext, op: IrOp): RunResult | undefined {
  switch (op.op) {
    case "get": {
      const accessWidth = op.accessWidth ?? 32;
      const read = readStorage(context, op.source, accessWidth);

      if (read.kind !== "value") {
        return stopFromAccess(context.state, read);
      }

      setVar(context, op.dst, op.signed === true && accessWidth < 32
        ? signExtendValue(read.value, accessWidth as 8 | 16)
        : read.value);
      return undefined;
    }
    case "set": {
      const value = evalValueRef(context, op.value);
      const write = writeStorage(context, op.target, value, op.accessWidth ?? 32);

      return write.kind === "ok" ? undefined : stopFromAccess(context.state, write);
    }
    case "memory.guard": {
      const guard = guardMemory(context, evalValueRef(context, op.address), op.byteLength, op.access);

      return guard.kind === "ok" ? undefined : stopFromAccess(context.state, guard);
    }
    case "address": {
      const binding = context.instruction.operands[op.operand.index];

      if (binding?.kind !== "mem") {
        return stop(context.state, StopReason.UNSUPPORTED);
      }

      setVar(context, op.dst, effectiveAddress(context.state, binding));
      return undefined;
    }
    case "value.const":
      setVar(context, op.dst, op.value);
      return undefined;
    case "value.binary":
      setVar(context, op.dst, evalI32Binary(op.operator, evalValueRef(context, op.a), evalValueRef(context, op.b)));
      return undefined;
    case "value.unary":
      setVar(context, op.dst, evalI32Unary(op.operator, evalValueRef(context, op.value)));
      return undefined;
    case "value.select":
      setVar(
        context,
        op.dst,
        evalValueRef(context, op.condition) !== 0
          ? evalValueRef(context, op.whenTrue)
          : evalValueRef(context, op.whenFalse)
      );
      return undefined;
    case "flags.set":
      setFlags(context, op);
      return undefined;
    case "flags.condition":
      setVar(context, op.dst, evalCondition(context, op.cc) ? 1 : 0);
      return undefined;
    case "next":
      return completeInstruction(context, context.instruction.nextEip);
    case "jump":
      return completeInstruction(context, evalValueRef(context, op.target));
    case "conditionalJump":
      return completeInstruction(
        context,
        evalValueRef(context, op.condition) !== 0 ? evalValueRef(context, op.taken) : evalValueRef(context, op.notTaken)
      );
    case "hostTrap":
      return completeHostTrap(context, evalValueRef(context, op.vector));
  }
}

function evalI32Binary(operator: IrBinaryOperator, a: number, b: number): number {
  switch (operator) {
    case "add":
      return u32(a + b);
    case "sub":
      return u32(a - b);
    case "xor":
      return u32(a ^ b);
    case "or":
      return u32(a | b);
    case "and":
      return u32(a & b);
    case "shl":
      return u32(a << (b & 31));
    case "shr_u":
      return u32(a >>> (b & 31));
  }
}

function evalI32Unary(operator: IrUnaryOperator, value: number): number {
  switch (operator) {
    case "extend8_s":
      return signExtendValue(value, 8);
    case "extend16_s":
      return signExtendValue(value, 16);
  }
}

function readStorage(context: ExecutionContext, storage: StorageRef, accessWidth: OperandWidth): ValueResult {
  switch (storage.kind) {
    case "operand": {
      const binding = context.instruction.operands[storage.index];

      return binding === undefined ? { kind: "unsupported" } : readOperandBinding(context, binding, accessWidth);
    }
    case "reg":
      return { kind: "value", value: readReg32Access(context.state, storage.reg, accessWidth) };
    case "mem":
      return readMemory(context, storage, accessWidth);
  }
}

function writeStorage(context: ExecutionContext, storage: StorageRef, value: number, accessWidth: OperandWidth): WriteResult {
  const maskedValue = maskValue(value, accessWidth);

  switch (storage.kind) {
    case "operand": {
      const binding = context.instruction.operands[storage.index];

      return binding === undefined ? { kind: "unsupported" } : writeOperandBinding(context, binding, accessWidth, maskedValue);
    }
    case "reg":
      writeReg32Access(context.state, storage.reg, accessWidth, maskedValue);
      return { kind: "ok" };
    case "mem":
      return writeMemory(context, storage, accessWidth, maskedValue);
  }
}

function readOperandBinding(context: ExecutionContext, binding: IsaOperandBinding, accessWidth: OperandWidth): ValueResult {
  switch (binding.kind) {
    case "reg":
      return { kind: "value", value: maskValue(getRegisterAlias(context.state, binding.alias), accessWidth) };
    case "imm":
      return { kind: "value", value: maskValue(binding.value, accessWidth) };
    case "relTarget":
      return { kind: "value", value: binding.target };
    case "mem":
      return readGuest(context, effectiveAddress(context.state, binding), accessWidth);
  }
}

function writeOperandBinding(
  context: ExecutionContext,
  binding: IsaOperandBinding,
  accessWidth: OperandWidth,
  value: number
): WriteResult {
  switch (binding.kind) {
    case "reg":
      setRegisterAlias(context.state, binding.alias, maskValue(value, accessWidth));
      return { kind: "ok" };
    case "mem":
      return writeGuest(context, effectiveAddress(context.state, binding), accessWidth, value);
    case "imm":
    case "relTarget":
      return { kind: "unsupported" };
  }
}

function readMemory(context: ExecutionContext, storage: MemRef, accessWidth: OperandWidth): ValueResult {
  return readGuest(context, evalValueRef(context, storage.address), accessWidth);
}

function writeMemory(context: ExecutionContext, storage: MemRef, accessWidth: OperandWidth, value: number): WriteResult {
  return writeGuest(context, evalValueRef(context, storage.address), accessWidth, value);
}

function guardMemory(
  context: ExecutionContext,
  address: number,
  byteLength: number,
  operation: "read" | "write"
): WriteResult {
  const fault = context.memory?.checkAccess(address, byteLength, operation);

  if (fault === undefined) {
    return context.memory === undefined ? { kind: "unsupported" } : { kind: "ok" };
  }

  return { kind: "memoryFault", fault };
}

function readGuest(context: ExecutionContext, address: number, width: OperandWidth): ValueResult {
  switch (width) {
    case 8:
      return readGuestU8(context, address);
    case 16:
      return readGuestU16(context, address);
    case 32:
      return readGuestU32(context, address);
  }
}

function writeGuest(context: ExecutionContext, address: number, width: OperandWidth, value: number): WriteResult {
  switch (width) {
    case 8:
      return writeGuestU8(context, address, value);
    case 16:
      return writeGuestU16(context, address, value);
    case 32:
      return writeGuestU32(context, address, value);
  }
}

function readGuestU8(context: ExecutionContext, address: number): ValueResult {
  const read = context.memory?.readU8(address);

  if (read === undefined) {
    return { kind: "unsupported" };
  }

  return read.ok ? { kind: "value", value: read.value } : unguardedMemoryAccess(read.fault);
}

function readGuestU16(context: ExecutionContext, address: number): ValueResult {
  const read = context.memory?.readU16(address);

  if (read === undefined) {
    return { kind: "unsupported" };
  }

  return read.ok ? { kind: "value", value: read.value } : unguardedMemoryAccess(read.fault);
}

function readGuestU32(context: ExecutionContext, address: number): ValueResult {
  const read = context.memory?.readU32(address);

  if (read === undefined) {
    return { kind: "unsupported" };
  }

  return read.ok ? { kind: "value", value: read.value } : unguardedMemoryAccess(read.fault);
}

function writeGuestU32(context: ExecutionContext, address: number, value: number): WriteResult {
  const write = context.memory?.writeU32(address, value);

  if (write === undefined) {
    return { kind: "unsupported" };
  }

  return write.ok ? { kind: "ok" } : unguardedMemoryAccess(write.fault);
}

function writeGuestU8(context: ExecutionContext, address: number, value: number): WriteResult {
  const write = context.memory?.writeU8(address, value);

  if (write === undefined) {
    return { kind: "unsupported" };
  }

  return write.ok ? { kind: "ok" } : unguardedMemoryAccess(write.fault);
}

function writeGuestU16(context: ExecutionContext, address: number, value: number): WriteResult {
  const write = context.memory?.writeU16(address, value);

  if (write === undefined) {
    return { kind: "unsupported" };
  }

  return write.ok ? { kind: "ok" } : unguardedMemoryAccess(write.fault);
}

function unguardedMemoryAccess(fault: MemoryFault): never {
  throw new Error(
    `unguarded memory ${fault.faultOperation} fault at ${fault.faultAddress} (${fault.faultSize} byte access)`
  );
}

function setFlags(
  context: ExecutionContext,
  descriptor: IrFlagSetOp
): void {
  const inputs = flagProducerInputsFromRecord(descriptor.producer, descriptor.inputs);
  const defs = defineFlagProducer(descriptor.producer, inputs, descriptor.width ?? 32);

  for (const [flag, expr] of Object.entries(defs) as [FlagName, FlagExpr][]) {
    setFlag(context.state, flag, evalFlagExpr(context, expr));
  }
}

function evalCondition(context: ExecutionContext, cc: keyof typeof CONDITIONS): boolean {
  return evalFlagBoolExpr(context, CONDITIONS[cc].expr);
}

function evalFlagBoolExpr(context: ExecutionContext, expr: FlagBoolExpr): boolean {
  switch (expr.kind) {
    case "flag":
      return getFlag(context.state, expr.flag);
    case "not":
      return !evalFlagBoolExpr(context, expr.value);
    case "and":
      return evalFlagBoolExpr(context, expr.a) && evalFlagBoolExpr(context, expr.b);
    case "or":
      return evalFlagBoolExpr(context, expr.a) || evalFlagBoolExpr(context, expr.b);
    case "xor":
      return evalFlagBoolExpr(context, expr.a) !== evalFlagBoolExpr(context, expr.b);
  }
}

function evalFlagExpr(context: ExecutionContext, expr: FlagExpr): boolean {
  switch (expr.kind) {
    case "constFlag":
      return expr.value !== 0;
    case "undefFlag":
      return false;
    case "eqz":
      return evalValueExpr(context, expr.value) === 0;
    case "ne0":
      return evalValueExpr(context, expr.value) !== 0;
    case "uLt":
      return evalValueExpr(context, expr.a) < evalValueExpr(context, expr.b);
    case "bit":
      return ((evalValueExpr(context, expr.value) >>> expr.bit) & 1) !== 0;
    case "parity8":
      return hasEvenParityLowByte(evalValueExpr(context, expr.value));
    case "signBit":
      return (evalValueExpr(context, expr.value) & signMask(expr.width)) !== 0;
  }
}

function evalValueExpr(context: ExecutionContext, expr: ValueExpr): number {
  switch (expr.kind) {
    case "leaf":
      return evalValueRef(context, expr.value);
    case "const":
      return evalValueRef(context, expr);
    case "and":
      return u32(evalValueExpr(context, expr.a) & evalValueExpr(context, expr.b));
    case "xor":
      return u32(evalValueExpr(context, expr.a) ^ evalValueExpr(context, expr.b));
  }
}

function evalValueRef(context: ExecutionContext, value: ValueRef): number {
  switch (value.kind) {
    case "var": {
      const varValue = context.vars.get(value.id);

      if (varValue === undefined) {
        throw new Error(`IR var ${value.id} read before definition`);
      }

      return varValue;
    }
    case "const":
      return value.value;
    case "nextEip":
      return context.instruction.nextEip;
  }
}

function setVar(context: ExecutionContext, ref: VarRef, value: number): void {
  context.vars.set(ref.id, u32(value));
}

function effectiveAddress(state: CpuState, binding: MemOperand): number {
  const base = binding.base === undefined ? 0 : getReg32(state, binding.base);
  const index = binding.index === undefined ? 0 : u32(getReg32(state, binding.index) * binding.scale);

  return u32(base + index + binding.disp);
}

function readReg32Access(state: CpuState, reg: Reg32, accessWidth: OperandWidth): number {
  return maskValue(getReg32(state, reg), accessWidth);
}

function writeReg32Access(state: CpuState, reg: Reg32, accessWidth: OperandWidth, value: number): void {
  if (accessWidth === 32) {
    setReg32(state, reg, value);
    return;
  }

  const mask = widthMask(accessWidth);
  const base = getReg32(state, reg);

  setReg32(state, reg, (base & ~mask) | (value & mask));
}

function maskValue(value: number, width: OperandWidth): number {
  return width === 32 ? u32(value) : value & widthMask(width);
}

function signMask(width: 8 | 16 | 32): number {
  return width === 32 ? 0x8000_0000 : width === 16 ? 0x8000 : 0x80;
}

function signExtendValue(value: number, width: 8 | 16): number {
  const shift = 32 - width;

  return u32((value << shift) >> shift);
}

function completeInstruction(context: ExecutionContext, target: number): RunResult {
  context.state.eip = u32(target);
  context.state.instructionCount = u32(context.state.instructionCount + 1);

  return runResultFromState(context.state, StopReason.NONE);
}

function completeHostTrap(context: ExecutionContext, vector: number): RunResult {
  context.state.eip = context.instruction.nextEip;
  context.state.instructionCount = u32(context.state.instructionCount + 1);
  context.state.stopReason = StopReason.HOST_TRAP;

  return runResultFromState(context.state, StopReason.HOST_TRAP, { trapVector: vector & 0xff });
}

function stopFromAccess(state: CpuState, access: ValueResult | WriteResult): RunResult {
  switch (access.kind) {
    case "unsupported":
      return stop(state, StopReason.UNSUPPORTED);
    case "memoryFault":
      return stop(state, StopReason.MEMORY_FAULT, access.fault);
    case "value":
    case "ok":
      throw new Error(`cannot stop from successful ${access.kind} access`);
  }
}

function stop(state: CpuState, reason: StopReason, details: RunResultDetails = {}): RunResult {
  state.stopReason = reason;
  return runResultFromState(state, reason, details);
}
