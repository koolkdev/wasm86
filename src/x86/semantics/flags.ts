import { type X86Flag } from "#x86/flags.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { buildFlagImage, writeFlagsFromImage } from "./flag-image.js";

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
    const tableBase = s.linearAddress(s.operand(0));
    const address = v.binary("add", tableBase, s.get(s.reg("al"), 8));

    s.memoryGuard(address, 1, "read");
    s.set(s.reg("al"), s.get(s.mem(address), 8), 8);
  };
}
