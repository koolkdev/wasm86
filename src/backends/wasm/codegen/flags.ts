import {
  x86ArithmeticFlagMask,
  x86ArithmeticFlags,
  x86ArithmeticFlagsMask
} from "#x86/isa/flags.js";
import type {
  FlagExpr,
  FlagName,
  ValueExpr
} from "#x86/ir/model/flags.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import type { IrBinaryOperator, IrFlagSetOp, ValueRef } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import type { WasmIrAluFlagsStorage } from "./alu-flags.js";
import type { WasmIrEmitHelpers } from "./emit.js";
import {
  cleanValueWidth,
  emitMaskValueToWidth,
  i32BinaryResultValueWidth,
  maskWidthFromConstValue,
  type ValueWidth
} from "./value-width.js";

const flagOrder = x86ArithmeticFlags satisfies readonly FlagName[];

export type EmitSetFlagsOptions = Readonly<{
  mask?: number;
}>;

export function emitSetFlags(
  body: WasmFunctionBodyEncoder,
  aluFlags: WasmIrAluFlagsStorage,
  descriptor: IrFlagSetOp,
  helpers: WasmIrEmitHelpers,
  options: EmitSetFlagsOptions = {}
): void {
  const flagProducer = FLAG_PRODUCERS[descriptor.producer];
  const defs = flagProducer.define(descriptor.inputs, descriptor.width ?? 32);
  // Masked materialization computes only requested bits; partial producers also
  // preserve bits outside writtenMask, such as CF for INC/DEC.
  const writeMask = descriptor.writtenMask & (options.mask ?? x86ArithmeticFlagsMask);

  if (writeMask === 0) {
    return;
  }

  const flagHelpers = helpersForFlagInputs(body, descriptor, helpers);

  aluFlags.emitStore(() => {
    aluFlags.emitLoad();
    body.i32Const(i32(x86ArithmeticFlagsMask & ~writeMask)).i32And();
    emitWrittenFlags(body, defs, flagHelpers, writeMask);
    body.i32Or();
  });
}

export function emitFlagProducerBits(
  body: WasmFunctionBodyEncoder,
  descriptor: IrFlagSetOp,
  helpers: WasmIrEmitHelpers,
  mask: number
): void {
  const flagProducer = FLAG_PRODUCERS[descriptor.producer];
  const writeMask = descriptor.writtenMask & mask;

  if (writeMask === 0) {
    body.i32Const(0);
    return;
  }

  emitWrittenFlags(
    body,
    flagProducer.define(descriptor.inputs, descriptor.width ?? 32),
    helpersForFlagInputs(body, descriptor, helpers),
    writeMask
  );
}

function emitWrittenFlags(
  body: WasmFunctionBodyEncoder,
  defs: Readonly<Partial<Record<FlagName, FlagExpr>>>,
  helpers: WasmIrEmitHelpers,
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

function emitFlagBit(
  body: WasmFunctionBodyEncoder,
  flag: FlagName,
  expr: FlagExpr,
  helpers: WasmIrEmitHelpers
): void {
  emitFlagExpr(body, expr, helpers);
  body.i32Const(flagBit(flag)).i32Shl();
}

function emitFlagExpr(body: WasmFunctionBodyEncoder, expr: FlagExpr, helpers: WasmIrEmitHelpers): void {
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

function emitValueExpr(body: WasmFunctionBodyEncoder, expr: ValueExpr, helpers: WasmIrEmitHelpers): ValueWidth {
  switch (expr.kind) {
    case "var":
    case "const":
    case "nextEip":
      return helpers.emitValue(expr);
    case "and": {
      const masked = maskedValueExpr(expr);

      if (masked !== undefined) {
        return emitMaskedValueExpr(body, masked.value, helpers, masked.width);
      }

      return emitI32BinaryValueExpr(body, "and", expr.a, expr.b, helpers);
    }
    case "xor":
      return emitI32BinaryValueExpr(body, "xor", expr.a, expr.b, helpers);
  }
}

function emitI32BinaryValueExpr(
  body: WasmFunctionBodyEncoder,
  operator: Extract<IrBinaryOperator, "and" | "xor">,
  a: ValueExpr,
  b: ValueExpr,
  helpers: WasmIrEmitHelpers
): ValueWidth {
  const left = emitValueExpr(body, a, helpers);
  const right = emitValueExpr(body, b, helpers);

  emitI32BinaryInstruction(body, operator);
  return i32BinaryResultValueWidth(operator, left, right);
}

function emitI32BinaryInstruction(
  body: WasmFunctionBodyEncoder,
  operator: Extract<IrBinaryOperator, "and" | "xor">
): void {
  switch (operator) {
    case "and":
      body.i32And();
      return;
    case "xor":
      body.i32Xor();
      return;
  }
}

function emitMaskedValueExpr(
  body: WasmFunctionBodyEncoder,
  expr: ValueExpr,
  helpers: WasmIrEmitHelpers,
  width: OperandWidth
): ValueWidth {
  if (isIrValueExpr(expr)) {
    return helpers.emitMaskedValue(expr, width);
  }

  return emitMaskValueToWidth(body, width, emitValueExpr(body, expr, helpers));
}

function helpersForFlagInputs(
  body: WasmFunctionBodyEncoder,
  descriptor: IrFlagSetOp,
  helpers: WasmIrEmitHelpers
): WasmIrEmitHelpers {
  const width = descriptor.width ?? 32;
  const result = descriptor.inputs.result;

  if (width === 32 || result === undefined) {
    return helpers;
  }

  const local = body.addLocal(wasmValueType.i32);

  helpers.emitMaskedValue(result, width);
  body.localSet(local);

  const valueWidth = cleanValueWidth(width);

  return {
    emitValue: (value, options) => {
      if (!isValueRef(value) || !sameValueRef(value, result)) {
        return helpers.emitValue(value, options);
      }

      body.localGet(local);

      if (options?.requestedWidth === undefined) {
        return valueWidth;
      }

      return options.requestedWidth === 32 ? valueWidth : emitMaskValueToWidth(body, options.requestedWidth, valueWidth);
    },
    emitMaskedValue: (value, requestedWidth) => {
      if (!isValueRef(value) || !sameValueRef(value, result)) {
        return helpers.emitMaskedValue(value, requestedWidth);
      }

      body.localGet(local);
      return emitMaskValueToWidth(body, requestedWidth, valueWidth);
    }
  };
}

function maskedValueExpr(
  expr: Extract<ValueExpr, { kind: "and" }>
): Readonly<{ value: ValueExpr; width: OperandWidth }> | undefined {
  const rightWidth = constMaskWidth(expr.b);

  if (rightWidth !== undefined) {
    return { value: expr.a, width: rightWidth };
  }

  const leftWidth = constMaskWidth(expr.a);

  return leftWidth === undefined ? undefined : { value: expr.b, width: leftWidth };
}

function constMaskWidth(expr: ValueExpr): OperandWidth | undefined {
  return expr.kind === "const" ? maskWidthFromConstValue(expr.value) : undefined;
}

function isIrValueExpr(expr: ValueExpr): expr is ValueRef {
  switch (expr.kind) {
    case "var":
    case "const":
    case "nextEip":
      return true;
    case "and":
    case "xor":
      return false;
  }
}

function isValueRef(value: { kind: string }): value is ValueRef {
  return value.kind === "var" || value.kind === "const" || value.kind === "nextEip";
}

function sameValueRef(left: ValueRef, right: ValueRef): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "var":
      return left.id === (right as Extract<ValueRef, { kind: "var" }>).id;
    case "const":
      return left.type === (right as Extract<ValueRef, { kind: "const" }>).type &&
        left.value === (right as Extract<ValueRef, { kind: "const" }>).value;
    case "nextEip":
      return true;
  }
}

function flagBit(flag: FlagName): number {
  return Math.log2(x86ArithmeticFlagMask[flag]);
}

function signMask(width: 8 | 16 | 32): number {
  return width === 32 ? i32(0x8000_0000) : width === 16 ? 0x8000 : 0x80;
}
