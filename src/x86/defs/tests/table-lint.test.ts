import { deepStrictEqual, match } from "node:assert";
import { test } from "node:test";

import { X86_32_CORE } from "#x86/index.js";
import { instructionReadsModRm } from "#x86/schema/builders.js";
import { expandOpcodePath } from "#x86/schema/opcodes.js";
import { imm, modrmReg, modrmRm, opReg } from "#x86/schema/operands.js";
import type {
  FixedHighBits,
  InstructionSpec,
  ModRmMatch,
  OpcodePath,
  OpcodePathPart,
  OperandSizePrefixMode,
  Reg3
} from "#x86/schema/types.js";

const semantics = { test: "semantics-placeholder" } as const;

type LintAnalysis = Readonly<{
  spec: InstructionSpec;
  label: string;
  canCheckOverlap: boolean;
}>;

test("x86-32 core instruction table passes schema lint", () => {
  deepStrictEqual(instructionTableLintFailures(X86_32_CORE.instructions), []);
  validateInstructionSet(X86_32_CORE.instructions);
});

test("lint rejects duplicate ids and malformed instruction fields", () => {
  const message = lintMessage([
    fixtureSpec({ id: "dup.id", opcode: [0x90] }),
    fixtureSpec({ id: "dup.id", opcode: [0x91] }),
    fixtureSpec({ id: "", opcode: [0x92] }),
    fixtureSpec({ id: "bad.mnemonic", mnemonic: "", opcode: [0x93] }),
    fixtureSpec({ id: "bad.syntax", opcode: [0x94], format: { syntax: "" } }),
    fixtureSpec({
      id: "bad.prefix",
      opcode: [0x95],
      prefixes: { operandSize: "invalid" as OperandSizePrefixMode }
    }),
    fixtureSpec({
      id: "bad.modrm",
      opcode: [0x96],
      modrm: { match: { reg: 8 as Reg3 } }
    })
  ]);

  match(message, /duplicate instruction id: dup\.id/);
  match(message, /<instruction 2>: instruction id must not be empty/);
  match(message, /bad\.mnemonic: instruction mnemonic must not be empty/);
  match(message, /bad\.syntax: instruction format syntax must not be empty/);
  match(message, /bad\.prefix: operand-size prefix mode must be default or override/);
  match(message, /bad\.modrm: modrm\.match\.reg must be an integer in 0\.\.7/);
});

test("lint rejects malformed opcode paths", () => {
  const message = lintMessage([
    fixtureSpec({ id: "bad.empty_opcode", opcode: [] }),
    fixtureSpec({ id: "bad.opcode_byte", opcode: [0x100] }),
    fixtureSpec({
      id: "bad.fixed_bits",
      opcode: [{ byte: 0xb8, bits: 0 as FixedHighBits }]
    }),
    fixtureSpec({
      id: "bad.variable_low_bits",
      opcode: [{ byte: 0xbb, bits: 5 }]
    })
  ]);

  match(message, /bad\.empty_opcode: opcode path must not be empty/);
  match(message, /bad\.opcode_byte: opcode byte must be an integer in 0\.\.255/);
  match(message, /bad\.fixed_bits: opcode fixed high bits must be an integer in 1\.\.8/);
  match(message, /bad\.variable_low_bits: variable opcode low bits must be zero in descriptor byte/);
});

test("lint rejects invalid opcode register operand use", () => {
  const message = lintMessage([
    fixtureSpec({
      id: "bad.no_variable_opcode",
      opcode: [0xb8],
      operands: [opReg()],
      format: { syntax: "bad {0}" }
    }),
    fixtureSpec({
      id: "bad.two_variable_opcodes",
      opcode: [{ byte: 0xb8, bits: 5 }, { byte: 0x70, bits: 4 }],
      operands: [opReg()],
      format: { syntax: "bad {0}" }
    }),
    fixtureSpec({
      id: "bad.two_opcode_regs",
      opcode: [{ byte: 0xb8, bits: 5 }],
      operands: [opReg(), opReg()],
      format: { syntax: "bad {0}, {1}" }
    })
  ]);

  match(message, /bad\.no_variable_opcode: opcode\.reg operands require exactly one variable opcode part/);
  match(message, /bad\.two_variable_opcodes: opcode\.reg operands require exactly one variable opcode part/);
  match(message, /bad\.two_opcode_regs: only one opcode\.reg operand is supported/);
});

test("lint rejects invalid format placeholders", () => {
  validateInstructionSet([
    fixtureSpec({
      id: "mov.rm32_r32",
      opcode: [0x89],
      operands: [modrmRm("rm32"), modrmReg("r32")],
      format: { syntax: "mov {0}, {1}" }
    })
  ]);

  const message = lintMessage([
    fixtureSpec({
      id: "mov.bad_format",
      opcode: [0x89],
      operands: [modrmRm("rm32")],
      format: { syntax: "mov {0}, {1}" }
    }),
    fixtureSpec({
      id: "mov.bad_format_name",
      opcode: [0x8b],
      operands: [modrmRm("rm32")],
      format: { syntax: "mov {dst}" }
    })
  ]);

  match(message, /mov\.bad_format: format placeholder \{1\} does not match an operand index/);
  match(message, /mov\.bad_format_name: format placeholder \{dst\} must be an operand index/);
});

test("lint detects instruction overlap while separating operand-size forms", () => {
  const add = group83("add.rm32_imm8", 0);
  const sub = group83("sub.rm32_imm8", 5);
  const duplicateSub = group83("sub.duplicate_rm32_imm8", 5);

  validateInstructionSet([add, sub]);
  match(lintMessage([sub, duplicateSub]), /instruction specs overlap: sub\.rm32_imm8 and sub\.duplicate_rm32_imm8/);

  validateInstructionSet([
    fixtureSpec({
      id: "mov.r32_rm32",
      opcode: [0x8b],
      operands: [modrmReg("r32"), modrmRm("rm32")],
      format: { syntax: "mov {0}, {1}" }
    }),
    fixtureSpec({
      id: "mov.r16_rm16",
      prefixes: { operandSize: "override" },
      opcode: [0x8b],
      operands: [modrmReg("r16"), modrmRm("rm16")],
      format: { syntax: "mov {0}, {1}" }
    })
  ]);

  const slashR = fixtureSpec({
    id: "fixture.slash_r",
    opcode: [0x83],
    operands: [modrmReg("r32"), modrmRm("rm32")],
    format: { syntax: "fixture {0}, {1}" }
  });

  match(lintMessage([slashR, add]), /instruction specs overlap: fixture\.slash_r and add\.rm32_imm8/);
});

function validateInstructionSet(specs: readonly InstructionSpec[]): void {
  const failures = instructionTableLintFailures(specs);

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

function lintMessage(specs: readonly InstructionSpec[]): string {
  const failures = instructionTableLintFailures(specs);

  if (failures.length === 0) {
    return "<no lint failures>";
  }

  return failures.join("\n");
}

function instructionTableLintFailures(specs: readonly InstructionSpec[]): readonly string[] {
  const failures: string[] = [];

  lintUniqueInstructionIds(specs, failures);

  const analyses = specs.map((spec, index) => lintInstructionSpec(spec, index, failures));
  lintInstructionOverlaps(analyses, failures);

  return failures;
}

function lintUniqueInstructionIds(specs: readonly InstructionSpec[], failures: string[]): void {
  const seen = new Map<string, string>();

  specs.forEach((spec, index) => {
    const label = instructionLabel(spec, index);
    const previous = seen.get(spec.id);

    if (previous !== undefined) {
      failures.push(`duplicate instruction id: ${spec.id} (${previous} and ${label})`);
      return;
    }

    seen.set(spec.id, label);
  });
}

function lintInstructionSpec(spec: InstructionSpec, index: number, failures: string[]): LintAnalysis {
  const label = instructionLabel(spec, index);

  lintRequiredText(spec.id, "instruction id", label, failures);
  lintRequiredText(spec.mnemonic, "instruction mnemonic", label, failures);
  lintRequiredText(spec.format.syntax, "instruction format syntax", label, failures);

  const opcodePathOk = lintOpcodePath(spec.opcode, label, failures);
  const prefixOk = lintPrefixes(spec, label, failures);
  const modRmOk = lintModRmMatch(spec.modrm?.match, label, failures);

  lintOpcodeRegUse(spec, label, failures);
  lintFormat(spec, label, failures);

  return { spec, label, canCheckOverlap: opcodePathOk && prefixOk && modRmOk };
}

function lintRequiredText(value: string, field: string, label: string, failures: string[]): void {
  if (value.trim() === "") {
    failures.push(`${label}: ${field} must not be empty`);
  }
}

function lintOpcodePath(path: OpcodePath, label: string, failures: string[]): boolean {
  let ok = true;

  if (path.length === 0) {
    failures.push(`${label}: opcode path must not be empty`);
    ok = false;
  }

  for (const part of path) {
    ok = lintOpcodePathPart(part, label, failures) && ok;
  }

  return ok;
}

function lintOpcodePathPart(part: OpcodePathPart, label: string, failures: string[]): boolean {
  if (typeof part === "number") {
    return lintByte(part, "opcode byte", label, failures);
  }

  let ok = lintByte(part.byte, "opcode byte", label, failures);
  const bits = part.bits ?? 8;
  const bitsOk = lintFixedHighBits(bits, label, failures);
  ok = bitsOk && ok;

  if (ok && bitsOk && bits < 8 && lowMask(bits) !== 0 && (part.byte & lowMask(bits)) !== 0) {
    failures.push(`${label}: variable opcode low bits must be zero in descriptor byte`);
    ok = false;
  }

  return ok;
}

function lintByte(value: number, field: string, label: string, failures: string[]): boolean {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    failures.push(`${label}: ${field} must be an integer in 0..255`);
    return false;
  }

  return true;
}

function lintFixedHighBits(bits: number, label: string, failures: string[]): boolean {
  if (!Number.isInteger(bits) || bits < 1 || bits > 8) {
    failures.push(`${label}: opcode fixed high bits must be an integer in 1..8`);
    return false;
  }

  return true;
}

function lintPrefixes(spec: InstructionSpec, label: string, failures: string[]): boolean {
  const operandSize = spec.prefixes?.operandSize;

  if (operandSize === undefined || operandSize === "default" || operandSize === "override") {
    return true;
  }

  failures.push(`${label}: operand-size prefix mode must be default or override, got ${operandSize}`);
  return false;
}

function lintModRmMatch(match: ModRmMatch | undefined, label: string, failures: string[]): boolean {
  if (match === undefined) {
    return true;
  }

  const modOk = lintReg3Value(match.mod, "modrm.match.mod", label, failures);
  const regOk = lintReg3Value(match.reg, "modrm.match.reg", label, failures);
  const rmOk = lintReg3Value(match.rm, "modrm.match.rm", label, failures);

  return modOk && regOk && rmOk;
}

function lintReg3Value(value: Reg3 | undefined, field: string, label: string, failures: string[]): boolean {
  if (value === undefined) {
    return true;
  }

  if (!Number.isInteger(value) || value < 0 || value > 7) {
    failures.push(`${label}: ${field} must be an integer in 0..7`);
    return false;
  }

  return true;
}

function lintOpcodeRegUse(spec: InstructionSpec, label: string, failures: string[]): void {
  const opcodeRegOperands = (spec.operands ?? []).filter((operand) => operand.kind === "opcode.reg");

  if (opcodeRegOperands.length === 0) {
    return;
  }

  const variableParts = variableOpcodePartCount(spec.opcode);

  if (variableParts !== 1) {
    failures.push(`${label}: opcode.reg operands require exactly one variable opcode part`);
  }

  if (opcodeRegOperands.length !== 1) {
    failures.push(`${label}: only one opcode.reg operand is supported`);
  }
}

function variableOpcodePartCount(path: OpcodePath): number {
  return path.filter((part) => typeof part !== "number" && (part.bits ?? 8) < 8).length;
}

function lintFormat(spec: InstructionSpec, label: string, failures: string[]): void {
  const operandCount = spec.operands?.length ?? 0;

  for (const placeholder of formatPlaceholders(spec.format.syntax, label, failures)) {
    if (placeholder >= operandCount) {
      failures.push(`${label}: format placeholder {${placeholder}} does not match an operand index`);
    }
  }
}

function formatPlaceholders(format: string, label: string, failures: string[]): readonly number[] {
  const placeholders: number[] = [];

  for (const placeholderMatch of format.matchAll(/\{([^{}]+)\}/g)) {
    const placeholder = placeholderMatch[1];

    if (placeholder === undefined) {
      failures.push(`${label}: format placeholder parser produced an empty capture`);
      continue;
    }

    if (!/^(0|[1-9][0-9]*)$/.test(placeholder)) {
      failures.push(`${label}: format placeholder {${placeholder}} must be an operand index`);
      continue;
    }

    placeholders.push(Number(placeholder));
  }

  return placeholders;
}

function lintInstructionOverlaps(analyses: readonly LintAnalysis[], failures: string[]): void {
  for (let leftIndex = 0; leftIndex < analyses.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < analyses.length; rightIndex += 1) {
      const left = analyses[leftIndex];
      const right = analyses[rightIndex];

      if (left === undefined || right === undefined || !left.canCheckOverlap || !right.canCheckOverlap) {
        continue;
      }

      if (instructionSpecsOverlap(left.spec, right.spec)) {
        failures.push(`instruction specs overlap: ${left.label} and ${right.label}`);
      }
    }
  }
}

function instructionSpecsOverlap(left: InstructionSpec, right: InstructionSpec): boolean {
  const leftOpcodes = expandOpcodePath(left.opcode);
  const rightOpcodes = expandOpcodePath(right.opcode);

  for (const leftOpcode of leftOpcodes) {
    for (const rightOpcode of rightOpcodes) {
      if (
        opcodeBytesEqual(leftOpcode.bytes, rightOpcode.bytes) &&
        prefixUseOverlaps(left, right) &&
        modRmUseOverlaps(left, right)
      ) {
        return true;
      }
    }
  }

  return false;
}

function opcodeBytesEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function modRmUseOverlaps(left: InstructionSpec, right: InstructionSpec): boolean {
  const leftReadsModRm = instructionReadsModRm(left);
  const rightReadsModRm = instructionReadsModRm(right);

  if (!leftReadsModRm || !rightReadsModRm) {
    return true;
  }

  return modRmMatchesOverlap(left.modrm?.match, right.modrm?.match);
}

function prefixUseOverlaps(left: InstructionSpec, right: InstructionSpec): boolean {
  return operandSizePrefixMode(left) === operandSizePrefixMode(right);
}

function operandSizePrefixMode(spec: InstructionSpec): OperandSizePrefixMode {
  return spec.prefixes?.operandSize ?? "default";
}

function modRmMatchesOverlap(left: ModRmMatch | undefined, right: ModRmMatch | undefined): boolean {
  return (
    reg3SetsOverlap(left?.mod, right?.mod) &&
    reg3SetsOverlap(left?.reg, right?.reg) &&
    reg3SetsOverlap(left?.rm, right?.rm)
  );
}

function reg3SetsOverlap(left: Reg3 | undefined, right: Reg3 | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function instructionLabel(spec: InstructionSpec, index: number): string {
  return spec.id.trim() === "" ? `<instruction ${index}>` : spec.id;
}

function lowMask(bits: number): number {
  return (1 << (8 - bits)) - 1;
}

function fixtureSpec(overrides: Partial<InstructionSpec<typeof semantics>>): InstructionSpec<typeof semantics> {
  return {
    id: "fixture.valid",
    mnemonic: "fixture",
    opcode: [0x90],
    operands: [],
    format: { syntax: "fixture" },
    semantics,
    ...overrides
  };
}

function group83(id: string, reg: 0 | 5): InstructionSpec<typeof semantics> {
  const mnemonicName = group83Mnemonic(reg);

  return fixtureSpec({
    id,
    mnemonic: mnemonicName,
    opcode: [0x83],
    modrm: { match: { reg } },
    operands: [modrmRm("rm32"), imm(8, "sign")],
    format: { syntax: `${mnemonicName} {0}, {1}` }
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
