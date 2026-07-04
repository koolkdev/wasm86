import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  defineIsa,
  expandInstructionSpec,
  form,
  instruction,
  instructionReadsModRm,
  mnemonic
} from "#x86/schema/builders.js";
import { expandOpcodePath, opcodePlusReg } from "#x86/schema/opcodes.js";
import { imm, modrmReg, modrmRm, moffs, opReg } from "#x86/schema/operands.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";

const semantics: SemanticTemplate = () => {};

test("opcode path exact bytes expand directly", () => {
  deepStrictEqual(expandOpcodePath([0x8b]), [{ bytes: [0x8b] }]);
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

  const expanded = expandInstructionSpec(spec);

  strictEqual(expanded.length, 8);
  deepStrictEqual(expanded[0]?.opcode, [0xb8]);
  strictEqual(expanded[0]?.opcodeLowBits, 0);
  deepStrictEqual(expanded[7]?.opcode, [0xbf]);
  strictEqual(expanded[7]?.opcodeLowBits, 7);
});

test("variable opcode path expansion supports condition-family shapes", () => {
  const shortJcc = [{ byte: 0x70, bits: 4 }] as const;
  const nearJcc = [0x0f, { byte: 0x80, bits: 4 }] as const;

  deepStrictEqual(
    expandOpcodePath(shortJcc),
    Array.from({ length: 16 }, (_, low) => ({ bytes: [0x70 + low], lowBits: low }))
  );

  deepStrictEqual(
    expandOpcodePath(nearJcc),
    Array.from({ length: 16 }, (_, low) => ({ bytes: [0x0f, 0x80 + low], lowBits: low }))
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

test("schema operand helpers support byte and word ModRM forms", () => {
  deepStrictEqual(modrmReg("r8"), { kind: "modrm.reg", type: "r8" });
  deepStrictEqual(modrmRm("rm16"), { kind: "modrm.rm", type: "rm16" });
  deepStrictEqual(modrmRm("r32_m16"), { kind: "modrm.rm", type: "r32_m16" });
  deepStrictEqual(modrmRm("m8"), { kind: "modrm.rm", type: "m8" });
  deepStrictEqual(moffs(32), { kind: "moffs", width: 32 });
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

test("mnemonic rejects empty form lists", () => {
  throws(() => mnemonic("empty", []), /at least one form/);
});
