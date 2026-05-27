import {
  expandOpcodePath,
  opcodeLowBits,
  validateOpcodePath,
  variableOpcodePartCount
} from "./opcodes.js";
import type {
  DefinedIsa,
  ExpandedInstructionSpec,
  InstructionForm,
  InstructionFormSpec,
  InstructionMnemonic,
  IsaDefinition,
  InstructionPrefixes,
  InstructionSpec,
  ModRmMatch,
  OperandSpec,
  OperandSizePrefixMode,
  OpcodePath,
  Reg3
} from "./types.js";

export function form<TSemantics>(
  formId: string,
  spec: InstructionFormSpec<TSemantics>
): InstructionForm<TSemantics> {
  validateRequiredText(formId, "instruction form id");
  return { formId, spec };
}

export function mnemonic<TSemantics>(
  mnemonicName: string,
  forms: readonly InstructionForm<TSemantics>[]
): InstructionMnemonic<TSemantics> {
  validateRequiredText(mnemonicName, "instruction mnemonic");

  if (forms.length === 0) {
    throw new Error("instruction mnemonic must have at least one form");
  }

  return { mnemonic: mnemonicName, forms };
}

export function defineIsa<TSemantics>(definition: IsaDefinition<TSemantics>): DefinedIsa<TSemantics> {
  validateRequiredText(definition.name, "ISA name");

  const instructions = definition.mnemonics.flatMap((entry) => instructionsForMnemonic(entry));
  validateInstructionSet(instructions);

  return { name: definition.name, instructions };
}

export function instruction<TSemantics>(spec: InstructionSpec<TSemantics>): InstructionSpec<TSemantics> {
  validateInstructionSpec(spec);
  return spec;
}

export function instructionsForMnemonic<TSemantics>(
  entry: InstructionMnemonic<TSemantics>
): readonly InstructionSpec<TSemantics>[] {
  return entry.forms.map((entryForm) =>
    instruction({
      id: `${entry.mnemonic}.${entryForm.formId}`,
      mnemonic: entry.mnemonic,
      ...entryForm.spec
    })
  );
}

export function validateInstructionSpec(spec: InstructionSpec): void {
  validateRequiredText(spec.id, "instruction id");
  validateRequiredText(spec.mnemonic, "instruction mnemonic");
  validateOpcodePath(spec.opcode);
  validatePrefixes(spec.prefixes);
  validateModRmMatch(spec.modrm?.match);
  validateOpcodeRegUse(spec);
  validateFormat(spec);
}

export function instructionReadsModRm(spec: InstructionSpec): boolean {
  return spec.modrm?.match !== undefined || (spec.operands ?? []).some(isModRmOperand);
}

export function expandInstructionSpec<TSemantics>(
  spec: InstructionSpec<TSemantics>
): readonly ExpandedInstructionSpec<TSemantics>[] {
  validateInstructionSpec(spec);

  return expandOpcodePath(spec.opcode).map((opcode) => {
    const lowBits = opcodeLowBits(spec.opcode, opcode);

    if (lowBits === undefined) {
      return { spec, opcode };
    }

    return { spec, opcode, opcodeLowBits: lowBits };
  });
}

export function validateInstructionSet(specs: readonly InstructionSpec[]): void {
  validateUniqueInstructionIds(specs);

  for (const spec of specs) {
    validateInstructionSpec(spec);
  }

  for (let leftIndex = 0; leftIndex < specs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < specs.length; rightIndex += 1) {
      const left = specs[leftIndex];
      const right = specs[rightIndex];

      if (left === undefined || right === undefined) {
        continue;
      }

      if (instructionSpecsOverlap(left, right)) {
        throw new Error(`instruction specs overlap: ${left.id} and ${right.id}`);
      }
    }
  }
}

export function instructionSpecsOverlap(left: InstructionSpec, right: InstructionSpec): boolean {
  const leftOpcodes = expandOpcodePath(left.opcode);
  const rightOpcodes = expandOpcodePath(right.opcode);

  for (const leftOpcode of leftOpcodes) {
    for (const rightOpcode of rightOpcodes) {
      if (opcodeBytesEqual(leftOpcode, rightOpcode) && prefixUseOverlaps(left, right) && modRmUseOverlaps(left, right)) {
        return true;
      }
    }
  }

  return false;
}

function validateUniqueInstructionIds(specs: readonly InstructionSpec[]): void {
  const seen = new Set<string>();

  for (const spec of specs) {
    if (seen.has(spec.id)) {
      throw new Error(`duplicate instruction id: ${spec.id}`);
    }

    seen.add(spec.id);
  }
}

function validateOpcodeRegUse(spec: InstructionSpec): void {
  const opcodeRegOperands = (spec.operands ?? []).filter((operand) => operand.kind === "opcode.reg");

  if (opcodeRegOperands.length === 0) {
    return;
  }

  const variableParts = variableOpcodePartCount(spec.opcode);

  if (variableParts !== 1) {
    throw new Error("opcode.reg operands require exactly one variable opcode part");
  }

  if (opcodeRegOperands.length !== 1) {
    throw new Error("only one opcode.reg operand is supported");
  }
}

function validateFormat(spec: InstructionSpec): void {
  validateRequiredText(spec.format.syntax, "instruction format syntax");

  const operandCount = spec.operands?.length ?? 0;

  for (const placeholder of formatPlaceholders(spec.format.syntax)) {
    if (placeholder >= operandCount) {
      throw new Error(`format placeholder {${placeholder}} does not match an operand index`);
    }
  }
}

function validateModRmMatch(match: ModRmMatch | undefined): void {
  if (match === undefined) {
    return;
  }

  validateReg3Value(match.mod, "modrm.match.mod");
  validateReg3Value(match.reg, "modrm.match.reg");
  validateReg3Value(match.rm, "modrm.match.rm");
}

function validatePrefixes(prefixes: InstructionPrefixes | undefined): void {
  if (prefixes === undefined) {
    return;
  }

  validateOperandSizePrefixMode(prefixes.operandSize);
}

function validateOperandSizePrefixMode(value: OperandSizePrefixMode | undefined): void {
  if (value === undefined) {
    return;
  }

  if (value !== "default" && value !== "override") {
    throw new Error(`operand-size prefix mode must be default or override, got ${value}`);
  }
}

function validateReg3Value(value: Reg3 | undefined, label: string): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || value < 0 || value > 7) {
    throw new Error(`${label} must be an integer in 0..7`);
  }
}

function isModRmOperand(operand: OperandSpec): boolean {
  return operand.kind === "modrm.reg" || operand.kind === "modrm.rm";
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

function formatPlaceholders(format: string): readonly number[] {
  return [...format.matchAll(/\{([^{}]+)\}/g)].map((match) => {
    const placeholder = match[1];

    if (placeholder === undefined) {
      throw new Error("format placeholder parser produced an empty capture");
    }

    if (!/^(0|[1-9][0-9]*)$/.test(placeholder)) {
      throw new Error(`format placeholder {${placeholder}} must be an operand index`);
    }

    return Number(placeholder);
  });
}

function validateRequiredText(value: string, label: string): void {
  if (value.trim() === "") {
    throw new Error(`${label} must not be empty`);
  }
}

export type { DefinedIsa, InstructionForm, InstructionMnemonic, InstructionSpec, ModRmMatch, OpcodePath };
