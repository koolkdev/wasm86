import type { RegisterAlias, Reg32 } from "#x86/isa/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { i32 } from "#x86/state/cpu-state.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { ExitReason, type ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import { emitWasmIrLoadGuestFromStack, emitWasmIrStoreGuest } from "#backends/wasm/codegen/memory.js";
import type { WasmIrEmitHelpers } from "#backends/wasm/codegen/emit.js";
import type { JitExitPoint } from "#backends/wasm/jit/codegen/plan/types.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type { JitTimelineOpContext } from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import type { JitInstructionEmitContext } from "./block-emitter.js";
import { emitJitValue } from "./jit-values.js";
import { emitJitInputSlot, emitJitInputSlotBits } from "./input-slots.js";
import {
  cleanValueWidth,
  constValueWidth,
  dirtyValueWidth,
  emitCleanValueForFullUse,
  emitMaskValueToWidth,
  emitSignExtendValueToWidth,
  maskedConstValue,
  type WasmIrEmitValueOptions,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import type { JitValue } from "#backends/wasm/jit/ir/values.js";

type NormalizedStorage =
  | NormalizedRegisterStorage
  | NormalizedMemoryStorage
  | NormalizedImmediateStorage;

type NormalizedRegisterStorage = Readonly<{
  kind: "reg";
  alias: RegisterAlias;
}>;

type NormalizedMemoryStorage = Readonly<{
  kind: "mem";
  address: NormalizedMemoryAddress;
  accessWidth: OperandWidth;
}>;

type NormalizedMemoryAddress =
  | Readonly<{ kind: "expression"; value: IrValueExpr }>
  | Readonly<{ kind: "jitValue"; value: JitValue }>;

type NormalizedImmediateStorage = Readonly<{
  kind: "imm";
  immediateKind: "imm32" | "relTarget";
  value: number;
  accessWidth: OperandWidth;
}>;

export function emitJitGet(
  context: JitInstructionEmitContext,
  timelineOp: JitTimelineOpContext,
  source: IrStorageExpr,
  accessWidth: OperandWidth,
  helpers: WasmIrEmitHelpers,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  return emitNormalizedRead(
    context,
    timelineOp,
    normalizeStorage(context, timelineOp, source, accessWidth, "read"),
    helpers,
    options
  );
}

export function emitJitSet(
  context: JitInstructionEmitContext,
  timelineOp: JitTimelineOpContext,
  target: IrStorageExpr,
  value: IrValueExpr,
  accessWidth: OperandWidth,
  helpers: WasmIrEmitHelpers
): void {
  emitNormalizedWrite(
    context,
    timelineOp,
    normalizeStorage(context, timelineOp, target, accessWidth, "write"),
    value,
    helpers
  );
}

export function emitJitAddress(
  context: JitInstructionEmitContext,
  timelineOp: JitTimelineOpContext,
  source: IrStorageExpr,
  helpers: WasmIrEmitHelpers
): void {
  const storage = normalizeStorage(context, timelineOp, source, 32, "address");

  if (storage.kind !== "mem") {
    throw new Error(`address source is not memory: ${storage.kind}`);
  }

  emitMemoryAddress(context, storage.address, helpers);
}

function normalizeStorage(
  context: JitInstructionEmitContext,
  timelineOp: JitTimelineOpContext,
  storage: IrStorageExpr,
  accessWidth: OperandWidth,
  access: string
): NormalizedStorage {
  switch (storage.kind) {
    case "reg":
      return {
        kind: "reg",
        alias: regAccess(storage.reg, accessWidth)
      };
    case "mem":
      return {
        kind: "mem",
        address: { kind: "expression", value: storage.address },
        accessWidth
      };
    case "operand":
      return normalizeOperandStorage(context, timelineOp, storage, accessWidth, access);
  }
}

function normalizeOperandStorage(
  context: JitInstructionEmitContext,
  timelineOp: JitTimelineOpContext,
  operand: Readonly<{ kind: "operand"; index: number }>,
  accessWidth: OperandWidth,
  access: string
): NormalizedStorage {
  const binding = operandBinding(context, operand.index);

  switch (binding.kind) {
    case "static.reg":
      assertAccessWidth(accessWidth, binding.alias.width, access);
      return {
        kind: "reg",
        alias: binding.alias
      };
    case "static.mem":
      return {
        kind: "mem",
        address: {
          kind: "jitValue",
          value: requiredResolvedJitValue(
            timelineOp.valueForEffectiveAddress(operand),
            `JIT effective address operand ${operand.index}`
          )
        },
        accessWidth
      };
    case "static.imm32":
      return {
        kind: "imm",
        immediateKind: "imm32",
        value: binding.value,
        accessWidth
      };
    case "static.relTarget":
      return {
        kind: "imm",
        immediateKind: "relTarget",
        value: binding.target,
        accessWidth
      };
  }
}

function emitNormalizedRead(
  context: JitInstructionEmitContext,
  timelineOp: JitTimelineOpContext,
  storage: NormalizedStorage,
  helpers: WasmIrEmitHelpers,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  switch (storage.kind) {
    case "reg":
      return emitRegisterStorageValue(context, timelineOp, storage, options);
    case "mem":
      emitMemoryAddress(context, storage.address, helpers);
      emitLoadGuestFromStack(context, storage.accessWidth, options.signed === true);
      return signedLoadValueWidth(storage.accessWidth, options);
    case "imm":
      return emitImmediateValue(context, storage, options);
  }
}

function emitNormalizedWrite(
  context: JitInstructionEmitContext,
  timelineOp: JitTimelineOpContext,
  storage: NormalizedStorage,
  value: IrValueExpr,
  helpers: WasmIrEmitHelpers
): void {
  switch (storage.kind) {
    case "reg":
      assertSymbolicRegisterWrite(timelineOp, storage.alias);
      break;
    case "mem":
      emitStoreMem(
        context,
        () => emitMemoryAddress(context, storage.address, helpers),
        () => helpers.emitValue(value),
        storage.accessWidth
      );
      break;
    case "imm":
      throw new Error(`cannot set ${storage.immediateKind} operand`);
  }
}

function emitImmediateValue(
  context: JitInstructionEmitContext,
  immediate: NormalizedImmediateStorage,
  options: WasmIrEmitValueOptions
): ValueWidth {
  if (immediate.immediateKind === "relTarget") {
    context.body.i32Const(i32(immediate.value));
    return constValueWidth(immediate.value);
  }

  if (options.signed === true && immediate.accessWidth < 32) {
    context.body.i32Const(i32(immediate.value));
    return emitSignExtendValueToWidth(context.body, immediate.accessWidth as 8 | 16);
  }

  if (options.widthInsensitive !== true && immediate.accessWidth < 32) {
    const masked = maskedConstValue(immediate.value, immediate.accessWidth);

    context.body.i32Const(masked);
    return constValueWidth(masked);
  }

  context.body.i32Const(i32(immediate.value));
  return options.widthInsensitive === true && immediate.accessWidth < 32
    ? dirtyValueWidth(immediate.accessWidth)
    : emitMaskValueToWidth(context.body, immediate.accessWidth, constValueWidth(immediate.value));
}

function emitMemoryAddress(
  context: JitInstructionEmitContext,
  address: NormalizedMemoryAddress,
  helpers: WasmIrEmitHelpers
): void {
  switch (address.kind) {
    case "expression":
      helpers.emitValue(address.value, { requestedWidth: 32 });
      return;
    case "jitValue":
      emitResolvedJitValue(context, address.value, { requestedWidth: 32 });
      return;
  }
}

function emitLoadGuestFromStack(
  context: JitInstructionEmitContext,
  width: OperandWidth,
  signed = false
): void {
  const addressLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    const exitPoint = prepareMemoryFaultExit(context, ExitReason.MEMORY_READ_FAULT);

    emitWasmIrLoadGuestFromStack(context, addressLocal, width, 1, signed);
    context.completeExitPoint(exitPoint);
  } finally {
    context.scratch.freeLocal(addressLocal);
  }
}

function signedLoadValueWidth(width: OperandWidth, options: WasmIrEmitValueOptions): ValueWidth {
  if (options.signed === true && width < 32) {
    return cleanValueWidth(32);
  }

  return cleanValueWidth(width);
}

function emitStoreMem(
  context: JitInstructionEmitContext,
  emitAddress: () => void,
  emitValue: () => ValueWidth,
  width: OperandWidth,
  faultExtraDepth = 1
): void {
  const addressLocal = context.scratch.allocLocal(wasmValueType.i32);
  const valueLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    emitAddress();
    context.body.localSet(addressLocal);
    const valueWidth = emitValue();
    if (width === 32) {
      emitCleanValueForFullUse(context.body, valueWidth);
    }
    context.body.localSet(valueLocal);
    const exitPoint = prepareMemoryFaultExit(context, ExitReason.MEMORY_WRITE_FAULT);

    emitWasmIrStoreGuest(context, addressLocal, valueLocal, width, faultExtraDepth);
    context.completeExitPoint(exitPoint);
  } finally {
    context.scratch.freeLocal(valueLocal);
    context.scratch.freeLocal(addressLocal);
  }
}

function regAccess(reg: Reg32, width: OperandWidth): RegisterAlias {
  return { name: reg, base: reg, bitOffset: 0, width };
}

function assertAccessWidth(actual: OperandWidth, expected: OperandWidth, access: string): void {
  if (actual !== expected) {
    throw new Error(`JIT ${access} width mismatch: ${actual} !== ${expected}`);
  }
}

function prepareMemoryFaultExit(
  context: JitInstructionEmitContext,
  exitReason: ExitReasonValue
): JitExitPoint {
  const exitPoint = context.currentExitPoint(exitReason);

  context.state.prepareExitPoint(exitPoint, () => {
    context.body.i32Const(i32(context.currentInstruction().eip));
  });

  return exitPoint;
}

function operandBinding(context: JitInstructionEmitContext, index: number): JitOperandBinding {
  const binding = context.currentInstruction().operands[index];

  if (binding === undefined) {
    throw new Error(`missing JIT operand binding: ${index}`);
  }

  return binding;
}

function emitRegisterStorageValue(
  context: JitInstructionEmitContext,
  timelineOp: JitTimelineOpContext,
  source: NormalizedRegisterStorage,
  options: WasmIrEmitValueOptions
): ValueWidth {
  return emitResolvedJitValue(
    context,
    timelineOp.valueForRegisterAlias(source.alias, options.signed === true),
    options
  );
}

function assertSymbolicRegisterWrite(
  timelineOp: JitTimelineOpContext,
  target: RegisterAlias
): void {
  if (!timelineOp.hasRegisterWrite(target)) {
    throw new Error(`JIT register write has no value-state timeline entry for ${target.name} at expression op ${timelineOp.expressionOpIndex}`);
  }
}

function emitResolvedJitValue(
  context: JitInstructionEmitContext,
  value: JitValue,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  return emitJitValue({
    body: context.body,
    valueCache: context.valueCache,
    emitInput: (slot) => emitJitInputSlot(context.body, slot),
    emitInputBits: (slot, bitOffset, width, signed) =>
      emitJitInputSlotBits(context.body, slot, bitOffset, width, signed)
  }, value, options);
}

function requiredResolvedJitValue(value: JitValue | undefined, context: string): JitValue {
  if (value === undefined) {
    throw new Error(`${context} is not available in the JIT value timeline`);
  }

  return value;
}
