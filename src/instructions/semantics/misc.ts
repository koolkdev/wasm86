import { u8 } from "#compiler/function/values.js";
import type { InstructionSemantics } from "#instructions/semantics/builder.js";

export function nopSemantic(): InstructionSemantics {
  return () => {};
}

export function intSemantic(): InstructionSemantics {
  return (s) => {
    s.hostTrap(s.read(s.operand(0), 8));
  };
}

export function int3Semantic(): InstructionSemantics {
  return (s) => {
    s.hostTrap(u8(3));
  };
}

export function intoSemantic(): InstructionSemantics {
  return (s) => {
    s.if(s.readFlag("OF"), (then) => then.hostTrap(u8(4)), "unlikely");
  };
}
