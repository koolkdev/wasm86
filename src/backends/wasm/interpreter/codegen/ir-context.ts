import type { OperandWidth, RegisterAlias } from "#x86/isa/types.js";
import { registerAlias } from "#x86/isa/registers.js";
import { buildIrExpressionBlock, type IrStorageExpr, type IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type {
  IrBlock,
  IrMemoryAccessKind,
  OperandRef,
  SemanticOperandInfo
} from "#x86/ir/model/types.js";
import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { wasmIrLocalAluFlagsStorage } from "#backends/wasm/codegen/alu-flags.js";
import { emitWasmIrExitFromI32Stack, type WasmIrExitDestination } from "#backends/wasm/codegen/exit.js";
import {
  emitWasmIrGuardGuestRange,
  emitWasmIrLoadGuestUnchecked,
  emitWasmIrStoreGuestUnchecked
} from "#backends/wasm/codegen/memory.js";
import {
  emitLoadRegAlias,
  emitStoreRegAlias
} from "#backends/wasm/codegen/registers.js";
import {
  emitCompleteInstruction,
  emitCompleteInstructionWithTarget
} from "./state-cache.js";
import {
  emitLoadRegByIndex,
  emitModRmRmIndex,
  emitOpcodeRegIndex,
  emitStoreRegByIndex
} from "#backends/wasm/interpreter/dispatch/register-dispatch.js";
import type { InterpreterStateCache } from "./state-cache.js";
import {
  emitIfModRmMemory,
  emitIfModRmRegister,
  emitModRmIsRegister,
  emitModRmRegIndex
} from "#backends/wasm/interpreter/decode/modrm-bits.js";
import { emitIrExpressionBlockToWasm, type WasmIrEmitHelpers } from "#backends/wasm/codegen/emit.js";
import { emitSetFlags, emitWriteFlags } from "#backends/wasm/codegen/flags.js";
import { emitFlagsCondition } from "#backends/wasm/codegen/conditions.js";
import { ExitReason } from "#backends/wasm/exit.js";
import type { InterpreterLocals } from "./locals.js";
import type { InterpreterDispatchDepths } from "./depths.js";
import {
  cleanValueWidth,
  dirtyValueWidth,
  emitCleanValueForFullUse,
  emitMaskValueToWidth,
  emitSignExtendValueToWidth,
  type WasmIrEmitValueOptions,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import { optimizeInterpreterExpressionBlock } from "./expressions.js";

export type InterpreterOperandBinding =
  | Readonly<{ kind: "opcode.reg"; opcodeLocal: number; width: OperandWidth }>
  | Readonly<{ kind: "modrm.reg"; modRmLocal: number; width: OperandWidth }>
  | Readonly<{ kind: "rm"; modRmLocal: number; addressLocal: number; width: OperandWidth }>
  | Readonly<{ kind: "mem"; addressLocal: number; width: OperandWidth }>
  | Readonly<{ kind: "implicit.reg"; alias: RegisterAlias }>
  | Readonly<{ kind: "imm"; local: number }>
  | Readonly<{ kind: "relTarget"; local: number }>;

export type InterpreterInstructionLength =
  | number
  | Readonly<{ kind: "local"; local: number }>;

export function interpreterSemanticOperandInfo(binding: InterpreterOperandBinding): SemanticOperandInfo {
  switch (binding.kind) {
    case "opcode.reg":
    case "modrm.reg":
    case "implicit.reg":
      return { storage: "reg" };
    case "rm":
      return { storage: "regOrMem" };
    case "mem":
      return { storage: "mem" };
    case "imm":
      return { storage: "imm" };
    case "relTarget":
      return { storage: "relTarget" };
  }
}

export type InterpreterIrEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  state: InterpreterStateCache;
  locals: InterpreterLocals;
  exit: WasmIrExitDestination;
  depths: InterpreterDispatchDepths;
  instructionLength: InterpreterInstructionLength;
  operands: readonly InterpreterOperandBinding[];
}>;

export function emitInterpreterIrWithContext(block: IrBlock, context: InterpreterIrEmitContext): void {
  const aluFlags = wasmIrLocalAluFlagsStorage(context.body, context.state.aluFlagsLocal);
  const expressionBlock = optimizeInterpreterExpressionBlock(
    buildIrExpressionBlock(block),
    {
      canInlineGet: (source) => canInlineGet(context, source),
      storageMayAlias: (write, read) => interpreterStorageRefsMayAlias(context, write, read)
    }
  );

  emitIrExpressionBlockToWasm(expressionBlock, {
    body: context.body,
    scratch: context.scratch,
    emitGet: (source, accessWidth, helpers, options) => emitGetStorage(context, source, accessWidth, helpers, options),
    emitSet: (target, value, accessWidth, helpers) =>
      emitSetStorage(context, target, value, accessWidth, helpers),
    emitMemoryGuard: (op, helpers) =>
      emitMemoryGuard(context, op.address, op.byteLength, op.access, helpers),
    emitAddress: (source) => emitAddress(context, source),
    emitSetFlags: (descriptor, helpers) =>
      emitSetFlags(context.body, aluFlags, descriptor, helpers),
    emitWriteFlags: (descriptor, helpers) =>
      emitWriteFlags(context.body, aluFlags, descriptor, helpers),
    emitFlagsCondition: (cc) => emitFlagsCondition(context.body, aluFlags, cc),
    emitNext: () => emitNext(context),
    emitNextEip: () => emitNextEip(context),
    emitJump: (target, helpers) => emitJump(context, target, helpers),
    emitConditionalJump: (condition, taken, notTaken, helpers) =>
      emitConditionalJump(context, condition, taken, notTaken, helpers),
    emitHostTrap: (vector, helpers) => emitHostTrap(context, vector, helpers)
  });
}

function emitGetStorage(
  context: InterpreterIrEmitContext,
  source: IrStorageExpr,
  accessWidth: OperandWidth,
  helpers: WasmIrEmitHelpers,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  switch (source.kind) {
    case "operand":
      return emitGetOperand(context, source.index, accessWidth, options);
    case "reg":
      return emitLoadRegAlias(context.body, context.state.regs, regAccess(source.reg, accessWidth), options);
    case "mem":
      emitWasmIrLoadGuestUnchecked(
        context.body,
        () => {
          helpers.emitValue(source.address, { requestedWidth: 32 });
        },
        accessWidth,
        options.signed === true
      );
      return signedLoadValueWidth(accessWidth, options);
  }
}

function canInlineGet(context: InterpreterIrEmitContext, source: IrStorageExpr): boolean {
  switch (source.kind) {
    case "reg":
      return true;
    case "mem":
      return false;
    case "operand": {
      const binding = operandBinding(context, source.index);

      return (
        binding.kind === "opcode.reg" ||
        binding.kind === "modrm.reg" ||
        binding.kind === "implicit.reg" ||
        binding.kind === "imm" ||
        binding.kind === "relTarget"
      );
    }
  }
}

type InterpreterStorageAlias =
  | Readonly<{ kind: "memory" }>
  | Readonly<{ kind: "dynamicRegister" }>
  | Readonly<{ kind: "dynamicRm" }>
  | Readonly<{ kind: "fixedRegister"; alias: RegisterAlias }>
  | Readonly<{ kind: "constant" }>;

function interpreterStorageRefsMayAlias(
  context: InterpreterIrEmitContext,
  write: IrStorageExpr,
  read: IrStorageExpr
): boolean {
  const writeAlias = interpreterStorageAlias(context, write);
  const readAlias = interpreterStorageAlias(context, read);

  if (writeAlias.kind === "constant" || readAlias.kind === "constant") {
    return false;
  }

  if (writeAlias.kind === "dynamicRm" || readAlias.kind === "dynamicRm") {
    return true;
  }

  if (writeAlias.kind === "memory" || readAlias.kind === "memory") {
    return writeAlias.kind === "memory" && readAlias.kind === "memory";
  }

  if (writeAlias.kind === "dynamicRegister" || readAlias.kind === "dynamicRegister") {
    return true;
  }

  return registerAliasesMayOverlap(writeAlias.alias, readAlias.alias);
}

function interpreterStorageAlias(
  context: InterpreterIrEmitContext,
  storage: IrStorageExpr
): InterpreterStorageAlias {
  switch (storage.kind) {
    case "reg":
      return { kind: "fixedRegister", alias: regAccess(storage.reg) };
    case "mem":
      return { kind: "memory" };
    case "operand":
      return interpreterOperandAlias(operandBinding(context, storage.index));
  }
}

function interpreterOperandAlias(binding: InterpreterOperandBinding): InterpreterStorageAlias {
  switch (binding.kind) {
    case "opcode.reg":
    case "modrm.reg":
      return { kind: "dynamicRegister" };
    case "rm":
      return { kind: "dynamicRm" };
    case "mem":
      return { kind: "memory" };
    case "implicit.reg":
      return { kind: "fixedRegister", alias: binding.alias };
    case "imm":
    case "relTarget":
      return { kind: "constant" };
  }
}

function emitSetStorage(
  context: InterpreterIrEmitContext,
  target: IrStorageExpr,
  value: IrValueExpr,
  accessWidth: OperandWidth,
  helpers: WasmIrEmitHelpers
): void {
  switch (target.kind) {
    case "operand":
      emitSetOperand(context, target.index, value, accessWidth, helpers);
      return;
    case "reg":
      emitStoreRegAlias(context.body, context.state.regs, regAccess(target.reg, accessWidth), () => helpers.emitValue(value));
      return;
    case "mem":
      emitStoreMem(
        context,
        () => {
          helpers.emitValue(target.address, { requestedWidth: 32 });
        },
        () => helpers.emitValue(value),
        accessWidth
      );
      return;
  }
}

function emitMemoryGuard(
  context: InterpreterIrEmitContext,
  address: IrValueExpr,
  byteLength: number,
  access: IrMemoryAccessKind,
  helpers: WasmIrEmitHelpers
): void {
  if (address.kind === "address" && emitOperandMemoryGuard(context, address.operand, byteLength, access)) {
    return;
  }

  const addressLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    helpers.emitValue(address, { requestedWidth: 32 });
    context.body.localSet(addressLocal);
    emitWasmIrGuardGuestRange(memoryGuardContext(context, access), addressLocal, byteLength);
  } finally {
    context.scratch.freeLocal(addressLocal);
  }
}

function emitOperandMemoryGuard(
  context: InterpreterIrEmitContext,
  operand: OperandRef,
  byteLength: number,
  access: IrMemoryAccessKind
): boolean {
  const binding = operandBinding(context, operand.index);

  switch (binding.kind) {
    case "mem":
      emitWasmIrGuardGuestRange(
        memoryGuardContext(context, access),
        binding.addressLocal,
        byteLength
      );
      return true;
    case "rm":
      emitIfModRmMemory(context.body, binding.modRmLocal, () => {
        emitWasmIrGuardGuestRange(
          memoryGuardContext(context, access),
          binding.addressLocal,
          byteLength,
          { faultExtraDepth: 2 }
        );
      });
      return true;
    case "opcode.reg":
    case "modrm.reg":
    case "implicit.reg":
    case "imm":
    case "relTarget":
      return false;
  }
}

function memoryGuardContext(
  context: InterpreterIrEmitContext,
  access: IrMemoryAccessKind
): Parameters<typeof emitWasmIrGuardGuestRange>[0] {
  return {
    body: context.body,
    emitFaultExit: (fault) => {
      emitWasmIrExitFromI32Stack(context.body, {
        destination: context.exit,
        reason: memoryFaultExitReason(access),
        extraDepth: fault.extraDepth,
        detail: fault.byteLength
      });
    }
  };
}

function memoryFaultExitReason(access: IrMemoryAccessKind): ExitReason {
  switch (access) {
    case "read":
      return ExitReason.MEMORY_READ_FAULT;
    case "write":
      return ExitReason.MEMORY_WRITE_FAULT;
  }
}

function emitAddress(context: InterpreterIrEmitContext, source: IrStorageExpr): void {
  if (source.kind !== "operand") {
    throw new Error(`unsupported address source for Wasm interpreter: ${source.kind}`);
  }

  const binding = operandBinding(context, source.index);

  switch (binding.kind) {
    case "mem":
    case "rm":
      context.body.localGet(binding.addressLocal);
      return;
    case "opcode.reg":
    case "modrm.reg":
    case "implicit.reg":
    case "imm":
    case "relTarget":
      throw new Error(`address operand is not memory: ${binding.kind}`);
  }
}

function emitGetOperand(
  context: InterpreterIrEmitContext,
  index: number,
  accessWidth: OperandWidth,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  const binding = operandBinding(context, index);

  switch (binding.kind) {
    case "opcode.reg":
      return emitLoadDynamicReg(context, binding.width, () => emitOpcodeRegIndex(context.body, binding.opcodeLocal), options);
    case "modrm.reg":
      return emitLoadDynamicReg(context, binding.width, () => emitModRmRegIndex(context.body, binding.modRmLocal), options);
    case "rm":
      return emitGetRm(context, binding, accessWidth, options);
    case "mem":
      emitWasmIrLoadGuestUnchecked(
        context.body,
        () => context.body.localGet(binding.addressLocal),
        accessWidth,
        options.signed === true
      );
      return signedLoadValueWidth(accessWidth, options);
    case "implicit.reg":
      return emitLoadRegAlias(context.body, context.state.regs, binding.alias, options);
    case "imm":
    case "relTarget":
      context.body.localGet(binding.local);
      if (options.signed === true && accessWidth < 32) {
        return emitSignExtendValueToWidth(context.body, accessWidth as 8 | 16);
      }
      if (options.widthInsensitive === true && accessWidth < 32) {
        return dirtyValueWidth(accessWidth);
      }

      return emitMaskValueToWidth(context.body, accessWidth);
  }
}

function emitSetOperand(
  context: InterpreterIrEmitContext,
  index: number,
  value: IrValueExpr,
  accessWidth: OperandWidth,
  helpers: WasmIrEmitHelpers
): void {
  const binding = operandBinding(context, index);

  switch (binding.kind) {
    case "opcode.reg":
      emitStoreDynamicReg(context, binding.width, () => emitOpcodeRegIndex(context.body, binding.opcodeLocal), value, helpers);
      return;
    case "modrm.reg":
      emitStoreDynamicReg(context, binding.width, () => emitModRmRegIndex(context.body, binding.modRmLocal), value, helpers);
      return;
    case "rm":
      emitSetRm(context, binding, value, accessWidth, helpers);
      return;
    case "mem":
      emitStoreMem(
        context,
        () => {
          context.body.localGet(binding.addressLocal);
        },
        () => helpers.emitValue(value),
        accessWidth
      );
      return;
    case "implicit.reg":
      emitStoreRegAlias(context.body, context.state.regs, binding.alias, () => helpers.emitValue(value));
      return;
    case "imm":
    case "relTarget":
      throw new Error(`cannot set ${binding.kind} operand`);
  }
}

function emitNext(context: InterpreterIrEmitContext): void {
  if (typeof context.instructionLength === "number") {
    emitCompleteInstruction(context.body, context.state, context.instructionLength);
  } else {
    emitCompleteInstructionWithTarget(context.body, context.state, () => emitNextEip(context));
  }
  emitContinue(context);
}

function emitNextEip(context: InterpreterIrEmitContext): void {
  context.body.localGet(context.locals.eip);

  if (typeof context.instructionLength === "number") {
    context.body.i32Const(context.instructionLength);
  } else {
    context.body.localGet(context.instructionLength.local);
  }

  context.body.i32Add();
}

function emitJump(context: InterpreterIrEmitContext, target: IrValueExpr, helpers: WasmIrEmitHelpers): void {
  emitCompleteInstructionWithTarget(context.body, context.state, () => {
    helpers.emitValue(target, { requestedWidth: 32 });
  });
  emitContinue(context);
}

function emitConditionalJump(
  context: InterpreterIrEmitContext,
  condition: IrValueExpr,
  taken: IrValueExpr,
  notTaken: IrValueExpr,
  helpers: WasmIrEmitHelpers
): void {
  helpers.emitValue(condition, { requestedWidth: 32 });
  context.body.ifBlock();
  emitCompleteInstructionWithTarget(context.body, context.state, () => {
    helpers.emitValue(taken, { requestedWidth: 32 });
  });
  emitContinue(context, 1);
  context.body.endBlock();
  emitCompleteInstructionWithTarget(context.body, context.state, () => {
    helpers.emitValue(notTaken, { requestedWidth: 32 });
  });
  emitContinue(context);
}

function emitHostTrap(context: InterpreterIrEmitContext, vector: IrValueExpr, helpers: WasmIrEmitHelpers): void {
  if (typeof context.instructionLength === "number") {
    emitCompleteInstruction(context.body, context.state, context.instructionLength);
  } else {
    emitCompleteInstructionWithTarget(context.body, context.state, () => emitNextEip(context));
  }

  helpers.emitValue(vector, { requestedWidth: 32 });
  emitWasmIrExitFromI32Stack(context.body, {
    destination: context.exit,
    reason: ExitReason.HOST_TRAP
  });
}

function emitContinue(context: InterpreterIrEmitContext, extraDepth = 0): void {
  context.body.br(context.depths.instructionDone + extraDepth);
}

function emitGetRm(
  context: InterpreterIrEmitContext,
  binding: Extract<InterpreterOperandBinding, { kind: "rm" }>,
  accessWidth: OperandWidth,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  emitModRmIsRegister(context.body, binding.modRmLocal);
  context.body.ifBlock(undefined, wasmValueType.i32);
  emitLoadRegByIndex(context.body, context.state.regs, binding.width, () => {
    emitModRmRmIndex(context.body, binding.modRmLocal);
  }, options);
  context.body.elseBlock();
  emitWasmIrLoadGuestUnchecked(
    context.body,
    () => context.body.localGet(binding.addressLocal),
    accessWidth,
    options.signed === true
  );
  context.body.endBlock();
  return signedLoadValueWidth(accessWidth, options);
}

function signedLoadValueWidth(width: OperandWidth, options: WasmIrEmitValueOptions): ValueWidth {
  if (options.signed === true && width < 32) {
    return cleanValueWidth(32);
  }

  return options.widthInsensitive === true && width < 32 ? dirtyValueWidth(width) : cleanValueWidth(width);
}

function emitSetRm(
  context: InterpreterIrEmitContext,
  binding: Extract<InterpreterOperandBinding, { kind: "rm" }>,
  value: IrValueExpr,
  accessWidth: OperandWidth,
  helpers: WasmIrEmitHelpers
): void {
  const valueLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    const valueWidth = helpers.emitValue(value);
    context.body.localSet(valueLocal);
    emitIfModRmRegister(context.body, binding.modRmLocal, () => {
      emitStoreRegByIndex(context.body, context.state.regs, binding.width, () => {
        emitModRmRmIndex(context.body, binding.modRmLocal);
      }, valueLocal, valueWidth);
    });
    emitIfModRmMemory(context.body, binding.modRmLocal, () => {
      emitStoreMem(
        context,
        () => {
          context.body.localGet(binding.addressLocal);
        },
        () => {
          context.body.localGet(valueLocal);
          return valueWidth;
        },
        accessWidth
      );
    });
  } finally {
    context.scratch.freeLocal(valueLocal);
  }
}

function emitStoreMem(
  context: InterpreterIrEmitContext,
  emitAddress: () => void,
  emitValue: () => ValueWidth,
  width: OperandWidth
): void {
  emitWasmIrStoreGuestUnchecked(
    context.body,
    emitAddress,
    () => {
      const valueWidth = emitValue();

      if (width === 32) {
        emitCleanValueForFullUse(context.body, valueWidth);
      }
    },
    width
  );
}

function operandBinding(context: InterpreterIrEmitContext, index: number): InterpreterOperandBinding {
  const binding = context.operands[index];

  if (binding === undefined) {
    throw new Error(`missing interpreter operand binding: ${index}`);
  }

  return binding;
}

function regAccess(reg: RegisterAlias["name"], accessWidth: OperandWidth = 32): RegisterAlias {
  const alias = registerAlias(reg);

  return alias.width === 32
    ? { ...alias, width: accessWidth }
    : alias;
}

function registerAliasesMayOverlap(left: RegisterAlias, right: RegisterAlias): boolean {
  return left.base === right.base &&
    left.bitOffset < right.bitOffset + right.width &&
    right.bitOffset < left.bitOffset + left.width;
}

function emitLoadDynamicReg(
  context: InterpreterIrEmitContext,
  width: OperandWidth,
  emitIndex: () => void,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  return emitLoadRegByIndex(context.body, context.state.regs, width, emitIndex, options);
}

function emitStoreDynamicReg(
  context: InterpreterIrEmitContext,
  width: OperandWidth,
  emitIndex: () => void,
  value: IrValueExpr,
  helpers: WasmIrEmitHelpers
): void {
  const valueLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    const valueWidth = helpers.emitValue(value);
    context.body.localSet(valueLocal);
    emitStoreRegByIndex(context.body, context.state.regs, width, emitIndex, valueLocal, valueWidth);
  } finally {
    context.scratch.freeLocal(valueLocal);
  }
}
