import { buildOpcodeDispatch, type OpcodeDispatchNode } from "#x86/decoder/opcode-dispatch.js";
import { X86_32_CORE } from "#x86/index.js";
import { expandInstructionSpec } from "#x86/schema/builders.js";

export const interpreterDispatchRoot: OpcodeDispatchNode = buildOpcodeDispatch(
  X86_32_CORE.instructions.flatMap((spec) => expandInstructionSpec(spec))
);
