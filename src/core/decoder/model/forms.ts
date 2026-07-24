import {
  expandInstructionSpec,
  instructionReadsModRm,
  type InstructionSpec,
  type MemOperandType,
  type OperandSpec,
  type RegOperandType,
  type RmOperandType
} from "#core/isa/spec.js";
import { registerAlias } from "#core/registers.js";
import { defaultSegmentForBase } from "#core/segments.js";
import {
  segmentRegisters,
  type OperandWidth,
  type SegmentRegister
} from "#core/types.js";
import type {
  DecodeOperand,
  EncodedValue,
  InstructionForm,
  SegmentSelection
} from "./types.js";

export function buildInstructionForms(
  instructions: readonly InstructionSpec[]
): readonly InstructionForm[] {
  const forms = instructions.flatMap((instruction) =>
    expandInstructionSpec(instruction).map((expanded) => buildForm(
      expanded.spec,
      expanded.opcode,
      expanded.opcodeLowBits
    ))
  ).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

  return forms;
}

function buildForm(
  instruction: InstructionSpec,
  opcode: readonly number[],
  opcodeLowBits: number | undefined
): InstructionForm {
  const operands = (instruction.operands ?? []).map(buildOperand);

  const opcodeIdentity = opcode
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return {
    id: `${instruction.id}@${opcodeIdentity}`,
    instruction,
    opcode,
    opcodeLowBits,
    operands,
    modrm: instructionReadsModRm(instruction)
      ? { acceptedBytes: acceptedModRmBytes(instruction, operands) }
      : undefined
  };
}

function acceptedModRmBytes(
  instruction: InstructionSpec,
  operands: readonly DecodeOperand[]
): readonly boolean[] {
  const match = instruction.modrm?.match;
  const memoryOnly = operands.some(
    (operand) => operand.kind === "modrm.rm" && operand.form === "memory"
  );
  const hasSegmentRegister = operands.some(
    (operand) => operand.kind === "modrm.sreg"
  );

  return Array.from({ length: 256 }, (_, byte) => {
    const mod = byte >>> 6;
    const reg = (byte >>> 3) & 0b111;
    const rm = byte & 0b111;

    return (
      (match?.mod === undefined || match.mod === mod) &&
      (match?.reg === undefined || match.reg === reg) &&
      (match?.rm === undefined || match.rm === rm) &&
      (!memoryOnly || mod !== 0b11) &&
      (!hasSegmentRegister || segmentRegisters[reg] !== undefined)
    );
  });
}

function buildOperand(operand: OperandSpec): DecodeOperand {
  switch (operand.kind) {
    case "modrm.reg":
      return { kind: operand.kind, width: registerOperandWidth(operand.type) };
    case "modrm.sreg":
      return { kind: operand.kind, registers: segmentRegisters };
    case "modrm.rm":
      return buildRmOperand(operand.type);
    case "opcode.reg":
      return { kind: operand.kind, width: registerOperandWidth(operand.type) };
    case "implicit.reg":
      return { kind: operand.kind, alias: registerAlias(operand.reg) };
    case "implicit.sreg":
      return { kind: operand.kind, reg: operand.reg };
    case "implicit.mem":
      return {
        kind: operand.kind,
        accessWidth: operand.width,
        base: operand.base,
        disp: operand.disp,
        segment: operand.segment === undefined
          ? overrideOrDefault(defaultSegmentForBase(operand.base))
          : { kind: "fixed", segment: operand.segment }
      };
    case "moffs":
      return {
        kind: operand.kind,
        accessWidth: operand.width,
        address: encodedValue(32, false),
        segment: overrideOrDefault("ds")
      };
    case "imm":
      return {
        kind: "immediate",
        encodedWidth: operand.width,
        semanticWidth: operand.semanticWidth ?? operand.width,
        extension: operand.extension ?? "none",
        value: encodedValue(operand.width, operand.extension === "sign")
      };
    case "rel":
      return {
        kind: "relative",
        width: operand.width,
        displacement: encodedValue(operand.width, true)
      };
  }
}

function buildRmOperand(
  type: RmOperandType | MemOperandType
): Extract<DecodeOperand, { kind: "modrm.rm" }> {
  switch (type) {
    case "rm8":
      return {
        kind: "modrm.rm",
        form: "registerOrMemory",
        registerWidth: 8,
        memoryWidth: 8
      };
    case "rm16":
      return {
        kind: "modrm.rm",
        form: "registerOrMemory",
        registerWidth: 16,
        memoryWidth: 16
      };
    case "rm32":
      return {
        kind: "modrm.rm",
        form: "registerOrMemory",
        registerWidth: 32,
        memoryWidth: 32
      };
    case "r32_m16":
      return {
        kind: "modrm.rm",
        form: "registerOrMemory",
        registerWidth: 32,
        memoryWidth: 16
      };
    case "m8":
      return { kind: "modrm.rm", form: "memory", memoryWidth: 8 };
    case "m16":
      return { kind: "modrm.rm", form: "memory", memoryWidth: 16 };
    case "m32":
      return { kind: "modrm.rm", form: "memory", memoryWidth: 32 };
    case "m64":
      return { kind: "modrm.rm", form: "memory", memoryWidth: 64 };
  }
}

function overrideOrDefault(
  defaultSegment: SegmentRegister
): SegmentSelection {
  return { kind: "overrideOrDefault", defaultSegment };
}

function encodedValue(
  width: OperandWidth,
  signed: boolean
): EncodedValue {
  switch (width) {
    case 8:
      return { byteLength: 1, signed };
    case 16:
      return { byteLength: 2, signed };
    case 32:
      return { byteLength: 4, signed };
  }
}

function registerOperandWidth(type: RegOperandType): OperandWidth {
  switch (type) {
    case "r8":
      return 8;
    case "r16":
      return 16;
    case "r32":
      return 32;
  }
}
