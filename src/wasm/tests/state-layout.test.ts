import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { eipChannel, flagChannel, gprChannel } from "#ir/action/slots.js";
import { x86ArithmeticFlags } from "#x86/flags.js";
import { reg16, reg32, reg8 } from "#x86/types.js";
import { registerAlias } from "#x86/registers.js";
import {
  WASM_FLAG_BYTE_OFFSETS,
  WASM_STATE_BYTE_LENGTH,
  WASM_STATE_FIELDS,
  WASM_STATE_OFFSETS,
  channelStateOffset,
  flagStateOffset
} from "#wasm/state-layout.js";

test("flag byte offsets are stable and disjoint from existing fields", () => {
  deepStrictEqual(WASM_FLAG_BYTE_OFFSETS, {
    CF: 52,
    PF: 53,
    AF: 54,
    ZF: 55,
    SF: 56,
    OF: 57
  });
  strictEqual(WASM_STATE_BYTE_LENGTH, 58);

  const existingFieldsEnd = Math.max(...WASM_STATE_FIELDS.map((field) => WASM_STATE_OFFSETS[field] + 4));

  for (const flag of x86ArithmeticFlags) {
    strictEqual(flagStateOffset(flag), WASM_FLAG_BYTE_OFFSETS[flag]);
    strictEqual(flagStateOffset(flag) >= existingFieldsEnd, true);
    strictEqual(flagStateOffset(flag) + 1 <= WASM_STATE_BYTE_LENGTH, true);
  }
});

test("channel offsets derive from the register word offset plus the byte offset", () => {
  for (const name of [...reg32, ...reg16, ...reg8]) {
    const alias = registerAlias(name);

    strictEqual(channelStateOffset(gprChannel(name)), WASM_STATE_OFFSETS[alias.base] + alias.bitOffset / 8, name);
  }

  strictEqual(channelStateOffset(eipChannel), WASM_STATE_OFFSETS.eip);

  for (const flag of x86ArithmeticFlags) {
    strictEqual(channelStateOffset(flagChannel(flag)), WASM_FLAG_BYTE_OFFSETS[flag]);
  }
});
