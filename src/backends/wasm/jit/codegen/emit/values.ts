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
  JitArchitecturalSlot,
  JitFlagProducerValue,
  JitInputValue,
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { ValueCache } from "./cache.js";

export type ValueEmitOptions = WasmIrEmitValueOptions;

export type ValueEmitter = Readonly<{
  emit(value: JitValue, options?: ValueEmitOptions): ValueWidth;
  emitMasked(value: JitValue, width: OperandWidth): ValueWidth;
  emitInline(value: JitValue, options?: ValueEmitOptions): ValueWidth;
}>;

export type InputEmitter = Readonly<{
  emit(slot: JitArchitecturalSlot): ValueWidth;
  emitBits?(
    slot: JitArchitecturalSlot,
    bitOffset: number,
    width: OperandWidth,
    signed: boolean
  ): ValueWidth | undefined;
}>;

export type ProducedEmitter = Readonly<{
  emit(value: JitProducedValue): ValueWidth;
}>;

export type ValueEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  cache?: ValueCache | undefined;
  inputs: InputEmitter;
  produced: ProducedEmitter;
}>;

export function unavailableProducedEmitter(): ProducedEmitter {
  return {
    emit: (value) => {
      throw new Error(`produced JIT value is not available for lowering: ${value.id}`);
    }
  };
}

export function createValueEmitter(context: ValueEmitContext): ValueEmitter {
  return {
    emit: (value, options) => emitValue(context, value, options),
    emitMasked: (value, width) => emitMaskedValue(context, value, width),
    emitInline: (value, options) => emitInline(context, value, options)
  };
}

function emitValue(
  context: ValueEmitContext,
  value: JitValue,
  options: ValueEmitOptions = {}
): ValueWidth {
  const simplified = simplifyValue(value);
  const valueWidth = context.cache === undefined
    ? emitInlineValue(context, simplified)
    : context.cache.emitForUse(simplified, () => emitInlineValue(context, simplified)).valueWidth;

  return applyRequestedValueWidth(context.body, valueWidth, options);
}

function emitInline(
  context: ValueEmitContext,
  value: JitValue,
  options: ValueEmitOptions = {}
): ValueWidth {
  const valueWidth = emitInlineValue(context, simplifyValue(value));

  return applyRequestedValueWidth(context.body, valueWidth, options);
}

function emitMaskedValue(
  context: ValueEmitContext,
  value: JitValue,
  width: OperandWidth
): ValueWidth {
  return emitMaskValueToWidth(context.body, width, emitValue(context, value));
}

function emitInlineValue(context: ValueEmitContext, value: JitValue): ValueWidth {
  switch (value.kind) {
    case "const":
      context.body.i32Const(i32(value.value));
      return constValueWidth(value.value);
    case "input":
      return emitInput(context, value);
    case "produced":
      return emitProduced(context, value);
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

function emitProduced(context: ValueEmitContext, value: JitProducedValue): ValueWidth {
  return context.produced.emit(value);
}

function emitInput(context: ValueEmitContext, value: JitInputValue): ValueWidth {
  return context.inputs.emit(value.slot);
}

function emitI32Binary(context: ValueEmitContext, operator: IrBinaryOperator, a: JitValue, b: JitValue): ValueWidth {
  const operandOptions = i32BinaryOperandEmitOptions(operator);
  const left = emitValue(context, a, operandOptions);
  const right = emitValue(context, b, operandOptions);

  emitI32BinaryInstruction(context.body, operator);
  return i32BinaryResultValueWidth(operator, left, right);
}

function emitI32Unary(context: ValueEmitContext, operator: IrUnaryOperator, value: JitValue): ValueWidth {
  switch (operator) {
    case "extend8_s":
      return emitI32SignExtend(context, value, 8);
    case "extend16_s":
      return emitI32SignExtend(context, value, 16);
  }
}

function emitI32SignExtend(context: ValueEmitContext, value: JitValue, width: 8 | 16): ValueWidth {
  const inputBits = emitSignExtendInputExtractBits(context, value, width);

  if (inputBits !== undefined) {
    return inputBits;
  }

  emitValue(context, value, { widthInsensitive: true });
  return emitSignExtendValueToWidth(context.body, width);
}

function emitI32Select(context: ValueEmitContext, condition: JitValue, whenTrue: JitValue, whenFalse: JitValue): ValueWidth {
  const trueWidth = emitValue(context, whenTrue);
  const falseWidth = emitValue(context, whenFalse);
  const conditionWidth = emitValue(context, condition, { requestedWidth: 32 });

  context.body.select();
  return i32SelectResultValueWidth(conditionWidth, trueWidth, falseWidth);
}

function emitExtractBits(
  context: ValueEmitContext,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth
): ValueWidth {
  const inputBits = emitInputExtractBits(context, value, bitOffset, width, false);

  if (inputBits !== undefined) {
    return inputBits;
  }

  const valueWidth = emitValue(context, value, bitOffset === 0 ? { widthInsensitive: true } : { requestedWidth: 32 });

  if (bitOffset !== 0) {
    context.body.i32Const(bitOffset).i32ShrU();
  }

  return width === 32
    ? cleanValueWidth(32)
    : emitMaskValueToWidth(context.body, width, bitOffset === 0 ? valueWidth : cleanValueWidth(32));
}

function emitInputExtractBits(
  context: ValueEmitContext,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth,
  signed: boolean
): ValueWidth | undefined {
  const simplified = simplifyValue(value);

  if (
    simplified.kind !== "input" ||
    context.cache?.canInline(simplified) === false
  ) {
    return undefined;
  }

  return context.inputs.emitBits?.(simplified.slot, bitOffset, width, signed);
}

function emitSignExtendInputExtractBits(
  context: ValueEmitContext,
  value: JitValue,
  width: 8 | 16
): ValueWidth | undefined {
  const simplified = simplifyValue(value);

  if (
    simplified.kind !== "extractBits" ||
    simplified.width !== width ||
    context.cache?.canInline(simplified) === false
  ) {
    return undefined;
  }

  return emitInputExtractBits(context, simplified.value, simplified.bitOffset, width, true);
}

function emitInsertBits(
  context: ValueEmitContext,
  base: JitValue,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth
): ValueWidth {
  if (bitOffset === 0 && width === 32) {
    return emitValue(context, value, { requestedWidth: 32 });
  }

  const mask = bitRangeMask(bitOffset, width);

  emitValue(context, base, { requestedWidth: 32 });
  context.body.i32Const(i32(~mask)).i32And();
  emitMaskedValue(context, value, width);

  if (bitOffset !== 0) {
    context.body.i32Const(bitOffset).i32Shl();
  }

  context.body.i32Or();
  return cleanValueWidth(32);
}

function emitExtractMaskedBits(context: ValueEmitContext, value: JitValue, mask: number): ValueWidth {
  emitValue(context, value, { widthInsensitive: true });
  context.body.i32Const(i32(mask)).i32And();
  return cleanValueWidth(32);
}

function emitInsertMaskedBits(context: ValueEmitContext, base: JitValue, value: JitValue, mask: number): ValueWidth {
  emitValue(context, base, { requestedWidth: 32 });
  context.body.i32Const(i32(~mask)).i32And();
  emitValue(context, value, { widthInsensitive: true });
  context.body.i32Const(i32(mask)).i32And();
  context.body.i32Or();
  return cleanValueWidth(32);
}

function emitFlagProducerValue(context: ValueEmitContext, value: JitFlagProducerValue): ValueWidth {
  emitFlagProducerBitsFromInputs(
    context.body,
    value,
    jitFlagValueHelpers(context),
    value.mask
  );
  return cleanValueWidthForMask(value.mask);
}

function emitFlagConditionValue(
  context: ValueEmitContext,
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
  context: ValueEmitContext,
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
  context: ValueEmitContext,
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

  const valueWidth = emitValue(context, simplifiedFlags, { requestedWidth: 32 });

  if (!forceMasked) {
    return valueWidth;
  }

  context.body.i32Const(i32(normalizedReadMask)).i32And();
  return cleanValueWidthForMask(normalizedReadMask);
}

function emitDirectFlagProducerCondition(
  context: ValueEmitContext,
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

function jitFlagValueHelpers(context: ValueEmitContext): WasmFlagValueEmitHelpers<JitValue> {
  return {
    emitValue: (value, options) => emitValue(context, value, options),
    emitMaskedValue: (value, width) => emitMaskedValue(context, value, width)
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
