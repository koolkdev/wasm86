import type { InstructionSemantics } from "#instructions/semantics/builder.js";

export function nopSemantic(): InstructionSemantics {
  return () => {};
}

export function intSemantic(): InstructionSemantics {
  return (s) => {
    s.hostTrap(s.read(s.operand(0), { width: 32 }));
  };
}

export function int3Semantic(): InstructionSemantics {
  return (s, v) => {
    s.hostTrap(v.const(3));
  };
}

export function intoSemantic(): InstructionSemantics {
  return (s, v) => {
    s.if(s.readFlag("OF"), (then) => then.hostTrap(v.const(4)), "unlikely");
  };
}
