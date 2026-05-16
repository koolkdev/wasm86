import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import {
  applyRequestedValueWidth,
  emitI32BinaryInstruction,
  i32BinaryOperandEmitOptions
} from "#backends/wasm/codegen/emit.js";
import {
  cleanValueWidth,
  constValueWidth,
  emitMaskValueToWidth,
  emitSignExtendValueToWidth,
  i32BinaryResultValueWidth,
  i32SelectResultValueWidth,
  type ValueWidth,
  type WasmIrEmitValueOptions
} from "#backends/wasm/codegen/value-width.js";
import { emitFlagsConditionFromAluFlagsValue, emitFlagProducerConditionFromInputs } from "#backends/wasm/codegen/conditions.js";
import { emitFlagProducerBitsFromInputs, type WasmFlagValueEmitHelpers } from "#backends/wasm/codegen/flags.js";
import { conditionFlagReadMask } from "#x86/ir/model/flag-effects.js";
import { flagProducerConditionKind } from "#x86/ir/model/flag-conditions.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { ConditionCode, IrBinaryOperator, IrUnaryOperator } from "#x86/ir/model/types.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import { bitRangeMask } from "#backends/wasm/jit/ir/values/bits.js";
import type {
  JitCanonicalInputSlot,
  JitFlagProducerValue,
  JitInputValue,
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { ValueCache } from "./cache.js";

export type JitValueEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  valueCache?: ValueCache | undefined;
  emitInput(slot: JitCanonicalInputSlot): ValueWidth;
  emitInputBits?: ((
    slot: JitCanonicalInputSlot,
    bitOffset: number,
    width: OperandWidth,
    signed: boolean
  ) => ValueWidth | undefined) | undefined;
  emitProduced?(value: JitProducedValue): ValueWidth;
}>;

export function emitJitValue(
  context: JitValueEmitContext,
  value: JitValue,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  const simplified = simplifyValue(value);
  const valueWidth = context.valueCache === undefined
    ? emitJitValueUncached(context, simplified)
    : context.valueCache.emitForUse(simplified, () => emitJitValueUncached(context, simplified)).valueWidth;

  return applyRequestedValueWidth(context.body, valueWidth, options);
}

export function emitJitValueWithoutRootCache(
  context: JitValueEmitContext,
  value: JitValue,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  const valueWidth = emitJitValueUncached(context, simplifyValue(value));

  return applyRequestedValueWidth(context.body, valueWidth, options);
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
    case "input":
      return emitJitInput(context, value);
    case "produced":
      return emitJitProduced(context, value);
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

function emitJitProduced(context: JitValueEmitContext, value: JitProducedValue): ValueWidth {
  if (context.emitProduced === undefined) {
    throw new Error(`produced JIT value is not available for lowering: ${value.id}`);
  }

  return context.emitProduced(value);
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

function emitI32Unary(context: JitValueEmitContext, operator: IrUnaryOperator, value: JitValue): ValueWidth {
  switch (operator) {
    case "extend8_s":
      return emitI32SignExtend(context, value, 8);
    case "extend16_s":
      return emitI32SignExtend(context, value, 16);
  }
}

function emitI32SignExtend(context: JitValueEmitContext, value: JitValue, width: 8 | 16): ValueWidth {
  const inputBits = emitSignExtendInputExtractBits(context, value, width);

  if (inputBits !== undefined) {
    return inputBits;
  }

  emitJitValue(context, value, { widthInsensitive: true });
  return emitSignExtendValueToWidth(context.body, width);
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
  const inputBits = emitInputExtractBits(context, value, bitOffset, width, false);

  if (inputBits !== undefined) {
    return inputBits;
  }

  const valueWidth = emitJitValue(context, value, bitOffset === 0 ? { widthInsensitive: true } : { requestedWidth: 32 });

  if (bitOffset !== 0) {
    context.body.i32Const(bitOffset).i32ShrU();
  }

  return width === 32
    ? cleanValueWidth(32)
    : emitMaskValueToWidth(context.body, width, bitOffset === 0 ? valueWidth : cleanValueWidth(32));
}

function emitInputExtractBits(
  context: JitValueEmitContext,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth,
  signed: boolean
): ValueWidth | undefined {
  const simplified = simplifyValue(value);

  if (
    simplified.kind !== "input" ||
    context.valueCache?.canEmitInline(simplified) === false
  ) {
    return undefined;
  }

  return context.emitInputBits?.(simplified.slot, bitOffset, width, signed);
}

function emitSignExtendInputExtractBits(
  context: JitValueEmitContext,
  value: JitValue,
  width: 8 | 16
): ValueWidth | undefined {
  const simplified = simplifyValue(value);

  if (
    simplified.kind !== "extractBits" ||
    simplified.width !== width ||
    context.valueCache?.canEmitInline(simplified) === false
  ) {
    return undefined;
  }

  return emitInputExtractBits(context, simplified.value, simplified.bitOffset, width, true);
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
  emitFlagProducerBitsFromInputs(
    context.body,
    value,
    jitFlagValueHelpers(context),
    value.mask
  );
  return cleanValueWidthForMask(value.mask);
}

function emitFlagConditionValue(
  context: JitValueEmitContext,
  flags: JitValue,
  cc: ConditionCode
): ValueWidth {
  const simplifiedFlags = simplifyValue(flags);

  if (emitRoutedFlagCondition(context, simplifiedFlags, cc)) {
    return cleanValueWidth(8);
  }

  emitFlagsConditionFromAluFlagsValue(context.body, cc, (mask) => {
    emitFlagBitsForMask(context, simplifiedFlags, mask);
  });
  return cleanValueWidth(8);
}

function emitRoutedFlagCondition(
  context: JitValueEmitContext,
  flags: JitValue,
  cc: ConditionCode
): boolean {
  const simplifiedFlags = simplifyValue(flags);
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

  const simplifiedFlags = simplifyValue(flags);

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
  emitFlagProducerConditionFromInputs(
    context.body,
    {
      cc,
      producer: value.producer,
      ...(value.width === undefined ? {} : { width: value.width }),
      inputs: value.inputs
    },
    jitFlagValueHelpers(context)
  );
}

function jitFlagValueHelpers(context: JitValueEmitContext): WasmFlagValueEmitHelpers<JitValue> {
  return {
    emitValue: (value, options) => emitJitValue(context, value, options),
    emitMaskedValue: (value, width) => emitMaskedJitValue(context, value, width)
  };
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
