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
  return (s) => {
    s.hostTrap(s.const32(3));
  };
}

export function intoSemantic(): SemanticTemplate {
  return (s) => {
    s.hostTrapIf(s.readFlag("OF"), s.const32(4));
  };
}
