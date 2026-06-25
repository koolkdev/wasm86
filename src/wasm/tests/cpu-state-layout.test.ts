import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { eipChannel, flagChannel, gprChannel, lazyFlagsAChannel, lazyFlagsBChannel, lazyFlagsKindChannel } from "#ir/slots.js";
import { x86Flags } from "#x86/flags.js";
import { reg16, reg32, reg8 } from "#x86/types.js";
import { registerAlias } from "#x86/registers.js";
import {
  WASM_CPU_FLAG_BYTE_OFFSETS,
  WASM_CPU_STATE_BYTE_LENGTH,
  WASM_CPU_STATE_FIELDS,
  WASM_CPU_STATE_LAYOUT,
  WASM_CPU_STATE_OFFSETS,
  wasmCpuStateChannelAccessByteLength,
  wasmCpuStateChannelOffset,
  wasmCpuFlagByteOffset
} from "#wasm/cpu-state-layout.js";

test("cpu state layout fields and flag offsets are stable", () => {
  deepStrictEqual(WASM_CPU_FLAG_BYTE_OFFSETS, {
    CF: 41,
    PF: 42,
    AF: 43,
    ZF: 44,
    SF: 45,
    OF: 46,
    DF: 47,
    TF: 48,
    NT: 49,
    AC: 50,
    ID: 51
  });
  strictEqual(WASM_CPU_STATE_OFFSETS.lazyFlagsKind, 40);
  strictEqual(WASM_CPU_STATE_OFFSETS.lazyFlagsA, 52);
  strictEqual(WASM_CPU_STATE_OFFSETS.lazyFlagsB, 56);
  strictEqual(WASM_CPU_STATE_BYTE_LENGTH, 60);

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

  strictEqual(wasmCpuStateChannelOffset(lazyFlagsKindChannel), WASM_CPU_STATE_OFFSETS.lazyFlagsKind);
  strictEqual(wasmCpuStateChannelOffset(lazyFlagsAChannel), WASM_CPU_STATE_OFFSETS.lazyFlagsA);
  strictEqual(wasmCpuStateChannelOffset(lazyFlagsBChannel), WASM_CPU_STATE_OFFSETS.lazyFlagsB);
  strictEqual(wasmCpuStateChannelAccessByteLength(lazyFlagsKindChannel), 1);
  strictEqual(wasmCpuStateChannelAccessByteLength(lazyFlagsAChannel), 4);
  strictEqual(wasmCpuStateChannelAccessByteLength(lazyFlagsBChannel), 4);
});
