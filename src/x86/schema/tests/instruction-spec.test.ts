import { deepStrictEqual, doesNotThrow, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  defineIsa,
  expandInstructionSpec,
  form,
  instruction,
  instructionReadsModRm,
  mnemonic,
  validateInstructionSet
} from "#x86/schema/builders.js";
import { opcodePathMatches, opcodePlusReg, validateOpcodePath } from "#x86/schema/opcodes.js";
import { imm, modrmReg, modrmRm, moffs, opReg } from "#x86/schema/operands.js";
import type { InstructionSpec } from "#x86/schema/types.js";

const semantics = { test: "semantics-placeholder" } as const;

test("opcode path exact byte matching", () => {
  strictEqual(opcodePathMatches([0x8b], [0x8b]), true);
  strictEqual(opcodePathMatches([0x8b], [0x8a]), false);
});

test("opcode plus register path matches and exposes low bits through opcode.reg operand", () => {
  // B8+rd id: MOV r32, imm32
  const spec = instruction({
    id: "mov.r32_imm32",
    mnemonic: "mov",
    opcode: [opcodePlusReg(0xb8)],
    operands: [opReg(), imm(32)],
    format: { syntax: "mov {0}, {1}" },
    semantics
  });

  strictEqual(opcodePathMatches(spec.opcode, [0xb8]), true);
  strictEqual(opcodePathMatches(spec.opcode, [0xbf]), true);
  strictEqual(opcodePathMatches(spec.opcode, [0xc0]), false);

  const expanded = expandInstructionSpec(spec);

  strictEqual(expanded.length, 8);
  deepStrictEqual(expanded[0]?.opcode, [0xb8]);
  strictEqual(expanded[0]?.opcodeLowBits, 0);
  deepStrictEqual(expanded[7]?.opcode, [0xbf]);
  strictEqual(expanded[7]?.opcodeLowBits, 7);
});

test("variable opcode path matching supports condition-family shapes", () => {
  const shortJcc = [{ byte: 0x70, bits: 4 }] as const;
  const nearJcc = [0x0f, { byte: 0x80, bits: 4 }] as const;

  strictEqual(opcodePathMatches(shortJcc, [0x70]), true);
  strictEqual(opcodePathMatches(shortJcc, [0x7f]), true);
  strictEqual(opcodePathMatches(shortJcc, [0x80]), false);

  strictEqual(opcodePathMatches(nearJcc, [0x0f, 0x80]), true);
  strictEqual(opcodePathMatches(nearJcc, [0x0f, 0x8f]), true);
  strictEqual(opcodePathMatches(nearJcc, [0x0f, 0x90]), false);
});

test("opcode descriptors reject malformed byte and fixed-bit shapes", () => {
  throws(() => validateOpcodePath([]), /must not be empty/);
  throws(() => validateOpcodePath([0x100]), /0..255/);
  throws(() => validateOpcodePath([{ byte: 0xb8, bits: 0 as 1 }]), /1..8/);
  throws(() => validateOpcodePath([{ byte: 0xbb, bits: 5 }]), /low bits must be zero/);
});

test("opcode.reg requires exactly one variable opcode part", () => {
  throws(
    () =>
      instruction({
        id: "bad.no_variable_opcode",
        mnemonic: "bad",
        opcode: [0xb8],
        operands: [opReg()],
        format: { syntax: "bad {0}" },
        semantics
      }),
    /exactly one variable opcode part/
  );

  throws(
    () =>
      instruction({
        id: "bad.two_variable_opcodes",
        mnemonic: "bad",
        opcode: [opcodePlusReg(0xb8), { byte: 0x70, bits: 4 }],
        operands: [opReg()],
        format: { syntax: "bad {0}" },
        semantics
      }),
    /exactly one variable opcode part/
  );
});

test("normal slash-r form reads ModRM through operands without a modrm field", () => {
  // 8B /r: MOV r32, r/m32
  const spec = instruction({
    id: "mov.r32_rm32",
    mnemonic: "mov",
    opcode: [0x8b],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    format: { syntax: "mov {0}, {1}" },
    semantics
  });

  strictEqual(spec.modrm, undefined);
  strictEqual(instructionReadsModRm(spec), true);
});

test("modrm.match represents Intel slash digit notation", () => {
  // 83 /5 ib: SUB r/m32, sign-extended imm8
  const spec = instruction({
    id: "sub.rm32_imm8",
    mnemonic: "sub",
    opcode: [0x83],
    modrm: { match: { reg: 5 } },
    operands: [modrmRm("rm32"), imm(8, "sign")],
    format: { syntax: "sub {0}, {1}" },
    semantics
  });

  deepStrictEqual(spec.modrm?.match, { reg: 5 });
  strictEqual(instructionReadsModRm(spec), true);
});

test("instruction set validation detects overlapping opcode and ModRM matches", () => {
  const add = group83("add.rm32_imm8", 0);
  const sub = group83("sub.rm32_imm8", 5);
  const duplicateSub = group83("sub.duplicate_rm32_imm8", 5);

  doesNotThrow(() => validateInstructionSet([add, sub]));
  throws(() => validateInstructionSet([sub, duplicateSub]), /overlap/);
});

test("instruction set validation separates operand-size override forms", () => {
  const mov32 = instruction({
    id: "mov.r32_rm32",
    mnemonic: "mov",
    opcode: [0x8b],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    format: { syntax: "mov {0}, {1}" },
    semantics
  });
  const mov16 = instruction({
    id: "mov.r16_rm16",
    mnemonic: "mov",
    prefixes: { operandSize: "override" },
    opcode: [0x8b],
    operands: [modrmReg("r16"), modrmRm("rm16")],
    format: { syntax: "mov {0}, {1}" },
    semantics
  });

  doesNotThrow(() => validateInstructionSet([mov32, mov16]));
});

test("schema operand helpers support byte and word ModRM forms", () => {
  deepStrictEqual(modrmReg("r8"), { kind: "modrm.reg", type: "r8" });
  deepStrictEqual(modrmRm("rm16"), { kind: "modrm.rm", type: "rm16" });
  deepStrictEqual(modrmRm("m8"), { kind: "modrm.rm", type: "m8" });
  deepStrictEqual(moffs(32), { kind: "moffs", width: 32 });
});

test("instruction set validation treats slash-r as overlapping group matches on same opcode", () => {
  // 83 /r: TEST-ONLY invalid fixture for collision behavior
  const slashR = instruction({
    id: "fixture.slash_r",
    mnemonic: "fixture",
    opcode: [0x83],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    format: { syntax: "fixture {0}, {1}" },
    semantics
  });

  throws(() => validateInstructionSet([slashR, group83("add.rm32_imm8", 0)]), /overlap/);
});

test("format placeholders must reference operand indexes", () => {
  doesNotThrow(() => {
    // 89 /r: MOV r/m32, r32
    instruction({
      id: "mov.rm32_r32",
      mnemonic: "mov",
      opcode: [0x89],
      operands: [modrmRm("rm32"), modrmReg("r32")],
      format: { syntax: "mov {0}, {1}" },
      semantics
    });
  });

  throws(
    () =>
      instruction({
        id: "mov.bad_format",
        mnemonic: "mov",
        opcode: [0x89],
        operands: [modrmRm("rm32")],
        format: { syntax: "mov {0}, {1}" },
        semantics
      }),
    /operand index/
  );

  throws(
    () =>
      instruction({
        id: "mov.bad_format_name",
        mnemonic: "mov",
        opcode: [0x89],
        operands: [modrmRm("rm32")],
        format: { syntax: "mov {dst}" },
        semantics
      }),
    /must be an operand index/
  );
});

test("mnemonic and ISA builders generate stable full instruction ids", () => {
  const mov = mnemonic("mov", [
    // 8B /r: MOV r32, r/m32
    form("r32_rm32", {
      opcode: [0x8b],
      operands: [modrmReg("r32"), modrmRm("rm32")],
      format: { syntax: "mov {0}, {1}" },
      semantics
    }),
    // 89 /r: MOV r/m32, r32
    form("rm32_r32", {
      opcode: [0x89],
      operands: [modrmRm("rm32"), modrmReg("r32")],
      format: { syntax: "mov {0}, {1}" },
      semantics
    })
  ]);

  const isa = defineIsa({ name: "x86-32-core-test", mnemonics: [mov] });

  deepStrictEqual(
    isa.instructions.map((entry) => entry.id),
    ["mov.r32_rm32", "mov.rm32_r32"]
  );
});

function group83(id: string, reg: 0 | 5): InstructionSpec<typeof semantics> {
  const mnemonicName = group83Mnemonic(reg);

  return instruction({
    id,
    mnemonic: mnemonicName,
    opcode: [0x83],
    modrm: { match: { reg } },
    operands: [modrmRm("rm32"), imm(8, "sign")],
    format: { syntax: `${mnemonicName} {0}, {1}` },
    semantics
  });
}

function group83Mnemonic(reg: 0 | 5): "add" | "sub" {
  switch (reg) {
    case 0:
      return "add";
    case 5:
      return "sub";
  }
}
