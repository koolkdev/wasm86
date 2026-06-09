import { simplifyValue } from "./simplify.js";
import { flagWriteChildValues } from "./flags.js";
import type { JitValue } from "./types.js";

export function valueCost(value: JitValue): number {
  const simplified = simplifyValue(value);

  if (simplified !== value) {
    return valueCost(simplified);
  }

  switch (value.kind) {
    case "value.binary":
    case "value.compare":
      return 1 + valueCost(value.a) + valueCost(value.b);
    case "value.unary":
      return 1 + valueCost(value.value);
    case "value.select":
      return 1 + valueCost(value.condition) + valueCost(value.whenTrue) + valueCost(value.whenFalse);
    case "extractBits":
    case "extractMaskedBits":
    case "flagCondition":
      return 1 + valueCost(value.kind === "flagCondition" ? value.flags : value.value);
    case "insertBits":
    case "insertMaskedBits":
      return 1 + valueCost(value.base) + valueCost(value.value);
    case "flagWrite":
      return 1 + flagWriteChildValues(value).reduce((cost, child) => cost + valueCost(child), 0);
    case "const":
    case "loadResult":
    case "input":
      return 1;
  }
}
