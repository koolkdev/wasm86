import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  cleanValueWidth,
  type ValueWidth,
  type WasmIrEmitValueOptions
} from "#wasm/codegen/value-width.js";
import {
  emitFlagsConditionFromAluFlagsValue,
  emitFlagProducerConditionFromInputs
} from "#wasm/codegen/conditions.js";
import {
  emitFlagProducerBitsFromInputs,
  emitFlagWriteBitsFromCells,
  type WasmFlagValueEmitHelpers
} from "#wasm/codegen/flags.js";
import { conditionFlagReadMask } from "#ir/model/flag-effects.js";
import { flagProducerConditionKind } from "#ir/model/flag-conditions.js";
import { CONDITIONS, type FlagBoolExpr } from "#ir/model/conditions.js";
import { i32 } from "#x86/numeric.js";
import type { OperandWidth } from "#x86/types.js";
import type { ConditionCode } from "#ir/model/types.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import { narrowFlagWriteToMask } from "#backends/wasm/jit/ir/values/flags.js";
import type {
  JitFlagProducerValue,
  JitFlagWriteValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";

export type FlagValueEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  emitValue(value: JitValue, options?: WasmIrEmitValueOptions): ValueWidth;
  emitMaskedValue(value: JitValue, width: OperandWidth): ValueWidth;
}>;

export function emitFlagProducerValue(
  context: FlagValueEmitContext,
  value: JitFlagProducerValue
): ValueWidth {
  emitFlagProducerBitsFromInputs(
    context.body,
    value,
    jitFlagValueHelpers(context),
    value.mask
  );
  return cleanValueWidthForMask(value.mask);
}

export function emitFlagWriteValue(
  context: FlagValueEmitContext,
  value: JitFlagWriteValue
): ValueWidth {
  emitFlagWriteBitsFromCells(
    context.body,
    value.cells,
    jitFlagValueHelpers(context),
    value.mask
  );
  return cleanValueWidthForMask(value.mask);
}

export function emitFlagConditionValue(
  context: FlagValueEmitContext,
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
  context: FlagValueEmitContext,
  flags: JitValue,
  cc: ConditionCode
): boolean {
  const simplifiedFlags = simplifyValue(flags);
  const readMask = conditionFlagReadMask(cc);

  if (simplifiedFlags.kind === "flagProducer" && canEmitDirectFlagProducerCondition(simplifiedFlags, cc, readMask)) {
    emitDirectFlagProducerCondition(context, simplifiedFlags, cc);
    return true;
  }

  if (simplifiedFlags.kind === "flagWrite" && (readMask & ~simplifiedFlags.mask) === 0) {
    return emitDirectFlagWriteCondition(context, simplifiedFlags, cc);
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
  context: FlagValueEmitContext,
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

  if (simplifiedFlags.kind === "flagWrite") {
    const writtenReadMask = normalizedReadMask & (simplifiedFlags.mask >>> 0);

    if (writtenReadMask === 0) {
      context.body.i32Const(0);
      return cleanValueWidth(8, 0);
    }

    return emitFlagWriteValue(context, writtenReadMask === simplifiedFlags.mask
      ? simplifiedFlags
      : narrowFlagWriteToMask(simplifiedFlags, writtenReadMask));
  }

  const valueWidth = context.emitValue(simplifiedFlags, { requestedWidth: 32 });

  if (!forceMasked) {
    return valueWidth;
  }

  context.body.i32Const(i32(normalizedReadMask)).i32And();
  return cleanValueWidthForMask(normalizedReadMask);
}

function emitDirectFlagWriteCondition(
  context: FlagValueEmitContext,
  value: JitFlagWriteValue,
  cc: ConditionCode
): boolean {
  const direct = value.conditions?.[cc];

  if (direct !== undefined) {
    emitConditionTruthValue(context, direct);
    return true;
  }

  const expr = CONDITIONS[cc].expr;

  if (!flagBoolExprCellsAvailable(value, expr)) {
    return false;
  }

  emitFlagBoolExprFromCells(context, value, expr);
  return true;
}

function flagBoolExprCellsAvailable(value: JitFlagWriteValue, expr: FlagBoolExpr): boolean {
  switch (expr.kind) {
    case "flag":
      return value.cells[expr.flag]?.kind === "expr";
    case "not":
      return flagBoolExprCellsAvailable(value, expr.value);
    case "and":
    case "or":
    case "xor":
      return flagBoolExprCellsAvailable(value, expr.a) && flagBoolExprCellsAvailable(value, expr.b);
  }
}

function emitFlagBoolExprFromCells(
  context: FlagValueEmitContext,
  value: JitFlagWriteValue,
  expr: FlagBoolExpr
): void {
  switch (expr.kind) {
    case "flag": {
      const cell = value.cells[expr.flag];

      if (cell?.kind !== "expr") {
        throw new Error(`flag write condition is missing a ${expr.flag} cell expression`);
      }

      emitConditionTruthValue(context, cell.value);
      return;
    }
    case "not":
      emitFlagBoolExprFromCells(context, value, expr.value);
      context.body.i32Eqz();
      return;
    case "and":
      emitFlagBoolExprFromCells(context, value, expr.a);
      emitFlagBoolExprFromCells(context, value, expr.b);
      context.body.i32And();
      return;
    case "or":
      emitFlagBoolExprFromCells(context, value, expr.a);
      emitFlagBoolExprFromCells(context, value, expr.b);
      context.body.i32Or();
      return;
    case "xor":
      emitFlagBoolExprFromCells(context, value, expr.a);
      emitFlagBoolExprFromCells(context, value, expr.b);
      context.body.i32Xor();
      return;
  }
}

function emitConditionTruthValue(context: FlagValueEmitContext, value: JitValue): void {
  const simplified = simplifyValue(value);

  context.emitValue(simplified, { requestedWidth: 32 });

  if (!isKnownBooleanValue(simplified)) {
    context.body.i32Eqz().i32Eqz();
  }
}

function isKnownBooleanValue(value: JitValue): boolean {
  switch (value.kind) {
    case "value.compare":
    case "flagCondition":
      return true;
    case "const":
      return value.value === 0 || value.value === 1;
    default:
      return false;
  }
}

function emitDirectFlagProducerCondition(
  context: FlagValueEmitContext,
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

function jitFlagValueHelpers(
  context: FlagValueEmitContext
): WasmFlagValueEmitHelpers<JitValue> {
  return {
    emitValue: (value, options) => context.emitValue(value, options),
    emitMaskedValue: (value, width) => context.emitMaskedValue(value, width)
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
