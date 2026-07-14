import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { cpuExecutionStateFields } from "#cpu/execution-state.js";
import { flagStateFields } from "#core/flags/state.js";
import { eipField, gprFields, segmentFields } from "#core/state/fields.js";
import {
  eipChannel,
  flagChannel,
  gprChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  segmentAccessChannel,
  segmentBaseChannel,
  segmentLimitChannel,
  segmentSelectorChannel
} from "#ir/slots.js";
import { x86Flags } from "#core/flags/definitions.js";
import { reg16, reg32, reg8, segmentRegisters } from "#core/types.js";
import { registerAlias } from "#core/registers.js";
import {
  WASM_CPU_FLAG_BYTE_OFFSETS,
  WASM_CPU_SEGMENT_ACCESS_OFFSET,
  WASM_CPU_SEGMENT_BASE_OFFSET,
  WASM_CPU_SEGMENT_LIMIT_OFFSET,
  WASM_CPU_SEGMENT_SELECTOR_OFFSET,
  WASM_CPU_STATE_FIELDS,
  WASM_CPU_STATE_LAYOUT,
  WASM_CPU_STATE_OFFSETS,
  wasmCpuStateChannelAccessByteLength,
  wasmCpuStateChannelOffset,
  wasmCpuFlagByteOffset
} from "#wasm/cpu-state-layout.js";

test("combined cpu state layout uses the owner field definitions", () => {
  deepStrictEqual(reg32.map((reg) => WASM_CPU_STATE_LAYOUT[reg]), gprFields);
  strictEqual(WASM_CPU_STATE_LAYOUT.eip, eipField);
  strictEqual(WASM_CPU_STATE_LAYOUT.instructionCount, cpuExecutionStateFields.instructionCount);
  strictEqual(WASM_CPU_STATE_LAYOUT.lazyFlagsKind, flagStateFields.lazyKind);
  strictEqual(WASM_CPU_STATE_LAYOUT.lazyFlagsA, flagStateFields.lazyA);
  strictEqual(WASM_CPU_STATE_LAYOUT.lazyFlagsB, flagStateFields.lazyB);

  for (const field of WASM_CPU_STATE_FIELDS) {
    strictEqual(WASM_CPU_STATE_OFFSETS[field], WASM_CPU_STATE_LAYOUT[field].offset);
  }

  for (const flag of x86Flags) {
    strictEqual(wasmCpuFlagByteOffset(flag), WASM_CPU_FLAG_BYTE_OFFSETS[flag]);
    strictEqual(WASM_CPU_STATE_LAYOUT[flag], flagStateFields.concrete[flag]);
  }

  for (const [index, reg] of segmentRegisters.entries()) {
    strictEqual(WASM_CPU_STATE_LAYOUT[`${reg}Selector`], segmentFields.selectors[index]);
    strictEqual(WASM_CPU_STATE_LAYOUT[`${reg}Base`], segmentFields.bases[index]);
    strictEqual(WASM_CPU_STATE_LAYOUT[`${reg}Limit`], segmentFields.limits[index]);
    strictEqual(WASM_CPU_STATE_LAYOUT[`${reg}Access`], segmentFields.access[index]);
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

  for (const reg of segmentRegisters) {
    const index = segmentRegisters.indexOf(reg);

    strictEqual(wasmCpuStateChannelOffset(segmentSelectorChannel(reg)), WASM_CPU_STATE_OFFSETS[`${reg}Selector`]);
    strictEqual(wasmCpuStateChannelOffset(segmentBaseChannel(reg)), WASM_CPU_STATE_OFFSETS[`${reg}Base`]);
    strictEqual(wasmCpuStateChannelOffset(segmentSelectorChannel(reg)), WASM_CPU_SEGMENT_SELECTOR_OFFSET + index * 2);
    strictEqual(wasmCpuStateChannelOffset(segmentBaseChannel(reg)), WASM_CPU_SEGMENT_BASE_OFFSET + index * 4);
    strictEqual(wasmCpuStateChannelOffset(segmentLimitChannel(reg)), WASM_CPU_STATE_OFFSETS[`${reg}Limit`]);
    strictEqual(wasmCpuStateChannelOffset(segmentAccessChannel(reg)), WASM_CPU_STATE_OFFSETS[`${reg}Access`]);
    strictEqual(wasmCpuStateChannelOffset(segmentLimitChannel(reg)), WASM_CPU_SEGMENT_LIMIT_OFFSET + index * 4);
    strictEqual(wasmCpuStateChannelOffset(segmentAccessChannel(reg)), WASM_CPU_SEGMENT_ACCESS_OFFSET + index * 4);
    strictEqual(wasmCpuStateChannelAccessByteLength(segmentSelectorChannel(reg)), 2);
    strictEqual(wasmCpuStateChannelAccessByteLength(segmentBaseChannel(reg)), 4);
    strictEqual(wasmCpuStateChannelAccessByteLength(segmentLimitChannel(reg)), 4);
    strictEqual(wasmCpuStateChannelAccessByteLength(segmentAccessChannel(reg)), 4);
  }
});
