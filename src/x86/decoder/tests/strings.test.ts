import { strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeBytes, mem, ok, testDecodeFixtures } from "./helpers.js";

testDecodeFixtures([
  {
    name: "movs byte",
    bytes: [0xa4],
    mnemonic: "movs",
    operands: [
      mem(8, { base: "esi", scale: 1, disp: 0 }),
      mem(8, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "movs.m8_m8",
    format: "movs"
  },
  {
    name: "movs word with operand-size override",
    bytes: [0x66, 0xa5],
    mnemonic: "movs",
    operands: [
      mem(16, { base: "esi", scale: 1, disp: 0 }),
      mem(16, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "movs.m16_m16",
    format: "movs"
  },
  {
    name: "rep movs word with rep before operand-size override",
    bytes: [0xf3, 0x66, 0xa5],
    mnemonic: "movs",
    operands: [
      mem(16, { base: "esi", scale: 1, disp: 0 }),
      mem(16, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "movs.rep_m16_m16",
    format: "rep movs"
  },
  {
    name: "rep movs word with operand-size override before rep",
    bytes: [0x66, 0xf3, 0xa5],
    mnemonic: "movs",
    operands: [
      mem(16, { base: "esi", scale: 1, disp: 0 }),
      mem(16, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "movs.rep_m16_m16",
    format: "rep movs"
  },
  {
    name: "movs dword",
    bytes: [0xa5],
    mnemonic: "movs",
    operands: [
      mem(32, { base: "esi", scale: 1, disp: 0 }),
      mem(32, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "movs.m32_m32",
    format: "movs"
  },
  {
    name: "last rep-group prefix wins for movs",
    bytes: [0xf2, 0xf3, 0xa5],
    mnemonic: "movs",
    operands: [
      mem(32, { base: "esi", scale: 1, disp: 0 }),
      mem(32, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "movs.rep_m32_m32",
    format: "rep movs"
  },
  {
    name: "cmps dword",
    bytes: [0xa7],
    mnemonic: "cmps",
    operands: [
      mem(32, { base: "esi", scale: 1, disp: 0 }),
      mem(32, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "cmps.m32_m32",
    format: "cmps"
  },
  {
    name: "repe cmps dword",
    bytes: [0xf3, 0xa7],
    mnemonic: "cmps",
    operands: [
      mem(32, { base: "esi", scale: 1, disp: 0 }),
      mem(32, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "cmps.repe_m32_m32",
    format: "repe cmps"
  },
  {
    name: "repne cmps dword",
    bytes: [0xf2, 0xa7],
    mnemonic: "cmps",
    operands: [
      mem(32, { base: "esi", scale: 1, disp: 0 }),
      mem(32, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "cmps.repne_m32_m32",
    format: "repne cmps"
  },
  {
    name: "stos dword",
    bytes: [0xab],
    mnemonic: "stos",
    operands: [
      mem(32, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "stos.m32_eax",
    format: "stos"
  },
  {
    name: "rep stos dword",
    bytes: [0xf3, 0xab],
    mnemonic: "stos",
    operands: [
      mem(32, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "stos.rep_m32_eax",
    format: "rep stos"
  },
  {
    name: "lods dword",
    bytes: [0xad],
    mnemonic: "lods",
    operands: [mem(32, { base: "esi", scale: 1, disp: 0 })],
    id: "lods.eax_m32",
    format: "lods"
  },
  {
    name: "rep lods dword",
    bytes: [0xf3, 0xad],
    mnemonic: "lods",
    operands: [mem(32, { base: "esi", scale: 1, disp: 0 })],
    id: "lods.rep_eax_m32",
    format: "rep lods"
  },
  {
    name: "scas dword",
    bytes: [0xaf],
    mnemonic: "scas",
    operands: [
      mem(32, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "scas.eax_m32",
    format: "scas"
  },
  {
    name: "repe scas dword",
    bytes: [0xf3, 0xaf],
    mnemonic: "scas",
    operands: [
      mem(32, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "scas.repe_eax_m32",
    format: "repe scas"
  },
  {
    name: "repne scas dword",
    bytes: [0xf2, 0xaf],
    mnemonic: "scas",
    operands: [
      mem(32, { segment: "es", base: "edi", scale: 1, disp: 0 })
    ],
    id: "scas.repne_eax_m32",
    format: "repne scas"
  }
]);

test("segment override on movs changes only the ESI source side", () => {
  const instruction = ok(decodeBytes([0x64, 0xa4]));

  strictEqual(instruction.spec.id, "movs.m8_m8");
  strictEqual(instruction.operands[0]?.kind, "mem");
  strictEqual(instruction.operands[1]?.kind, "mem");

  if (instruction.operands[0]?.kind === "mem" && instruction.operands[1]?.kind === "mem") {
    strictEqual(instruction.operands[0].segment, "fs");
    strictEqual(instruction.operands[1].segment, "es");
  }
});

test("segment override on stos is ignored by the fixed ES destination", () => {
  const instruction = ok(decodeBytes([0x65, 0xaa]));

  strictEqual(instruction.spec.id, "stos.m8_al");
  strictEqual(instruction.operands[0]?.kind, "mem");

  if (instruction.operands[0]?.kind === "mem") {
    strictEqual(instruction.operands[0].segment, "es");
  }
});

test("repne movs stays unsupported because that bucket is absent", () => {
  const decoded = decodeBytes([0xf2, 0xa4]);

  strictEqual(decoded.kind, "unsupported");
  if (decoded.kind === "unsupported") {
    strictEqual(decoded.unsupportedByte, 0xf2);
    strictEqual(decoded.length, 2);
  }
});

test("rep on a non-rep opcode stays unsupported after prefix scanning", () => {
  const decoded = decodeBytes([0xf3, 0x90]);

  strictEqual(decoded.kind, "unsupported");
  if (decoded.kind === "unsupported") {
    strictEqual(decoded.unsupportedByte, 0xf3);
    strictEqual(decoded.length, 2);
  }
});
