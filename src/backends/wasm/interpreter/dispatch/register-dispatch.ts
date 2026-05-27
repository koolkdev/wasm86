import type { OperandWidth, Reg32 } from "#x86/types.js";
import { reg32 } from "#x86/types.js";
import { registerAliasByIndex } from "#x86/registers.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { wasmValueType, type WasmValueType } from "#wasm/encoder/types.js";
import {
  emitLoadRegAlias,
  emitStoreRegAlias
} from "#wasm/codegen/registers.js";
import {
  cleanValueWidth,
  dirtyValueWidth,
  type WasmIrEmitValueOptions,
  type ValueWidth
} from "#wasm/codegen/value-width.js";

type Reg32Locals = Readonly<Record<Reg32, number>>;
type EmitIndex = () => void;

const REGISTER_COUNT = reg32.length;
const DEFAULT_REGISTER_CASE = REGISTER_COUNT;
const REGISTER_CASE_COUNT = REGISTER_COUNT + 1;
const REGISTER_INDEX_MASK = 0b111;

export function emitCopyRegFromIndexLocal(
  body: WasmFunctionBodyEncoder,
  regs: Reg32Locals,
  width: OperandWidth,
  indexLocal: number,
  targetLocal: number
): void {
  emitLoadRegByIndex(body, regs, width, () => {
    body.localGet(indexLocal);
  });
  body.localSet(targetLocal);
}

export function emitLoadRegByIndex(
  body: WasmFunctionBodyEncoder,
  regs: Reg32Locals,
  width: OperandWidth,
  emitIndex: EmitIndex,
  options: WasmIrEmitValueOptions = {}
): ValueWidth {
  emitRegisterIndexSwitch(body, wasmValueType.i32, emitIndex, (caseIndex) => {
    if (caseIndex === DEFAULT_REGISTER_CASE) {
      body.i32Const(0);
      return;
    }

    emitLoadRegAlias(body, regs, registerAliasByIndex(width, caseIndex), options);
  });

  if (options.signed === true && width < 32) {
    return cleanValueWidth(32);
  }

  return options.widthInsensitive === true && width < 32 ? dirtyValueWidth(width) : cleanValueWidth(width);
}

export function emitStoreRegByIndex(
  body: WasmFunctionBodyEncoder,
  regs: Reg32Locals,
  width: OperandWidth,
  emitIndex: EmitIndex,
  valueLocal: number,
  valueWidth: ValueWidth = cleanValueWidth(32)
): void {
  emitRegisterIndexSwitch(body, undefined, emitIndex, (caseIndex) => {
    if (caseIndex === DEFAULT_REGISTER_CASE) {
      return;
    }

    emitStoreRegAlias(body, regs, registerAliasByIndex(width, caseIndex), () => {
      body.localGet(valueLocal);
      return valueWidth;
    });
  });
}

export function emitOpcodeRegIndex(body: WasmFunctionBodyEncoder, opcodeLocal: number): void {
  body.localGet(opcodeLocal).i32Const(REGISTER_INDEX_MASK).i32And();
}

export function emitModRmRmIndex(body: WasmFunctionBodyEncoder, modRmLocal: number): void {
  body.localGet(modRmLocal).i32Const(REGISTER_INDEX_MASK).i32And();
}

function emitRegisterIndexSwitch(
  body: WasmFunctionBodyEncoder,
  result: WasmValueType | undefined,
  emitIndex: EmitIndex,
  emitCase: (caseIndex: number) => void
): void {
  body.block(result);

  // One block per register plus an innermost default block. br_table depths count
  // from innermost to outermost, so register index 0 maps to the largest depth.
  for (let index = 0; index < REGISTER_CASE_COUNT; index += 1) {
    body.block();
  }

  emitIndex();
  body.brTable(registerIndexDispatchTable(), 0);

  for (let caseIndex = DEFAULT_REGISTER_CASE; caseIndex >= 0; caseIndex -= 1) {
    body.endBlock();
    emitCase(caseIndex);
    body.br(caseIndex);
  }

  body.endBlock();
}

function registerIndexDispatchTable(): number[] {
  return reg32.map((_reg, index) => DEFAULT_REGISTER_CASE - index);
}
