import { type X86Flag } from "#core/flags/definitions.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import { buildFlagImage, writeFlagsFromImage } from "./flag-image.js";
import { resolveMemoryAccess } from "./memory.js";

const lahfFlags = ["CF", "PF", "AF", "ZF", "SF"] as const satisfies readonly X86Flag[];

export function writeFlagSemantic(flag: X86Flag, value: 0 | 1): SemanticTemplate {
  return (s, v) => {
    s.writeFlag(flag, v.const(value));
  };
}

export function cmcSemantic(): SemanticTemplate {
  return (s, v) => {
    s.writeFlag("CF", v.binary("xor", s.readFlag("CF"), v.const(1)));
  };
}

export function lahfSemantic(): SemanticTemplate {
  return (s, v) => {
    s.set(s.reg("ah"), buildFlagImage(s, v, lahfFlags, 0x02), 8);
  };
}

export function sahfSemantic(): SemanticTemplate {
  return (s, v) => {
    writeFlagsFromImage(s, v, lahfFlags, s.get(s.reg("ah"), 8));
  };
}

export function xlatSemantic(): SemanticTemplate {
  return (s, v) => {
    const memory = s.operandMem(s.operand(0), s.get(s.reg("al"), 8));
    const access = resolveMemoryAccess(s, memory, v.const(1), "read");

    s.set(s.reg("al"), s.memoryRead(access, v.const(0), 8), 8);
  };
}
