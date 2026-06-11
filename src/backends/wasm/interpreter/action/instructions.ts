import type { SemanticTemplate } from "#ir/model/types.js";
import { buildOpcodeDispatch, type OpcodeDispatchNode } from "#x86/decoder/opcode-dispatch.js";
import { ADD, AND, OR, SUB, XOR } from "#x86/defs/alu.js";
import { CMP, TEST } from "#x86/defs/cmp-test.js";
import { JCC } from "#x86/defs/control.js";
import { MOV } from "#x86/defs/mov.js";
import { X86_32_CORE } from "#x86/index.js";
import { expandInstructionSpec } from "#x86/schema/builders.js";
import type { InstructionSpec } from "#x86/schema/types.js";

// The families wired so far. There is no operand-size prefix dispatch, so
// 16-bit forms are unsupported here.
const wiredMnemonics: ReadonlySet<string> = new Set(
  [MOV, ADD, OR, AND, SUB, XOR, CMP, TEST, ...JCC].map((mnemonic) => mnemonic.mnemonic)
);

export const actionInterpreterDispatchRoot: OpcodeDispatchNode = buildOpcodeDispatch(
  X86_32_CORE.instructions
    .filter(actionInterpreterSupportsInstruction)
    .flatMap((spec) => expandInstructionSpec(spec))
);

function actionInterpreterSupportsInstruction(spec: InstructionSpec<SemanticTemplate>): boolean {
  return wiredMnemonics.has(spec.mnemonic) && (spec.prefixes?.operandSize ?? "default") === "default";
}
