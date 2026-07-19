import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  PageFaultErrorCode,
  generalProtection,
  invalidOpcode,
  pageFault
} from "#core/exceptions.js";
import { decodeJitBlock } from "#engines/jit/decode-block.js";
import { guestMemoryMinimumByteLength } from "#memory/constants.js";
import { jitMemoryWithBytes } from "./decode-helpers.js";

const startAddress = 0x1000;

test("decodeJitBlock decodes until an unconditional control instruction", () => {
  for (const [bytes, id] of [
    [[0xeb, 0x00], "jmp.rel8"],
    [[0xe8, 0x00, 0x00, 0x00, 0x00], "call.rel32"],
    [[0xc3], "ret.near"],
    [[0xcd, 0x2e], "int.imm8"],
    [[0xcc], "int3.near"]
  ] as const) {
    const block = decodeJitBlock(memory([0x90, ...bytes, 0x90]), startAddress);

    deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32", id]);
    strictEqual(block.terminator.kind, "control", id);

    if (id === "int.imm8" && block.terminator.kind === "control") {
      deepStrictEqual(block.terminator.instruction.operands, [{
        kind: "imm",
        value: 0x2e,
        encodedWidth: 8,
        semanticWidth: 8
      }]);
    }
  }
});

test("decodeJitBlock keeps conditional control inside fallthrough blocks", () => {
  for (const [bytes, id] of [
    [[0xce], "into.near"],
    [[0x75, 0x00], "jne.rel8"],
    [[0xe3, 0x00], "jecxz.rel8"],
    [[0xe2, 0x00], "loop.rel8"],
    [[0xe1, 0x00], "loope.rel8"],
    [[0xe0, 0x00], "loopne.rel8"]
  ] as const) {
    const block = decodeJitBlock(
      memory([0x90, ...bytes, 0x90]),
      startAddress,
      { maxInstructions: 3 }
    );

    deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), [
      "xchg.eax_r32",
      id,
      "xchg.eax_r32"
    ]);
    deepStrictEqual(block.terminator, {
      kind: "fallthrough",
      nextEip: startAddress + bytes.length + 2
    });
  }
});

test("decodeJitBlock returns fallthrough when its instruction limit ends the block", () => {
  const block = decodeJitBlock(
    memory([0x90, 0x90, 0xcd, 0x2e]),
    startAddress,
    { maxInstructions: 2 }
  );

  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), [
    "xchg.eax_r32",
    "xchg.eax_r32"
  ]);
  deepStrictEqual(block.terminator, { kind: "fallthrough", nextEip: startAddress + 2 });
});

test("decodeJitBlock carries a first-instruction invalid-opcode terminal", () => {
  const block = decodeJitBlock(memory([0x62]), startAddress);

  deepStrictEqual(block.instructions, []);
  deepStrictEqual(block.terminator, {
    kind: "cpuException",
    exception: invalidOpcode(),
    instructionStart: startAddress,
    raw: [0x62]
  });
});

test("decodeJitBlock places invalid opcode after a decoded instruction prefix", () => {
  const block = decodeJitBlock(memory([0x90, 0x62, 0x90]), startAddress);

  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32"]);
  deepStrictEqual(block.terminator, {
    kind: "cpuException",
    exception: invalidOpcode(),
    instructionStart: startAddress + 1,
    raw: [0x62]
  });
});

test("decodeJitBlock carries an instruction-fetch page fault", () => {
  const block = decodeJitBlock(
    memory([]),
    guestMemoryMinimumByteLength
  );

  deepStrictEqual(block.instructions, []);
  deepStrictEqual(block.terminator, {
    kind: "cpuException",
    exception: pageFault(
      guestMemoryMinimumByteLength,
      PageFaultErrorCode.INSTRUCTION_FETCH
    ),
    instructionStart: guestMemoryMinimumByteLength,
    raw: []
  });
});

test("decodeJitBlock places a fetch page fault after decoded instructions", () => {
  const instructionStart = guestMemoryMinimumByteLength - 2;
  const block = decodeJitBlock(
    memory([0x90, 0xb8], instructionStart),
    instructionStart
  );

  deepStrictEqual(block.instructions.map((instruction) => instruction.spec.id), ["xchg.eax_r32"]);
  deepStrictEqual(block.terminator, {
    kind: "cpuException",
    exception: pageFault(
      guestMemoryMinimumByteLength,
      PageFaultErrorCode.INSTRUCTION_FETCH
    ),
    instructionStart: guestMemoryMinimumByteLength - 1,
    raw: [0xb8]
  });
});

test("decodeJitBlock gives the instruction limit priority over a fetch fault", () => {
  const bytes = new Array<number>(15).fill(0x66);
  const instructionStart = guestMemoryMinimumByteLength - bytes.length;
  const block = decodeJitBlock(memory(bytes, instructionStart), instructionStart);

  deepStrictEqual(block.instructions, []);
  deepStrictEqual(block.terminator, {
    kind: "cpuException",
    exception: generalProtection(0),
    instructionStart,
    raw: bytes
  });
});

test("decodeJitBlock does not reinterpret an invalid Memory binding", () => {
  throws(
    () => decodeJitBlock(new WebAssembly.Memory({ initial: 0 }), startAddress),
    /guest memory is shorter than the flat address-space binding/
  );
});

function memory(
  values: readonly number[],
  address = startAddress
): WebAssembly.Memory {
  return jitMemoryWithBytes(values, address);
}
