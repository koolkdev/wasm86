import { type X86Flag } from "#core/flags/definitions.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
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
    s.write(s.reg("ah"), buildFlagImage(s, v, lahfFlags, 0x02), { width: 8 });
  };
}

export function sahfSemantic(): SemanticTemplate {
  return (s, v) => {
    writeFlagsFromImage(s, v, lahfFlags, s.read(s.reg("ah"), { width: 8 }));
  };
}

export function xlatSemantic(): SemanticTemplate {
  return (s, v) => {
    const reference = s.memory.operand(
      s.operand(0),
      s.read(s.reg("al"), { width: 8 })
    );
    const access = s.memory.access({
      reference,
      byteLength: v.const(1),
      intent: "read"
    });

    s.write(s.reg("al"), s.memory.read(access, { width: 8 }), { width: 8 });
  };
}
