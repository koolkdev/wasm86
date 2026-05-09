import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import {
  cleanValueWidth,
  constValueWidth,
  emitCleanValueForFullUse,
  emitMaskValueToWidth,
  emitSignExtendValueToWidth,
  i32BinaryResultValueWidth,
  i32SelectResultValueWidth,
  type ValueWidth,
  type WasmIrEmitValueOptions
} from "#backends/wasm/codegen/value-width.js";
import { emitAluFlagsConditionFromValue, emitFlagProducerCondition } from "#backends/wasm/codegen/conditions.js";
import { emitFlagProducerBits } from "#backends/wasm/codegen/flags.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import { conditionFlagReadMask } from "#x86/ir/model/flag-effects.js";
import { flagProducerConditionKind } from "#x86/ir/model/flag-conditions.js";
import { i32 } from "#x86/state/cpu-state.js";
import { widthMask, type OperandWidth, type Reg32 } from "#x86/isa/types.js";
import type { ConditionCode, IrBinaryOperator, IrUnaryOperator, ValueRef } from "#x86/ir/model/types.js";
import {
  simplifyJitValue,
  type JitArchitecturalSlot,
  type JitFlagProducerValue,
  type JitInputValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import type { JitValueCacheRuntime } from "./value-local-store.js";

export type JitValueEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  valueCache?: JitValueCacheRuntime | undefined;
  emitInput(slot: JitArchitecturalSlot): ValueWidth;
  emitReg?(reg: Reg32): ValueWidth;
}>;

export function emitJitValue(
  context: JitValueEmitContext,
  value: JitValue,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  const simplified = simplifyJitValue(value);
  const valueWidth = context.valueCache === undefined
    ? emitJitValueUncached(context, simplified)
    : context.valueCache.emitJitValueForUse(simplified, () => emitJitValueUncached(context, simplified)).valueWidth;

  return applyRequestedWidth(context.body, valueWidth, options);
}

export function emitMaskedJitValue(
  context: JitValueEmitContext,
  value: JitValue,
  width: OperandWidth
): ValueWidth {
  return emitMaskValueToWidth(context.body, width, emitJitValue(context, value));
}

function emitJitValueUncached(context: JitValueEmitContext, value: JitValue): ValueWidth {
  switch (value.kind) {
    case "const":
      context.body.i32Const(i32(value.value));
      return constValueWidth(value.value);
    case "reg":
      return emitJitReg(context, value.reg);
    case "input":
      return emitJitInput(context, value);
    case "value.binary":
      return emitI32Binary(context, value.operator, value.a, value.b);
    case "value.unary":
      return emitI32Unary(context, value.operator, value.value);
    case "value.select":
      return emitI32Select(context, value.condition, value.whenTrue, value.whenFalse);
    case "extractBits":
      return emitExtractBits(context, value.value, value.bitOffset, value.width);
    case "insertBits":
      return emitInsertBits(context, value.base, value.value, value.bitOffset, value.width);
    case "extractMaskedBits":
      return emitExtractMaskedBits(context, value.value, value.mask);
    case "insertMaskedBits":
      return emitInsertMaskedBits(context, value.base, value.value, value.mask);
    case "flagProducer":
      return emitFlagProducerValue(context, value);
    case "flagCondition":
      return emitFlagConditionValue(context, value.flags, value.cc);
  }
}

function emitJitReg(context: JitValueEmitContext, reg: Reg32): ValueWidth {
  return (context.emitReg ?? ((inputReg: Reg32) =>
    context.emitInput({ kind: "reg32", reg: inputReg })))(reg);
}

function emitJitInput(context: JitValueEmitContext, value: JitInputValue): ValueWidth {
  return context.emitInput(value.slot);
}

function emitI32Binary(context: JitValueEmitContext, operator: IrBinaryOperator, a: JitValue, b: JitValue): ValueWidth {
  const operandOptions = i32BinaryOperandEmitOptions(operator);
  const left = emitJitValue(context, a, operandOptions);
  const right = emitJitValue(context, b, operandOptions);

  emitI32BinaryInstruction(context.body, operator);
  return i32BinaryResultValueWidth(operator, left, right);
}

function emitI32BinaryInstruction(body: WasmFunctionBodyEncoder, operator: IrBinaryOperator): void {
  switch (operator) {
    case "add":
      body.i32Add();
      return;
    case "sub":
      body.i32Sub();
      return;
    case "xor":
      body.i32Xor();
      return;
    case "or":
      body.i32Or();
      return;
    case "and":
      body.i32And();
      return;
    case "shr_u":
      body.i32ShrU();
      return;
  }
}

function emitI32Unary(context: JitValueEmitContext, operator: IrUnaryOperator, value: JitValue): ValueWidth {
  switch (operator) {
    case "extend8_s":
      emitJitValue(context, value, { widthInsensitive: true });
      return emitSignExtendValueToWidth(context.body, 8);
    case "extend16_s":
      emitJitValue(context, value, { widthInsensitive: true });
      return emitSignExtendValueToWidth(context.body, 16);
  }
}

function emitI32Select(context: JitValueEmitContext, condition: JitValue, whenTrue: JitValue, whenFalse: JitValue): ValueWidth {
  const trueWidth = emitJitValue(context, whenTrue);
  const falseWidth = emitJitValue(context, whenFalse);
  const conditionWidth = emitJitValue(context, condition, { requestedWidth: 32 });

  context.body.select();
  return i32SelectResultValueWidth(conditionWidth, trueWidth, falseWidth);
}

function emitExtractBits(
  context: JitValueEmitContext,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth
): ValueWidth {
  const valueWidth = emitJitValue(context, value, bitOffset === 0 ? { widthInsensitive: true } : { requestedWidth: 32 });

  if (bitOffset !== 0) {
    context.body.i32Const(bitOffset).i32ShrU();
  }

  return width === 32
    ? cleanValueWidth(32)
    : emitMaskValueToWidth(context.body, width, bitOffset === 0 ? valueWidth : cleanValueWidth(32));
}

function emitInsertBits(
  context: JitValueEmitContext,
  base: JitValue,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth
): ValueWidth {
  if (bitOffset === 0 && width === 32) {
    return emitJitValue(context, value, { requestedWidth: 32 });
  }

  const mask = bitRangeMask(bitOffset, width);

  emitJitValue(context, base, { requestedWidth: 32 });
  context.body.i32Const(i32(~mask)).i32And();
  emitMaskedJitValue(context, value, width);

  if (bitOffset !== 0) {
    context.body.i32Const(bitOffset).i32Shl();
  }

  context.body.i32Or();
  return cleanValueWidth(32);
}

function emitExtractMaskedBits(context: JitValueEmitContext, value: JitValue, mask: number): ValueWidth {
  emitJitValue(context, value, { widthInsensitive: true });
  context.body.i32Const(i32(mask)).i32And();
  return cleanValueWidth(32);
}

function emitInsertMaskedBits(context: JitValueEmitContext, base: JitValue, value: JitValue, mask: number): ValueWidth {
  emitJitValue(context, base, { requestedWidth: 32 });
  context.body.i32Const(i32(~mask)).i32And();
  emitJitValue(context, value, { widthInsensitive: true });
  context.body.i32Const(i32(mask)).i32And();
  context.body.i32Or();
  return cleanValueWidth(32);
}

function emitFlagProducerValue(context: JitValueEmitContext, value: JitFlagProducerValue): ValueWidth {
  const flagProducer = FLAG_PRODUCERS[value.producer];
  const inputs = syntheticFlagInputs(value);

  emitFlagProducerBits(
    context.body,
    {
      op: "flags.set",
      producer: value.producer,
      ...(value.width === undefined ? {} : { width: value.width }),
      writtenMask: flagProducer.writtenMask,
      undefMask: flagProducer.undefMask,
      inputs: inputs.refs
    },
    syntheticInputHelpers(context, inputs.byVarId, "symbolic flag producer input"),
    value.mask
  );
  return cleanValueWidthForMask(value.mask);
}

function emitFlagConditionValue(
  context: JitValueEmitContext,
  flags: JitValue,
  cc: ConditionCode
): ValueWidth {
  const simplifiedFlags = simplifyJitValue(flags);

  if (emitRoutedFlagCondition(context, simplifiedFlags, cc)) {
    return cleanValueWidth(8);
  }

  emitAluFlagsConditionFromValue(context.body, cc, (mask) => {
    emitFlagBitsForMask(context, simplifiedFlags, mask);
  });
  return cleanValueWidth(8);
}

function emitRoutedFlagCondition(
  context: JitValueEmitContext,
  flags: JitValue,
  cc: ConditionCode
): boolean {
  const simplifiedFlags = simplifyJitValue(flags);
  const readMask = conditionFlagReadMask(cc);

  if (simplifiedFlags.kind === "flagProducer" && canEmitDirectFlagProducerCondition(simplifiedFlags, cc, readMask)) {
    emitDirectFlagProducerCondition(context, simplifiedFlags, cc);
    return true;
  }

  if (simplifiedFlags.kind === "insertMaskedBits") {
    const insertedMask = simplifiedFlags.mask >>> 0;

    if ((readMask & ~insertedMask) === 0) {
      return emitRoutedFlagCondition(context, simplifiedFlags.value, cc);
    }

    if ((readMask & insertedMask) === 0) {
      return emitRoutedFlagCondition(context, simplifiedFlags.base, cc);
    }
  }

  return false;
}

function canEmitDirectFlagProducerCondition(
  value: JitFlagProducerValue,
  cc: ConditionCode,
  readMask: number
): boolean {
  return flagProducerConditionKind({
    producer: value.producer,
    width: value.width,
    cc
  }) !== undefined && (readMask & ~value.mask) === 0;
}

function emitFlagBitsForMask(
  context: JitValueEmitContext,
  flags: JitValue,
  readMask: number,
  forceMasked = false
): ValueWidth {
  const normalizedReadMask = readMask >>> 0;

  if (normalizedReadMask === 0) {
    context.body.i32Const(0);
    return cleanValueWidth(8, 0);
  }

  const simplifiedFlags = simplifyJitValue(flags);

  if (simplifiedFlags.kind === "insertMaskedBits") {
    const insertedMask = simplifiedFlags.mask >>> 0;
    const insertedReadMask = normalizedReadMask & insertedMask;
    const baseReadMask = normalizedReadMask & ~insertedMask;

    if (insertedReadMask === 0) {
      return emitFlagBitsForMask(context, simplifiedFlags.base, normalizedReadMask, forceMasked);
    }

    if (baseReadMask === 0) {
      return emitFlagBitsForMask(context, simplifiedFlags.value, normalizedReadMask, forceMasked);
    }

    emitFlagBitsForMask(context, simplifiedFlags.base, baseReadMask, true);
    emitFlagBitsForMask(context, simplifiedFlags.value, insertedReadMask, true);
    context.body.i32Or();
    return cleanValueWidthForMask(normalizedReadMask);
  }

  if (simplifiedFlags.kind === "flagProducer") {
    const producedReadMask = normalizedReadMask & (simplifiedFlags.mask >>> 0);

    if (producedReadMask === 0) {
      context.body.i32Const(0);
      return cleanValueWidth(8, 0);
    }

    return emitFlagProducerValue(context, producedReadMask === simplifiedFlags.mask
      ? simplifiedFlags
      : { ...simplifiedFlags, mask: producedReadMask });
  }

  const valueWidth = emitJitValue(context, simplifiedFlags, { requestedWidth: 32 });

  if (!forceMasked) {
    return valueWidth;
  }

  context.body.i32Const(i32(normalizedReadMask)).i32And();
  return cleanValueWidthForMask(normalizedReadMask);
}

function emitDirectFlagProducerCondition(
  context: JitValueEmitContext,
  value: JitFlagProducerValue,
  cc: ConditionCode
): void {
  const flagProducer = FLAG_PRODUCERS[value.producer];
  const inputs = syntheticFlagInputs(value);

  emitFlagProducerCondition(
    context.body,
    {
      kind: "flagProducer.condition",
      cc,
      producer: value.producer,
      ...(value.width === undefined ? {} : { width: value.width }),
      writtenMask: flagProducer.writtenMask,
      undefMask: flagProducer.undefMask,
      inputs: inputs.refs
    },
    syntheticInputHelpers(context, inputs.byVarId, "symbolic flag condition input")
  );
}

function syntheticFlagInputs(value: JitFlagProducerValue): Readonly<{
  refs: Readonly<Record<string, ValueRef>>;
  byVarId: ReadonlyMap<number, JitValue>;
}> {
  const refs: Record<string, ValueRef> = {};
  const byVarId = new Map<number, JitValue>();
  const inputNames = FLAG_PRODUCERS[value.producer].inputs;

  for (let index = 0; index < inputNames.length; index += 1) {
    const inputName = inputNames[index]!;
    const input = value.inputs[inputName];

    if (input === undefined) {
      throw new Error(`missing symbolic flag input '${inputName}' for ${value.producer}`);
    }

    refs[inputName] = { kind: "var", id: index };
    byVarId.set(index, input);
  }

  return { refs, byVarId };
}

function syntheticInputHelpers(
  context: JitValueEmitContext,
  byVarId: ReadonlyMap<number, JitValue>,
  label: string
) {
  return {
    emitValue: (value: IrValueExpr, options?: WasmIrEmitValueOptions) =>
      emitSyntheticInputValue(context, byVarId, value, label, options),
    emitMaskedValue: (value: IrValueExpr, width: OperandWidth) =>
      emitMaskValueToWidth(context.body, width, emitSyntheticInputValue(context, byVarId, value, label))
  };
}

function emitSyntheticInputValue(
  context: JitValueEmitContext,
  byVarId: ReadonlyMap<number, JitValue>,
  value: IrValueExpr,
  label: string,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  switch (value.kind) {
    case "var": {
      const input = byVarId.get(value.id);

      if (input === undefined) {
        throw new Error(`missing ${label}: ${value.id}`);
      }

      return emitJitValue(context, input, options);
    }
    case "const":
      context.body.i32Const(i32(value.value));
      return applyRequestedWidth(context.body, constValueWidth(value.value), options);
    case "nextEip":
      throw new Error(`nextEip is not a valid ${label}`);
    default:
      throw new Error(`unsupported ${label}: ${value.kind}`);
  }
}

function applyRequestedWidth(
  body: WasmFunctionBodyEncoder,
  valueWidth: ValueWidth,
  options: WasmIrEmitValueOptions
): ValueWidth {
  if (options.requestedWidth === undefined) {
    return valueWidth;
  }

  return options.requestedWidth === 32
    ? emitCleanValueForFullUse(body, valueWidth)
    : emitMaskValueToWidth(body, options.requestedWidth, valueWidth);
}

function bitRangeMask(bitOffset: number, width: OperandWidth): number {
  return width === 32 ? 0xffff_ffff : ((widthMask(width) << bitOffset) >>> 0);
}

function cleanValueWidthForMask(mask: number): ValueWidth {
  const normalized = mask >>> 0;

  if (normalized <= 0xff) {
    return cleanValueWidth(8);
  }

  if (normalized <= 0xffff) {
    return cleanValueWidth(16);
  }

  return cleanValueWidth(32);
}

function i32BinaryOperandEmitOptions(operator: IrBinaryOperator): WasmIrEmitValueOptions {
  switch (operator) {
    case "add":
    case "sub":
    case "shr_u":
      return { requestedWidth: 32 };
    case "xor":
    case "or":
    case "and":
      return { widthInsensitive: true };
  }
}
