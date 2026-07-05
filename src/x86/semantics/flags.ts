import { type X86Flag } from "#x86/flags.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { buildFlagImage, writeFlagsFromImage } from "./flag-image.js";

const lahfFlags = ["CF", "PF", "AF", "ZF", "SF"] as const satisfies readonly X86Flag[];

export function writeFlagSemantic(flag: X86Flag, value: 0 | 1): SemanticTemplate {
  return (s) => {
    s.writeFlag(flag, s.const32(value));
    s.next();
  };
}

export function cmcSemantic(): SemanticTemplate {
  return (s) => {
    s.writeFlag("CF", s.binary("xor", s.readFlag("CF"), s.const32(1)));
    s.next();
  };
}

export function lahfSemantic(): SemanticTemplate {
  return (s) => {
    s.set(s.reg("ah"), buildFlagImage(s, lahfFlags, 0x02), 8);
    s.next();
  };
}

export function sahfSemantic(): SemanticTemplate {
  return (s) => {
    writeFlagsFromImage(s, lahfFlags, s.get(s.reg("ah"), 8));
    s.next();
  };
}

export function xlatSemantic(): SemanticTemplate {
  return (s) => {
    const tableBase = s.linearAddress(s.operand(0));
    const address = s.binary("add", tableBase, s.get(s.reg("al"), 8));

    s.memoryGuard(address, 1, "read");
    s.set(s.reg("al"), s.get(s.mem(address), 8), 8);
    s.next();
  };
}
