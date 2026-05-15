import { flagProducerInputValues } from "./flags.js";
import type { JitValue } from "./types.js";

export function valueChildren(value: JitValue): readonly JitValue[] {
  switch (value.kind) {
    case "value.binary":
      return [value.a, value.b];
    case "value.unary":
      return [value.value];
    case "value.select":
      return [value.condition, value.whenTrue, value.whenFalse];
    case "extractBits":
    case "extractMaskedBits":
      return [value.value];
    case "insertBits":
    case "insertMaskedBits":
      return [value.base, value.value];
    case "flagProducer":
      return flagProducerInputValues(value);
    case "flagCondition":
      return [value.flags];
    case "const":
    case "produced":
    case "input":
      return [];
  }
}

export function walkValueChildren(value: JitValue, visit: (dependency: JitValue) => void): void {
  for (const child of valueChildren(value)) {
    visit(child);
    walkValueChildren(child, visit);
  }
}
