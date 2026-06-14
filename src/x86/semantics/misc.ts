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
