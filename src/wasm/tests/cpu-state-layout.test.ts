import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { eipChannel, flagChannel, gprChannel } from "#ir/slots.js";
import { x86Flags } from "#x86/flags.js";
import { reg16, reg32, reg8 } from "#x86/types.js";
import { registerAlias } from "#x86/registers.js";
import {
  WASM_CPU_FLAG_BYTE_OFFSETS,
  WASM_CPU_STATE_BYTE_LENGTH,
  WASM_CPU_STATE_FIELDS,
  WASM_CPU_STATE_LAYOUT,
  WASM_CPU_STATE_OFFSETS,
  wasmCpuStateChannelOffset,
  wasmCpuFlagByteOffset
} from "#wasm/cpu-state-layout.js";

test("cpu state layout fields and flag offsets are stable", () => {
  deepStrictEqual(WASM_CPU_FLAG_BYTE_OFFSETS, {
    CF: 44,
    PF: 45,
    AF: 46,
    ZF: 47,
    SF: 48,
    OF: 49,
    DF: 50,
    TF: 51,
    NT: 52,
    AC: 53,
    ID: 54
  });
  strictEqual(WASM_CPU_STATE_BYTE_LENGTH, 55);

  for (const field of WASM_CPU_STATE_FIELDS) {
    strictEqual(WASM_CPU_STATE_OFFSETS[field], WASM_CPU_STATE_LAYOUT[field].offset);
    strictEqual(WASM_CPU_STATE_OFFSETS[field] + WASM_CPU_STATE_LAYOUT[field].byteLength <= WASM_CPU_STATE_BYTE_LENGTH, true);
  }

  for (const flag of x86Flags) {
    strictEqual(wasmCpuFlagByteOffset(flag), WASM_CPU_FLAG_BYTE_OFFSETS[flag]);
    strictEqual(WASM_CPU_STATE_LAYOUT[flag].byteLength, 1);
  }
});

test("channel offsets derive from the register word offset plus the byte offset", () => {
  for (const name of [...reg32, ...reg16, ...reg8]) {
    const alias = registerAlias(name);

    strictEqual(wasmCpuStateChannelOffset(gprChannel(name)), WASM_CPU_STATE_OFFSETS[alias.base] + alias.bitOffset / 8, name);
  }

  strictEqual(wasmCpuStateChannelOffset(eipChannel), WASM_CPU_STATE_OFFSETS.eip);

  for (const flag of x86Flags) {
    strictEqual(wasmCpuStateChannelOffset(flagChannel(flag)), WASM_CPU_FLAG_BYTE_OFFSETS[flag]);
  }
});
