import type { Body, BodyNode } from "./block.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";

export function walkBodyNodes(
  body: Body,
  visit: (node: BodyNode) => void
): void {
  for (const node of body.nodes) {
    visit(node);

    for (const nested of node.nestedBodies) {
      walkBodyNodes(nested.body, visit);
    }
  }
}

export function bodyContains(root: Body, target: Body): boolean {
  if (root === target) {
    return true;
  }

  for (const node of root.nodes) {
    for (const nested of node.nestedBodies) {
      if (bodyContains(nested.body, target)) {
        return true;
      }
    }
  }

  return false;
}

// The outputs a body's own nodes produce; values computed from
// them are body-internal and can only materialize inside the body.
export function bodyProducedOutputs(body: Body): ReadonlySet<ValueId> {
  const produced = new Set<ValueId>();

  for (const node of body.nodes) {
    for (const output of node.outputs) {
      produced.add(output);
    }
  }

  return produced;
}

// True when the value is, or is computed from, any of the given ids.
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

// Everything a nested body consumes from its parent context, its result
// included. The walk stops at values transitively produced inside the body —
// a loop body's own input leaves included, so loop-input-dependent values
// are never treated as parent-context inputs; a body-internal compound
// decomposes into its parent-context children.
export function bodyInputValues(
  body: Body,
  values: ValueTable,
  extraProduced: Iterable<ValueId> = []
): readonly ValueId[] {
  const produced = new Set([...bodyProducedOutputs(body), ...extraProduced]);
  const inputs: ValueId[] = [];
  const decomposed = new Set<ValueId>();

  const collect = (id: ValueId): void => {
    if (produced.has(id)) {
      return;
    }

    if (!valueDependsOn(values, id, produced)) {
      inputs.push(id);
      return;
    }

    if (decomposed.has(id)) {
      return;
    }

    decomposed.add(id);
    for (const child of values.children(id)) {
      collect(child);
    }
  };

  for (const node of body.nodes) {
    for (const operand of node.operands) {
      collect(operand);
    }

    for (const nested of node.nestedBodies) {
      const scopedInputs = nested.scope.kind === "loop"
        ? nested.scope.inputs
        : [];

      for (const input of bodyInputValues(nested.body, values, scopedInputs)) {
        collect(input);
      }
    }
  }

  if (body.result !== undefined) {
    collect(body.result);
  }

  return inputs;
}
