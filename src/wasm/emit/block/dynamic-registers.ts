import { assert } from "#common/assert.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  wasmValueType,
  type WasmValueType
} from "#wasm/encoder/types.js";
import type { RegisterStateTarget } from "#ir/block/state/targets.js";
import { registerAliasesByWidth } from "#x86/registers.js";
import {
  type OperandWidth,
  type RegisterAlias
} from "#x86/types.js";
import type { WasmValueCacheLocalEmission } from "../cache/locals/index.js";
import type { WasmTargetStorage } from "../targets/storage.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "../values/types.js";

type EmitIndex = () => void;
type EmitRegister = (alias: RegisterAlias, options: Readonly<{ signed?: boolean }>) => WasmEmittedValue;
type EmitRegisterCase = (caseIndex: number) => void;

const registerCount = 8;
const defaultRegisterCase = registerCount;
const registerCaseCount = registerCount + 1;

export function emitLoadDynamicRegister(
  body: WasmFunctionBodyEncoder,
  width: OperandWidth,
  emitIndex: EmitIndex,
  emitRegister: EmitRegister,
  signed = false
): WasmEmittedValue {
  const aliases = registerAliasesByWidth[width];

  emitRegisterIndexSwitch(body, wasmValueType.i32, emitIndex, (caseIndex) => {
    if (caseIndex === defaultRegisterCase) {
      body.i32Const(0);
      return;
    }

    const alias = aliases[caseIndex];

    assert(alias !== undefined, `dynamic register load case ${caseIndex} is out of range`);

    emitRegister(alias, { signed });
  });

  return wasmI32(signed ? 32 : width);
}

export function emitStoreDynamicRegister(
  body: WasmFunctionBodyEncoder,
  width: OperandWidth,
  emitIndex: EmitIndex,
  value: Pick<WasmValueCacheLocalEmission, "local">,
  registers: WasmTargetStorage<RegisterStateTarget>
): void {
  const aliases = registerAliasesByWidth[width];

  emitRegisterIndexSwitch(body, undefined, emitIndex, (caseIndex) => {
    if (caseIndex === defaultRegisterCase) {
      return;
    }

    const alias = aliases[caseIndex];

    assert(alias !== undefined, `dynamic register store case ${caseIndex} is out of range`);

    registers.emitStore({ kind: "reg", reg: alias }, () => {
      body.localGet(value.local);
      return wasmI32(32);
    });
  });
}

function emitRegisterIndexSwitch(
  body: WasmFunctionBodyEncoder,
  result: WasmValueType | undefined,
  emitIndex: EmitIndex,
  emitCase: EmitRegisterCase
): void {
  body.block(result);

  for (let index = 0; index < registerCaseCount; index += 1) {
    body.block();
  }

  emitIndex();
  body.brTable(registerIndexDispatchTable(), 0);

  for (let caseIndex = defaultRegisterCase; caseIndex >= 0; caseIndex -= 1) {
    body.endBlock();
    emitCase(caseIndex);
    body.br(caseIndex);
  }

  body.endBlock();
}

function registerIndexDispatchTable(): number[] {
  return new Array(registerCount).fill(undefined)
    .map((_value, index) => defaultRegisterCase - index);
}
