import {
  x86ArithmeticFlagMask,
  x86ArithmeticFlags,
  x86ArithmeticFlagsMask
} from "#x86/isa/flags.js";
import type {
  FlagExpr,
  FlagName,
  FlagProducerInputs,
  ValueExpr
} from "#x86/ir/model/flags.js";
import {
  FLAG_PRODUCERS,
  defineFlagProducer,
  flagProducerInputsFromRecord,
  requiredFlagProducerInput
} from "#x86/ir/model/flags.js";
import type { FlagProducerName, IrFlagSetOp, ValueRef } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import type { IrFlagWriteExprOp, IrValueExpr } from "./expressions.js";
import type { WasmIrAluFlagsStorage } from "./alu-flags.js";
import {
  emitI32BinaryInstruction,
  type WasmIrEmitHelpers
} from "./emit.js";
import {
  cleanValueWidth,
  constValueWidth,
  emitMaskValueToWidth,
  i32BinaryResultValueWidth,
  maskedConstValue,
  maskWidthFromConstValue,
  type WasmIrEmitValueOptions,
  type ValueWidth
} from "./value-width.js";

const flagOrder = x86ArithmeticFlags satisfies readonly FlagName[];

export type EmitSetFlagsOptions = Readonly<{
  mask?: number;
}>;

export type WasmFlagValueEmitHelpers<T> = Readonly<{
  emitValue(value: T, options?: WasmIrEmitValueOptions): ValueWidth;
  emitMaskedValue(value: T, width: OperandWidth): ValueWidth;
}>;

export type FlagProducerBitsDescriptor<T> = Readonly<{
  producer: FlagProducerName;
  width?: OperandWidth;
  inputs: FlagProducerInputs<T>;
}>;

export function emitSetFlags(
  body: WasmFunctionBodyEncoder,
  aluFlags: WasmIrAluFlagsStorage,
  descriptor: IrFlagSetOp,
  helpers: WasmIrEmitHelpers,
  options: EmitSetFlagsOptions = {}
): void {
  const inputs = flagProducerInputsFromRecord(descriptor.producer, descriptor.inputs);
  const defs = defineFlagProducer(descriptor.producer, inputs, descriptor.width ?? 32);
  // Masked materialization computes only requested bits; partial producers also
  // preserve bits outside writtenMask, such as CF for INC/DEC.
  const writeMask = flagProducerWrittenMask(descriptor.producer) & (options.mask ?? x86ArithmeticFlagsMask);

  if (writeMask === 0) {
    return;
  }

  const flagHelpers = helpersForFlagInputs(body, descriptor.width ?? 32, resultInput(descriptor.producer, inputs), helpers);

  aluFlags.emitStore(() => {
    aluFlags.emitLoad();
    body.i32Const(i32(x86ArithmeticFlagsMask & ~writeMask)).i32And();
    emitWrittenFlags(body, defs, flagHelpers, writeMask);
    body.i32Or();
  });
}

export function emitWriteFlags(
  body: WasmFunctionBodyEncoder,
  aluFlags: WasmIrAluFlagsStorage,
  descriptor: IrFlagWriteExprOp,
  helpers: WasmFlagValueEmitHelpers<IrValueExpr>
): void {
  const writeMask = flagWriteMask(descriptor);

  if (writeMask === 0) {
    return;
  }

  aluFlags.emitStore(() => {
    aluFlags.emitLoad();
    body.i32Const(i32(x86ArithmeticFlagsMask & ~writeMask)).i32And();
    emitFlagWriteCells(body, descriptor, helpers);
    body.i32Or();
  });
}

export function emitFlagProducerBits(
  body: WasmFunctionBodyEncoder,
  descriptor: IrFlagSetOp,
  helpers: WasmIrEmitHelpers,
  mask: number
): void {
  emitFlagProducerBitsFromInputs(
    body,
    {
      producer: descriptor.producer,
      ...(descriptor.width === undefined ? {} : { width: descriptor.width }),
      inputs: flagProducerInputsFromRecord(descriptor.producer, descriptor.inputs)
    },
    helpers,
    mask
  );
}

export function emitFlagProducerBitsFromInputs<T>(
  body: WasmFunctionBodyEncoder,
  descriptor: FlagProducerBitsDescriptor<T>,
  helpers: WasmFlagValueEmitHelpers<T>,
  mask: number
): void {
  const writeMask = flagProducerWrittenMask(descriptor.producer) & mask;

  if (writeMask === 0) {
    body.i32Const(0);
    return;
  }

  emitWrittenFlags(
    body,
    defineFlagProducer(descriptor.producer, descriptor.inputs, descriptor.width ?? 32),
    helpersForFlagInputs(body, descriptor.width ?? 32, resultInput(descriptor.producer, descriptor.inputs), helpers),
    writeMask
  );
}

function emitWrittenFlags<T>(
  body: WasmFunctionBodyEncoder,
  defs: Readonly<Partial<Record<FlagName, FlagExpr<T>>>>,
  helpers: WasmFlagValueEmitHelpers<T>,
  mask: number
): void {
  let hasWrittenFlag = false;

  for (const flag of flagOrder) {
    if ((mask & x86ArithmeticFlagMask[flag]) === 0) {
      continue;
    }

    const expr = defs[flag];

    if (expr === undefined) {
      throw new Error(`flag producer metadata writes ${flag} without defining it`);
    }

    emitFlagBit(body, flag, expr, helpers);

    if (hasWrittenFlag) {
      body.i32Or();
    } else {
      hasWrittenFlag = true;
    }
  }

  if (!hasWrittenFlag) {
    body.i32Const(0);
  }
}

function emitFlagWriteCells(
  body: WasmFunctionBodyEncoder,
  descriptor: IrFlagWriteExprOp,
  helpers: WasmFlagValueEmitHelpers<IrValueExpr>
): void {
  let hasWrittenBit = false;

  for (const flag of flagOrder) {
    const cell = descriptor.cells[flag];

    if (cell === undefined || cell.kind === "undef") {
      continue;
    }

    helpers.emitValue(cell.value, { requestedWidth: 32 });
    body.i32Eqz().i32Eqz().i32Const(flagBit(flag)).i32Shl();

    if (hasWrittenBit) {
      body.i32Or();
    } else {
      hasWrittenBit = true;
    }
  }

  if (!hasWrittenBit) {
    body.i32Const(0);
  }
}

function flagWriteMask(descriptor: IrFlagWriteExprOp): number {
  let mask = 0;

  for (const flag of flagOrder) {
    if (descriptor.cells[flag] !== undefined) {
      mask |= x86ArithmeticFlagMask[flag];
    }
  }

  return mask;
}

function emitFlagBit<T>(
  body: WasmFunctionBodyEncoder,
  flag: FlagName,
  expr: FlagExpr<T>,
  helpers: WasmFlagValueEmitHelpers<T>
): void {
  emitFlagExpr(body, expr, helpers);
  body.i32Const(flagBit(flag)).i32Shl();
}

function emitFlagExpr<T>(
  body: WasmFunctionBodyEncoder,
  expr: FlagExpr<T>,
  helpers: WasmFlagValueEmitHelpers<T>
): void {
  switch (expr.kind) {
    case "constFlag":
      body.i32Const(expr.value);
      return;
    case "undefFlag":
      body.i32Const(0);
      return;
    case "eqz":
      emitValueExpr(body, expr.value, helpers);
      body.i32Eqz();
      return;
    case "ne0":
      emitValueExpr(body, expr.value, helpers);
      body.i32Eqz().i32Eqz();
      return;
    case "uLt":
      emitValueExpr(body, expr.a, helpers);
      emitValueExpr(body, expr.b, helpers);
      body.i32LtU();
      return;
    case "bit":
      emitValueExpr(body, expr.value, helpers);
      body.i32Const(expr.bit).i32ShrU().i32Const(1).i32And();
      return;
    case "parity8":
      emitMaskedValueExpr(body, expr.value, helpers, 8);
      body.i32Popcnt().i32Const(1).i32And().i32Eqz();
      return;
    case "signBit":
      emitValueExpr(body, expr.value, helpers);
      body.i32Const(signMask(expr.width)).i32And().i32Eqz().i32Eqz();
      return;
  }
}

function emitValueExpr<T>(
  body: WasmFunctionBodyEncoder,
  expr: ValueExpr<T>,
  helpers: WasmFlagValueEmitHelpers<T>
): ValueWidth {
  switch (expr.kind) {
    case "leaf":
      return helpers.emitValue(expr.value);
    case "const":
      body.i32Const(i32(expr.value));
      return constValueWidth(expr.value);
    case "and": {
      const masked = maskedValueExpr(expr);

      if (masked !== undefined) {
        return emitMaskedValueExpr(body, masked.value, helpers, masked.width);
      }

      return emitI32BinaryValueExpr(body, expr.kind, expr.a, expr.b, helpers);
    }
    case "xor":
      return emitI32BinaryValueExpr(body, expr.kind, expr.a, expr.b, helpers);
  }
}

function emitI32BinaryValueExpr<T>(
  body: WasmFunctionBodyEncoder,
  operator: "and" | "xor",
  a: ValueExpr<T>,
  b: ValueExpr<T>,
  helpers: WasmFlagValueEmitHelpers<T>
): ValueWidth {
  const left = emitValueExpr(body, a, helpers);
  const right = emitValueExpr(body, b, helpers);

  emitI32BinaryInstruction(body, operator);
  return i32BinaryResultValueWidth(operator, left, right);
}

function emitMaskedValueExpr<T>(
  body: WasmFunctionBodyEncoder,
  expr: ValueExpr<T>,
  helpers: WasmFlagValueEmitHelpers<T>,
  width: OperandWidth
): ValueWidth {
  switch (expr.kind) {
    case "leaf":
      return helpers.emitMaskedValue(expr.value, width);
    case "const": {
      const masked = maskedConstValue(expr.value, width);

      body.i32Const(masked);
      return constValueWidth(masked);
    }
    case "and":
    case "xor":
      return emitMaskValueToWidth(body, width, emitValueExpr(body, expr, helpers));
  }
}

function helpersForFlagInputs<T>(
  body: WasmFunctionBodyEncoder,
  width: OperandWidth,
  result: T | undefined,
  helpers: WasmFlagValueEmitHelpers<T>
): WasmFlagValueEmitHelpers<T> {
  if (width === 32 || result === undefined) {
    return helpers;
  }

  const local = body.addLocal(wasmValueType.i32);

  helpers.emitMaskedValue(result, width);
  body.localSet(local);

  const valueWidth = cleanValueWidth(width);

  return {
    emitValue: (value, options) => {
      if (!sameFlagValueLeaf(value, result)) {
        return helpers.emitValue(value, options);
      }

      body.localGet(local);

      if (options?.requestedWidth === undefined) {
        return valueWidth;
      }

      return options.requestedWidth === 32 ? valueWidth : emitMaskValueToWidth(body, options.requestedWidth, valueWidth);
    },
    emitMaskedValue: (value, requestedWidth) => {
      if (!sameFlagValueLeaf(value, result)) {
        return helpers.emitMaskedValue(value, requestedWidth);
      }

      body.localGet(local);
      return emitMaskValueToWidth(body, requestedWidth, valueWidth);
    }
  };
}

function maskedValueExpr<T>(
  expr: Extract<ValueExpr<T>, { kind: "and" }>
): Readonly<{ value: ValueExpr<T>; width: OperandWidth }> | undefined {
  const rightWidth = constMaskWidth(expr.b);

  if (rightWidth !== undefined) {
    return { value: expr.a, width: rightWidth };
  }

  const leftWidth = constMaskWidth(expr.a);

  return leftWidth === undefined ? undefined : { value: expr.b, width: leftWidth };
}

function constMaskWidth<T>(expr: ValueExpr<T>): OperandWidth | undefined {
  return expr.kind === "const" ? maskWidthFromConstValue(expr.value) : undefined;
}

function flagProducerWrittenMask(producer: FlagProducerName): number {
  return FLAG_PRODUCERS[producer].writtenMask;
}

function resultInput<T>(
  producer: FlagProducerName,
  inputs: FlagProducerInputs<T>
): T | undefined {
  return requiredFlagProducerInput(producer, inputs, "result");
}

function sameFlagValueLeaf<T>(left: T, right: T): boolean {
  if (left === right) {
    return true;
  }

  if (!isKindedObject(left) || !isKindedObject(right)) {
    return false;
  }

  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "var":
      return isVarValueRef(left) && isVarValueRef(right) && left.id === right.id;
    case "const":
      return isConstValueRef(left) &&
        isConstValueRef(right) &&
        left.type === right.type &&
        left.value === right.value;
    case "nextEip":
      return true;
    default:
      return false;
  }
}

function isKindedObject<T>(value: T): value is T & Readonly<{ kind: string }> {
  return typeof value === "object" && value !== null && "kind" in value;
}

function isVarValueRef<T>(value: T): value is T & Extract<ValueRef, { kind: "var" }> {
  return isKindedObject(value) && value.kind === "var" && "id" in value && typeof value.id === "number";
}

function isConstValueRef<T>(value: T): value is T & Extract<ValueRef, { kind: "const" }> {
  return isKindedObject(value) &&
    value.kind === "const" &&
    "type" in value &&
    "value" in value &&
    value.type === "i32" &&
    typeof value.value === "number";
}

function flagBit(flag: FlagName): number {
  return Math.log2(x86ArithmeticFlagMask[flag]);
}

function signMask(width: 8 | 16 | 32): number {
  return width === 32 ? i32(0x8000_0000) : width === 16 ? 0x8000 : 0x80;
}
