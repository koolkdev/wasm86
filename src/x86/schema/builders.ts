import { expandOpcodePath } from "./opcodes.js";
import type {
  DefinedIsa,
  ExpandedInstructionSpec,
  InstructionForm,
  InstructionFormSpec,
  InstructionMnemonic,
  IsaDefinition,
  InstructionSpec,
  ModRmMatch,
  OperandSpec,
  OpcodePath
} from "./types.js";

export function form(
  formId: string,
  spec: InstructionFormSpec
): InstructionForm {
  return { formId, spec };
}

export function mnemonic(
  mnemonicName: string,
  forms: readonly InstructionForm[]
): InstructionMnemonic {
  if (forms.length === 0) {
    throw new Error("instruction mnemonic must have at least one form");
  }

  return { mnemonic: mnemonicName, forms };
}

export function defineIsa(definition: IsaDefinition): DefinedIsa {
  return {
    name: definition.name,
    instructions: definition.mnemonics.flatMap((entry) => instructionsForMnemonic(entry))
  };
}

export function instruction(spec: InstructionSpec): InstructionSpec {
  return spec;
}

export function instructionsForMnemonic(
  entry: InstructionMnemonic
): readonly InstructionSpec[] {
  return entry.forms.map((entryForm) =>
    instruction({
      id: `${entry.mnemonic}.${entryForm.formId}`,
      mnemonic: entry.mnemonic,
      ...entryForm.spec
    })
  );
}

export function instructionReadsModRm(spec: InstructionSpec): boolean {
  return spec.modrm?.match !== undefined || (spec.operands ?? []).some(isModRmOperand);
}

export function expandInstructionSpec(
  spec: InstructionSpec
): readonly ExpandedInstructionSpec[] {
  return expandOpcodePath(spec.opcode).map(({ bytes, lowBits }) => {
    if (lowBits === undefined) {
      return { spec, opcode: bytes };
    }

    return { spec, opcode: bytes, opcodeLowBits: lowBits };
  });
}

function isModRmOperand(operand: OperandSpec): boolean {
  return operand.kind === "modrm.reg" || operand.kind === "modrm.sreg" || operand.kind === "modrm.rm";
}

export type { DefinedIsa, InstructionForm, InstructionMnemonic, InstructionSpec, ModRmMatch, OpcodePath };
