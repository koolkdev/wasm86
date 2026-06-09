import {
  x86ArithmeticFlagMask,
  x86ArithmeticFlags,
  x86ArithmeticFlagsMask
} from "#x86/flags.js";
import type { FlagName } from "#ir/model/flags.js";
import type { OperandWidth } from "#x86/types.js";
import { i32 } from "#x86/numeric.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { IrFlagWriteExprOp, IrValueExpr } from "./expressions.js";
import type { WasmIrAluFlagsStorage } from "./alu-flags.js";
import {
  type WasmIrEmitValueOptions,
  type ValueWidth
} from "./value-width.js";

const flagOrder = x86ArithmeticFlags satisfies readonly FlagName[];

export type WasmFlagValueEmitHelpers<T> = Readonly<{
  emitValue(value: T, options?: WasmIrEmitValueOptions): ValueWidth;
  emitMaskedValue(value: T, width: OperandWidth): ValueWidth;
}>;

export type FlagWriteBitsCell<T> =
  | Readonly<{ kind: "expr"; value: T }>
  | Readonly<{ kind: "undef" }>;

export type FlagWriteBitsCells<T> = Readonly<Partial<Record<FlagName, FlagWriteBitsCell<T>>>>;

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
    emitFlagWriteBitsFromCells(body, descriptor.cells, helpers, x86ArithmeticFlagsMask);
    body.i32Or();
  });
}

export function emitFlagWriteBitsFromCells<T>(
  body: WasmFunctionBodyEncoder,
  cells: FlagWriteBitsCells<T>,
  helpers: WasmFlagValueEmitHelpers<T>,
  mask: number
): void {
  let hasWrittenBit = false;

  for (const flag of flagOrder) {
    const cell = cells[flag];

    if (cell === undefined || cell.kind === "undef" || (mask & x86ArithmeticFlagMask[flag]) === 0) {
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

function flagBit(flag: FlagName): number {
  return Math.log2(x86ArithmeticFlagMask[flag]);
}
