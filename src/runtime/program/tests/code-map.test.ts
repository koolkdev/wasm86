import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeIsaInstructionFromReader } from "#core/decoder/decode.js";
import { RuntimeCodeMap } from "#runtime/program/code-map.js";
import { loadProgramRegions } from "#runtime/program/loader.js";
import { codeRegionsFromProgram, normalizeProgramRegions, requiredProgramByteLength } from "#runtime/program/regions.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";

const startAddress = 0x1000;

test("normalizes program input and computes required memory length", () => {
  const regions = normalizeProgramRegions({
    baseAddress: startAddress,
    bytes: [0x90, 0xcd, 0x2e]
  });

  strictEqual(regions.length, 1);
  strictEqual(requiredProgramByteLength(regions), startAddress + 3);
  deepStrictEqual(codeRegionsFromProgram(regions), [
    { baseAddress: startAddress, byteLength: 3 }
  ]);
});

test("code map creates guest-memory decode readers for executable regions", () => {
  const program = normalizeProgramRegions({
    baseAddress: startAddress,
    bytes: [0xb8, 0x78, 0x56, 0x34, 0x12]
  });
  const codeMap = new RuntimeCodeMap(codeRegionsFromProgram(program));
  const memories = createWasmHostMemories({ guestMemoryByteLength: startAddress + 5 });

  strictEqual(loadProgramRegions(memories.guestMemory, program), undefined);
  strictEqual(codeMap.contains(startAddress), true);
  strictEqual(codeMap.contains(startAddress + 5), false);

  const decoded = decodeIsaInstructionFromReader(codeMap.createReader(memories.guestMemory), startAddress);

  strictEqual(decoded.kind, "ok");
  if (decoded.kind === "ok") {
    strictEqual(decoded.instruction.spec.id, "mov.r32_imm32");
    deepStrictEqual(decoded.instruction.raw, [0xb8, 0x78, 0x56, 0x34, 0x12]);
  }
});
