import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";

// True when the value is, or is computed from, any of the given roots.
export function valueDependsOn(
  values: ValueTable,
  id: ValueId,
  roots: ReadonlySet<ValueId>
): boolean {
  if (roots.size === 0) {
    return false;
  }

  const visited = new Set<ValueId>();
  const walk = (current: ValueId): boolean => {
    if (roots.has(current)) {
      return true;
    }
    if (visited.has(current)) {
      return false;
    }

    visited.add(current);
    return values.children(current).some(walk);
  };

  return walk(id);
}
