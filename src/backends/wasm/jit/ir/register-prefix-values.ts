import { widthMask, type OperandWidth, type RegisterAlias, type Reg32 } from "#x86/isa/types.js";
import type { StorageRef } from "#x86/ir/model/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type { JitValue } from "#backends/wasm/jit/ir/values.js";

export type JitRegisterAccess = Readonly<{
  reg: Reg32;
  width: OperandWidth;
  bitOffset: RegisterAlias["bitOffset"];
}>;

export type JitRegisterPrefixValue = Readonly<{
  width: OperandWidth;
  value: JitValue;
}>;

export type JitRegisterAccessState = {
  prefix?: JitRegisterPrefixValue | undefined;
};

export type JitRegisterValueEntry = JitValue | JitRegisterAccessState;
export type JitRegisterValueMap = ReadonlyMap<Reg32, JitRegisterValueEntry>;

const fullWidth = 32;

export function createRegisterAccessState(): JitRegisterAccessState {
  return {};
}

export function readRegisterAccess(
  regState: JitRegisterAccessState | undefined,
  width: OperandWidth,
  bitOffset: RegisterAlias["bitOffset"]
): JitValue | undefined {
  const prefix = regState?.prefix;

  if (prefix === undefined || bitOffset + width > prefix.width) {
    return undefined;
  }

  return extractJitRegisterAccessValue(prefix.value, width, bitOffset);
}

export function writeRegisterAccess(
  regState: JitRegisterAccessState,
  width: OperandWidth,
  bitOffset: RegisterAlias["bitOffset"],
  value: JitValue
): void {
  if (bitOffset !== 0) {
    delete regState.prefix;
    return;
  }

  regState.prefix = { width, value };
}

export function extractJitRegisterAccessValue(
  value: JitValue,
  width: OperandWidth,
  bitOffset: RegisterAlias["bitOffset"]
): JitValue {
  if (width === fullWidth && bitOffset === 0) {
    return value;
  }

  if (value.kind === "const") {
    return {
      kind: "const",
      type: value.type,
      value: i32(width === fullWidth
        ? value.value >>> bitOffset
        : (value.value >>> bitOffset) & widthMask(width))
    };
  }

  if (width !== fullWidth) {
    return {
      kind: "extractBits",
      value,
      bitOffset,
      width
    };
  }

  const shifted = bitOffset === 0
    ? value
    : {
      kind: "value.binary" as const,
      type: "i32" as const,
      operator: "shr_u" as const,
      a: value,
      b: { kind: "const" as const, type: "i32" as const, value: bitOffset }
    };

  return width === fullWidth
    ? shifted
    : {
      kind: "value.binary",
      type: "i32",
      operator: "and",
      a: shifted,
      b: { kind: "const", type: "i32", value: widthMask(width) }
    };
}

export function jitStorageRegisterAccess(
  storage: StorageRef,
  operands: readonly JitOperandBinding[],
  accessWidth: OperandWidth = fullWidth
): JitRegisterAccess | undefined {
  switch (storage.kind) {
    case "reg":
      return { reg: storage.reg, width: accessWidth, bitOffset: 0 };
    case "operand": {
      const binding = operands[storage.index]!;

      return binding.kind === "static.reg"
        ? {
          reg: binding.alias.base,
          width: binding.alias.width,
          bitOffset: binding.alias.bitOffset
        }
        : undefined;
    }
    case "mem":
      return undefined;
  }
}

export function readRegisterValueEntry(
  entry: JitRegisterValueEntry | undefined,
  width: OperandWidth,
  bitOffset: RegisterAlias["bitOffset"]
): JitValue | undefined {
  if (entry === undefined) {
    return undefined;
  }

  if (jitRegisterValueEntryIsState(entry)) {
    return readRegisterAccess(entry, width, bitOffset);
  }

  return width === fullWidth && bitOffset === 0
    ? entry
    : extractJitRegisterAccessValue(entry, width, bitOffset);
}

export function fullRegisterValueForEntry(entry: JitRegisterValueEntry | undefined): JitValue | undefined {
  if (entry === undefined) {
    return undefined;
  }

  if (!jitRegisterValueEntryIsState(entry)) {
    return entry;
  }

  return entry.prefix?.width === fullWidth ? entry.prefix.value : undefined;
}

export function registerValueEntryHasFullValue(entry: JitRegisterValueEntry | undefined): boolean {
  return fullRegisterValueForEntry(entry) !== undefined;
}

function jitRegisterValueEntryIsState(entry: JitRegisterValueEntry): entry is JitRegisterAccessState {
  return !("kind" in entry);
}
