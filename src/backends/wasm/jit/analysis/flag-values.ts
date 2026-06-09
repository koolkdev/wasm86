import {
  flagProducerInputsFromRecord
} from "#ir/model/flags.js";
import type { ConditionCode, IrFlagSetOp } from "#ir/model/types.js";
import {
  x86ArithmeticFlagMask,
  x86ArithmeticFlags
} from "#x86/flags.js";
import type { IrFlagWriteExprOp, IrValueExpr } from "#wasm/codegen/expressions.js";
import {
  jitFlagProducerValue,
  jitFlagWriteValue
} from "#backends/wasm/jit/ir/values/builders.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type {
  JitFlagWriteCell,
  JitFlagWriteValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";

export function jitFlagSetWrittenMask(op: Pick<IrFlagSetOp, "writtenMask" | "undefMask">): number {
  return (op.writtenMask | op.undefMask) >>> 0;
}

export function jitFlagWriteWrittenMask(op: Pick<IrFlagWriteExprOp, "cells">): number {
  let mask = 0;

  for (const flag of x86ArithmeticFlags) {
    if (op.cells[flag] !== undefined) {
      mask |= x86ArithmeticFlagMask[flag];
    }
  }

  return mask;
}

export function jitFlagWriteBitsValue(
  op: IrFlagWriteExprOp,
  resolveValue: (expr: IrValueExpr) => JitValue
): JitValue {
  const cells: Partial<Record<(typeof x86ArithmeticFlags)[number], JitFlagWriteCell>> = {};

  for (const flag of x86ArithmeticFlags) {
    const cell = op.cells[flag];

    if (cell === undefined) {
      continue;
    }

    cells[flag] = cell.kind === "expr"
      ? { kind: "expr", value: resolveValue(cell.value) }
      : { kind: "undef" };
  }

  return simplifyValue(jitFlagWriteValue(cells, jitFlagWriteConditions(op, resolveValue)));
}

function jitFlagWriteConditions(
  op: IrFlagWriteExprOp,
  resolveValue: (expr: IrValueExpr) => JitValue
): JitFlagWriteValue["conditions"] {
  if (op.conditions === undefined) {
    return undefined;
  }

  const conditions: Partial<Record<ConditionCode, JitValue>> = {};

  for (const [cc, expr] of Object.entries(op.conditions)) {
    if (expr !== undefined) {
      conditions[cc as ConditionCode] = resolveValue(expr);
    }
  }

  return conditions;
}

export function jitFlagSetProducerValue(
  op: IrFlagSetOp,
  inputs: Readonly<Record<string, JitValue>>
): JitValue {
  return simplifyValue(jitFlagProducerValue(
    op.producer,
    flagProducerInputsFromRecord(op.producer, inputs),
    {
      ...(op.width === undefined ? {} : { width: op.width }),
      mask: jitFlagSetWrittenMask(op)
    }
  ));
}
