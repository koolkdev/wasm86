import {
  buildOpcodeDispatch,
  type OpcodeDispatchNode
} from "#core/decoder/opcode-dispatch-legacy.js";
import { X86_32_CORE } from "#core/index.js";
import { expandInstructionSpec } from "#core/isa/spec.js";

export const interpreterDispatchRoot: OpcodeDispatchNode = buildOpcodeDispatch(
  X86_32_CORE.instructions.flatMap((spec) => expandInstructionSpec(spec))
);
