import type { SemanticTemplate } from "#x86/semantics/builder.js";

export function nopSemantic(): SemanticTemplate {
  return (s) => {
    s.next();
  };
}

export function intSemantic(): SemanticTemplate {
  return (s) => {
    s.hostTrap(s.get(s.operand(0)));
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
