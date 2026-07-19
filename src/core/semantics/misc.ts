import type { SemanticTemplate } from "#core/semantics/builder.js";

export function nopSemantic(): SemanticTemplate {
  return () => {};
}

export function intSemantic(): SemanticTemplate {
  return (s) => {
    s.hostTrap(s.read(s.operand(0), { width: 32 }));
  };
}

export function int3Semantic(): SemanticTemplate {
  return (s, v) => {
    s.hostTrap(v.const(3));
  };
}

export function intoSemantic(): SemanticTemplate {
  return (s, v) => {
    s.if(s.readFlag("OF"), (then) => then.hostTrap(v.const(4)), "unlikely");
  };
}
