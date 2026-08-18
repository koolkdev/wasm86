import { integer } from "#compiler/function/values.js";
import type { X86Flag } from "#core/flags/definitions.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";
import { buildFlagImage, writeFlagsFromImage } from "./flag-image.js";

const lahfFlags = ["CF", "PF", "AF", "ZF", "SF"] as const satisfies readonly X86Flag[];

export function writeFlagSemantic(flag: X86Flag, value: 0 | 1): InstructionSemantics {
  return (s) => {
    s.writeFlag(flag, integer(1, value));
  };
}

export function cmcSemantic(): InstructionSemantics {
  return (s) => {
    s.writeFlag("CF", s.readFlag("CF").xor(1));
  };
}

export function lahfSemantic(): InstructionSemantics {
  return (s) => {
    s.write(s.reg("ah"), buildFlagImage(s, lahfFlags, 0x02).truncate(8));
  };
}

export function sahfSemantic(): InstructionSemantics {
  return (s) => {
    writeFlagsFromImage(s, lahfFlags, s.read(s.reg("ah")));
  };
}

export function xlatSemantic(): InstructionSemantics {
  return (s) => {
    const reference = s.memory.operand(s.operand(0), s.read(s.reg("al")).unsigned.extend(32));

    s.write(s.reg("al"), s.memory.read(reference, 8));
  };
}
