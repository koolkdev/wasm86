import type { ValueId } from "./types.js";

export function valueId(id: number): ValueId {
  return id as ValueId;
}
