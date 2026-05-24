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
import { i32 } from "#x86/state/cpu-state.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { IrBinaryOperator, IrUnaryOperator } from "#x86/ir/model/types.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import { bitRangeMask } from "#backends/wasm/jit/ir/values/bits.js";
import type {
  JitArchitecturalSlot,
  JitInputValue,
  JitLoadResultValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type {
  Placement
} from "#backends/wasm/jit/codegen/plan/schedule-types.js";
import type { Capture } from "#backends/wasm/jit/codegen/plan/captures.js";
import type { Path } from "#backends/wasm/jit/analysis/paths.js";
import type {
  CapturedValue,
  ValueCache,
  ValueScope
} from "./cache.js";
import {
  emitFlagConditionValue,
  emitFlagProducerValue,
  type FlagValueEmitContext
} from "./flag-values.js";

export type ValueEmitOptions = WasmIrEmitValueOptions;

export type ValueCapture = Readonly<{
  emit(): ValueWidth;
  release(): void;
}>;

export type ValueEmitter = Readonly<{
  // Emits a normal value use through the reuse cache.
  emit(value: JitValue, options?: ValueEmitOptions): ValueWidth;

  // Emits a normal value use and masks it to the requested operand width.
  emitMasked(value: JitValue, width: OperandWidth): ValueWidth;

  // Emits the root value inline while child values may still use the cache.
  emitInline(value: JitValue, options?: ValueEmitOptions): ValueWidth;

  // Pins an already-materialized value for deferred use.
  retain(value: JitValue): ValueCapture | undefined;

  // Materializes a concrete planned capture owned by the caller.
  capture(capture: Capture, emit: () => ValueWidth): ValueCapture;

  // Materializes a load-result value only when the reuse plan selected it.
  define(value: JitLoadResultValue, emit: () => ValueWidth): ValueCapture | undefined;

  // Emits while a value path is active.
  withPath<T>(path: Path, emit: () => T): T;
}>;

export type ValueEmitters = Readonly<{
  at(placement: Placement): ValueEmitter;
}>;

export type InlineValueEmitter = Readonly<{
  emit(value: JitValue, context: InlineValueEmitContext): ValueWidth;
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

export type LoadResultEmitter = Readonly<{
  emit(value: JitLoadResultValue): ValueWidth;
}>;

export type ValueEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  cache: ValueCache;
  scope: ValueScope;
  inputs: InputEmitter;
  loadResults: LoadResultEmitter;
}>;

export function unavailableLoadResultEmitter(): LoadResultEmitter {
  return {
    emit: (value) => {
      throw new Error(`load-result JIT value is not available for lowering: ${value.id}`);
    }
  };
}

export function createValueEmitters(context: ValueEmitContext): ValueEmitters {
  const inline = createInlineValueEmitter(context);

  return {
    at: (placement) => createValueEmitterAt(context, inline, placement)
  };
}

function createValueEmitterAt(
  context: ValueEmitContext,
  inline: InlineValueEmitter,
  at: Placement
): ValueEmitter {
  const values: ValueEmitter = {
    emit: (value, options) => emitValue(context, inline, at, values, value, options),
    emitMasked: (value, width) => emitMaskedValue(context, values, value, width),
    emitInline: (value, options) => emitInline(context, inline, at, values, value, options),
    retain: (value) => valueCapture(context, context.cache.retain(value)),
    capture: (capture, emit) => captureValue(context, at, capture, emit),
    define: (value, emit) => valueCapture(context, context.cache.define(at, value, emit)),
    withPath: (path, emit) => context.scope.withPath(path, emit)
  };

  return values;
}

function createInlineValueEmitter(context: ValueEmitContext): InlineValueEmitter {
  return {
    emit: (value, emitContext) => emitInlineValue(context, emitContext, value)
  };
}

function emitValue(
  context: ValueEmitContext,
  inline: InlineValueEmitter,
  at: Placement,
  values: ValueEmitter,
  value: JitValue,
  options: ValueEmitOptions = {}
): ValueWidth {
  const simplified = simplifyValue(value);
  const valueWidth = context.cache.emitForUse(
    at,
    simplified,
    () => inline.emit(simplified, inlineValueContext(context, at, values))
  ).valueWidth;

  return applyRequestedValueWidth(context.body, valueWidth, options);
}

function emitInline(
  context: ValueEmitContext,
  inline: InlineValueEmitter,
  at: Placement,
  values: ValueEmitter,
  value: JitValue,
  options: ValueEmitOptions = {}
): ValueWidth {
  const valueWidth = inline.emit(
    simplifyValue(value),
    inlineValueContext(context, at, values)
  );

  return applyRequestedValueWidth(context.body, valueWidth, options);
}

function emitMaskedValue(
  context: ValueEmitContext,
  values: ValueEmitter,
  value: JitValue,
  width: OperandWidth
): ValueWidth {
  return emitMaskValueToWidth(context.body, width, values.emit(value));
}

function captureValue(
  context: ValueEmitContext,
  at: Placement,
  capture: Capture,
  emit: () => ValueWidth
): ValueCapture {
  if (!placementsEqual(at, capture.at)) {
    throw new Error("JIT value capture placement does not match value emitter placement");
  }

  const captured = context.scope.withPath(
    capture.availability,
    () => valueCapture(context, context.cache.capture(capture, emit))
  );

  if (captured === undefined) {
    throw new Error("JIT planned value capture was not created");
  }

  return captured;
}

function valueCapture(
  context: ValueEmitContext,
  captured: CapturedValue | undefined
): ValueCapture | undefined {
  if (captured === undefined) {
    return undefined;
  }

  return {
    emit: () => {
      context.body.localGet(captured.local);
      return captured.valueWidth;
    },
    release: () => captured.release()
  };
}

type InlineValueEmitContext = Readonly<{
  values: ValueEmitter;
  canInline(value: JitValue): boolean;
}>;

function inlineValueContext(
  context: ValueEmitContext,
  at: Placement,
  values: ValueEmitter
): InlineValueEmitContext {
  return {
    values,
    canInline: (value) => context.cache.canInline(at, value)
  };
}

function placementsEqual(
  left: Placement,
  right: Placement
): boolean {
  return left.opIndex === right.opIndex &&
    left.epoch === right.epoch;
}

function emitInlineValue(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  value: JitValue
): ValueWidth {
  switch (value.kind) {
    case "const":
      context.body.i32Const(i32(value.value));
      return constValueWidth(value.value);
    case "input":
      return emitInput(context, value);
    case "loadResult":
      return emitLoadResult(context, value);
    case "value.binary":
      return emitI32Binary(context, emitContext, value.operator, value.a, value.b);
    case "value.unary":
      return emitI32Unary(context, emitContext, value.operator, value.value);
    case "value.select":
      return emitI32Select(context, emitContext, value.condition, value.whenTrue, value.whenFalse);
    case "extractBits":
      return emitExtractBits(context, emitContext, value.value, value.bitOffset, value.width);
    case "insertBits":
      return emitInsertBits(context, emitContext, value.base, value.value, value.bitOffset, value.width);
    case "extractMaskedBits":
      return emitExtractMaskedBits(context, emitContext, value.value, value.mask);
    case "insertMaskedBits":
      return emitInsertMaskedBits(context, emitContext, value.base, value.value, value.mask);
    case "flagProducer":
      return emitFlagProducerValue(flagValueContext(context, emitContext), value);
    case "flagCondition":
      return emitFlagConditionValue(flagValueContext(context, emitContext), value.flags, value.cc);
  }
}

function emitLoadResult(context: ValueEmitContext, value: JitLoadResultValue): ValueWidth {
  return context.loadResults.emit(value);
}

function emitInput(context: ValueEmitContext, value: JitInputValue): ValueWidth {
  return context.inputs.emit(value.slot);
}

function emitI32Binary(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  operator: IrBinaryOperator,
  a: JitValue,
  b: JitValue
): ValueWidth {
  const operandOptions = i32BinaryOperandEmitOptions(operator);
  const left = emitContext.values.emit(a, operandOptions);
  const right = emitContext.values.emit(b, operandOptions);

  emitI32BinaryInstruction(context.body, operator);
  return i32BinaryResultValueWidth(operator, left, right);
}

function emitI32Unary(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  operator: IrUnaryOperator,
  value: JitValue
): ValueWidth {
  switch (operator) {
    case "extend8_s":
      return emitI32SignExtend(context, emitContext, value, 8);
    case "extend16_s":
      return emitI32SignExtend(context, emitContext, value, 16);
    case "popcnt":
      emitContext.values.emit(value, { requestedWidth: 32 });
      context.body.i32Popcnt();
      return cleanValueWidth(8);
  }
}

function emitI32SignExtend(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  value: JitValue,
  width: 8 | 16
): ValueWidth {
  const inputBits = emitSignExtendInputExtractBits(context, emitContext, value, width);

  if (inputBits !== undefined) {
    return inputBits;
  }

  emitContext.values.emit(value, { widthInsensitive: true });
  return emitSignExtendValueToWidth(context.body, width);
}

function emitI32Select(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  condition: JitValue,
  whenTrue: JitValue,
  whenFalse: JitValue
): ValueWidth {
  const trueWidth = emitContext.values.emit(whenTrue);
  const falseWidth = emitContext.values.emit(whenFalse);
  const conditionWidth = emitContext.values.emit(condition, { requestedWidth: 32 });

  context.body.select();
  return i32SelectResultValueWidth(conditionWidth, trueWidth, falseWidth);
}

function emitExtractBits(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth
): ValueWidth {
  const inputBits = emitInputExtractBits(context, emitContext, value, bitOffset, width, false);

  if (inputBits !== undefined) {
    return inputBits;
  }

  const valueWidth = emitContext.values.emit(
    value,
    bitOffset === 0 ? { widthInsensitive: true } : { requestedWidth: 32 }
  );

  if (bitOffset !== 0) {
    context.body.i32Const(bitOffset).i32ShrU();
  }

  return width === 32
    ? cleanValueWidth(32)
    : emitMaskValueToWidth(context.body, width, bitOffset === 0 ? valueWidth : cleanValueWidth(32));
}

function emitInputExtractBits(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth,
  signed: boolean
): ValueWidth | undefined {
  const simplified = simplifyValue(value);

  if (
    simplified.kind !== "input" ||
    emitContext.canInline(simplified) === false
  ) {
    return undefined;
  }

  return context.inputs.emitBits?.(simplified.slot, bitOffset, width, signed);
}

function emitSignExtendInputExtractBits(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  value: JitValue,
  width: 8 | 16
): ValueWidth | undefined {
  const simplified = simplifyValue(value);

  if (
    simplified.kind !== "extractBits" ||
    simplified.width !== width ||
    emitContext.canInline(simplified) === false
  ) {
    return undefined;
  }

  return emitInputExtractBits(context, emitContext, simplified.value, simplified.bitOffset, width, true);
}

function emitInsertBits(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  base: JitValue,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth
): ValueWidth {
  if (bitOffset === 0 && width === 32) {
    return emitContext.values.emit(value, { requestedWidth: 32 });
  }

  const mask = bitRangeMask(bitOffset, width);

  emitContext.values.emit(base, { requestedWidth: 32 });
  context.body.i32Const(i32(~mask)).i32And();
  emitContext.values.emitMasked(value, width);

  if (bitOffset !== 0) {
    context.body.i32Const(bitOffset).i32Shl();
  }

  context.body.i32Or();
  return cleanValueWidth(32);
}

function emitExtractMaskedBits(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  value: JitValue,
  mask: number
): ValueWidth {
  emitContext.values.emit(value, { widthInsensitive: true });
  context.body.i32Const(i32(mask)).i32And();
  return cleanValueWidth(32);
}

function emitInsertMaskedBits(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext,
  base: JitValue,
  value: JitValue,
  mask: number
): ValueWidth {
  emitContext.values.emit(base, { requestedWidth: 32 });
  context.body.i32Const(i32(~mask)).i32And();
  emitContext.values.emit(value, { widthInsensitive: true });
  context.body.i32Const(i32(mask)).i32And();
  context.body.i32Or();
  return cleanValueWidth(32);
}

function flagValueContext(
  context: ValueEmitContext,
  emitContext: InlineValueEmitContext
): FlagValueEmitContext {
  return {
    body: context.body,
    emitValue: (value, options) => emitContext.values.emit(value, options),
    emitMaskedValue: (value, width) => emitContext.values.emitMasked(value, width)
  };
}
