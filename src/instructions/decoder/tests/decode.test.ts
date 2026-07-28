import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeIsaInstructionFromReader } from "#instructions/decoder/decode.js";
import { ByteArrayDecodeReader, decodeBytes, startAddress } from "./byte-reader-fixture.js";

test("decodes instruction metadata, an opcode register, and a 32-bit immediate", () => {
  const values = [0xbb, 0x78, 0x56, 0x34, 0x12];
  const reader = new ByteArrayDecodeReader(values, startAddress);
  const result = decodeIsaInstructionFromReader(reader, startAddress);

  strictEqual(result.kind, "instruction");
  if (result.kind !== "instruction") {
    return;
  }

  const decoded = result.instruction;

  strictEqual(decoded.spec.id, "mov.r32_imm32");
  strictEqual(decoded.spec.syntax, "mov {0}, {1}");
  strictEqual(decoded.address, startAddress);
  strictEqual(decoded.length, values.length);
  strictEqual(decoded.nextEip, startAddress + values.length);
  deepStrictEqual(decoded.raw, values);
  deepStrictEqual(decoded.operands, [
    {
      kind: "reg",
      alias: {
        name: "ebx",
        base: "ebx",
        bitOffset: 0,
        width: 32
      }
    },
    {
      kind: "imm",
      value: 0x1234_5678,
      encodedWidth: 32,
      semanticWidth: 32
    }
  ]);
});

test("ModRM register operands respect direction, operand size, and high-byte aliases", () => {
  const dwordResult = decodeBytes([0x8b, 0xc3]);
  const wordResult = decodeBytes([0x66, 0x8b, 0xc3]);
  const highByteResult = decodeBytes([0x86, 0xe0]);

  strictEqual(dwordResult.kind, "instruction");
  strictEqual(wordResult.kind, "instruction");
  strictEqual(highByteResult.kind, "instruction");
  if (
    dwordResult.kind !== "instruction" ||
    wordResult.kind !== "instruction" ||
    highByteResult.kind !== "instruction"
  ) {
    return;
  }

  const dword = dwordResult.instruction;
  const word = wordResult.instruction;
  const highByte = highByteResult.instruction;

  strictEqual(dword.spec.id, "mov.r32_rm32");
  deepStrictEqual(dword.operands, [
    {
      kind: "reg",
      alias: {
        name: "eax",
        base: "eax",
        bitOffset: 0,
        width: 32
      }
    },
    {
      kind: "reg",
      alias: {
        name: "ebx",
        base: "ebx",
        bitOffset: 0,
        width: 32
      }
    }
  ]);

  strictEqual(word.spec.id, "mov.r16_rm16");
  deepStrictEqual(word.operands, [
    {
      kind: "reg",
      alias: {
        name: "ax",
        base: "eax",
        bitOffset: 0,
        width: 16
      }
    },
    {
      kind: "reg",
      alias: {
        name: "bx",
        base: "ebx",
        bitOffset: 0,
        width: 16
      }
    }
  ]);

  strictEqual(highByte.spec.id, "xchg.rm8_r8");
  deepStrictEqual(highByte.operands, [
    {
      kind: "reg",
      alias: {
        name: "al",
        base: "eax",
        bitOffset: 0,
        width: 8
      }
    },
    {
      kind: "reg",
      alias: {
        name: "ah",
        base: "eax",
        bitOffset: 8,
        width: 8
      }
    }
  ]);
});

test("ModRM and SIB memory operands decode base, index, scale, and signed displacement", () => {
  const sibResult = decodeBytes([0x8b, 0x84, 0x88, 0x10, 0x00, 0x00, 0x00]);
  const negativeDisp8Result = decodeBytes([0x8b, 0x45, 0xfc]);
  const negativeDisp32Result = decodeBytes([0x8b, 0x83, 0xff, 0xff, 0xff, 0xff]);

  strictEqual(sibResult.kind, "instruction");
  strictEqual(negativeDisp8Result.kind, "instruction");
  strictEqual(negativeDisp32Result.kind, "instruction");
  if (
    sibResult.kind !== "instruction" ||
    negativeDisp8Result.kind !== "instruction" ||
    negativeDisp32Result.kind !== "instruction"
  ) {
    return;
  }

  const sib = sibResult.instruction;
  const negativeDisp8 = negativeDisp8Result.instruction;
  const negativeDisp32 = negativeDisp32Result.instruction;

  deepStrictEqual(sib.operands, [
    {
      kind: "reg",
      alias: {
        name: "eax",
        base: "eax",
        bitOffset: 0,
        width: 32
      }
    },
    {
      kind: "mem",
      accessWidth: 32,
      segment: "ds",
      base: "eax",
      index: "ecx",
      scale: 4,
      disp: 0x10
    }
  ]);

  deepStrictEqual(negativeDisp8.operands[1], {
    kind: "mem",
    accessWidth: 32,
    segment: "ss",
    base: "ebp",
    index: undefined,
    scale: 1,
    disp: -4
  });
  deepStrictEqual(negativeDisp32.operands[1], {
    kind: "mem",
    accessWidth: 32,
    segment: "ds",
    base: "ebx",
    index: undefined,
    scale: 1,
    disp: -1
  });
});

test("SIB fields select architectural bases, indexes, and scales", () => {
  const cases = [
    {
      name: "ESP base and EDX index at scale one",
      bytes: [0x8b, 0x04, 0x14],
      expected: {
        kind: "mem",
        accessWidth: 32,
        segment: "ss",
        base: "esp",
        index: "edx",
        scale: 1,
        disp: 0
      }
    },
    {
      name: "EBP base and ESI index at scale two with a signed displacement",
      bytes: [0x8b, 0x44, 0x75, 0x80],
      expected: {
        kind: "mem",
        accessWidth: 32,
        segment: "ss",
        base: "ebp",
        index: "esi",
        scale: 2,
        disp: -128
      }
    },
    {
      name: "EDI base and EBP index at scale eight",
      bytes: [0x8b, 0x04, 0xef],
      expected: {
        kind: "mem",
        accessWidth: 32,
        segment: "ds",
        base: "edi",
        index: "ebp",
        scale: 8,
        disp: 0
      }
    }
  ] as const;

  for (const entry of cases) {
    const decoded = decodeBytes(entry.bytes);

    strictEqual(decoded.kind, "instruction", entry.name);
    if (decoded.kind !== "instruction") {
      continue;
    }

    deepStrictEqual(decoded.instruction.operands[1], entry.expected, entry.name);
  }
});

test("base-free ModRM and SIB addresses retain unsigned disp32 values", () => {
  const modRmResult = decodeBytes([0x8b, 0x05, 0x00, 0x20, 0x40, 0x80]);
  const sibResult = decodeBytes([0x8b, 0x04, 0x8d, 0x00, 0x20, 0x40, 0x80]);

  strictEqual(modRmResult.kind, "instruction");
  strictEqual(sibResult.kind, "instruction");
  if (modRmResult.kind !== "instruction" || sibResult.kind !== "instruction") {
    return;
  }

  const modRm = modRmResult.instruction;
  const sib = sibResult.instruction;

  deepStrictEqual(modRm.operands[1], {
    kind: "mem",
    accessWidth: 32,
    segment: "ds",
    base: undefined,
    index: undefined,
    scale: 1,
    disp: 0x8040_2000
  });
  deepStrictEqual(sib.operands[1], {
    kind: "mem",
    accessWidth: 32,
    segment: "ds",
    base: undefined,
    index: "ecx",
    scale: 4,
    disp: 0x8040_2000
  });
});

test("immediate operands preserve encoded width and explicit sign extension", () => {
  const enterResult = decodeBytes([0xc8, 0x34, 0x12, 0x7f]);
  const subtractResult = decodeBytes([0x83, 0xeb, 0x80]);

  strictEqual(enterResult.kind, "instruction");
  strictEqual(subtractResult.kind, "instruction");
  if (enterResult.kind !== "instruction" || subtractResult.kind !== "instruction") {
    return;
  }

  const enter = enterResult.instruction;
  const subtract = subtractResult.instruction;

  strictEqual(enter.spec.id, "enter.imm16_imm8");
  deepStrictEqual(enter.operands, [
    {
      kind: "imm",
      value: 0x1234,
      encodedWidth: 16,
      semanticWidth: 16
    },
    {
      kind: "imm",
      value: 0x7f,
      encodedWidth: 8,
      semanticWidth: 8
    }
  ]);

  strictEqual(subtract.spec.id, "sub.rm32_imm8");
  deepStrictEqual(subtract.operands[1], {
    kind: "imm",
    value: 0xffff_ff80,
    encodedWidth: 8,
    semanticWidth: 32,
    extension: "sign"
  });
});

test("relative targets sign-extend each displacement width and wrap where x86 requires", () => {
  const shortResult = decodeBytes([0xeb, 0xfe]);
  const wordWrapResult = decodeBytes([0x66, 0xe9, 0x02, 0x00], 0xfffe);
  const nearResult = decodeBytes([0xe9, 0xfb, 0xff, 0xff, 0xff]);

  strictEqual(shortResult.kind, "instruction");
  strictEqual(wordWrapResult.kind, "instruction");
  strictEqual(nearResult.kind, "instruction");
  if (
    shortResult.kind !== "instruction" ||
    wordWrapResult.kind !== "instruction" ||
    nearResult.kind !== "instruction"
  ) {
    return;
  }

  const short = shortResult.instruction;
  const wordWrap = wordWrapResult.instruction;
  const near = nearResult.instruction;

  deepStrictEqual(short.operands, [
    {
      kind: "relTarget",
      width: 8,
      displacement: -2,
      target: startAddress
    }
  ]);
  deepStrictEqual(wordWrap.operands, [
    {
      kind: "relTarget",
      width: 16,
      displacement: 2,
      target: 0x0004
    }
  ]);
  deepStrictEqual(near.operands, [
    {
      kind: "relTarget",
      width: 32,
      displacement: -5,
      target: startAddress
    }
  ]);
});

test("group dispatch and memory-only operands reject non-matching ModRM forms", () => {
  const unregisteredGroup = decodeBytes([0xf7, 0xc8]);
  const registerLea = decodeBytes([0x8d, 0xc3]);
  const registerCompareExchange = decodeBytes([0x0f, 0xc7, 0xc8]);

  strictEqual(unregisteredGroup.kind, "cpuException");
  strictEqual(registerLea.kind, "cpuException");
  strictEqual(registerCompareExchange.kind, "cpuException");
  if (
    unregisteredGroup.kind !== "cpuException" ||
    registerLea.kind !== "cpuException" ||
    registerCompareExchange.kind !== "cpuException"
  ) {
    return;
  }

  for (const decoded of [unregisteredGroup, registerLea, registerCompareExchange]) {
    deepStrictEqual(decoded.exception, { kind: "UD" });
    strictEqual(decoded.instructionStart, startAddress);
  }

  deepStrictEqual(unregisteredGroup.raw, [0xf7, 0xc8]);
  deepStrictEqual(registerLea.raw, [0x8d, 0xc3]);
  deepStrictEqual(registerCompareExchange.raw, [0x0f, 0xc7, 0xc8]);
});
