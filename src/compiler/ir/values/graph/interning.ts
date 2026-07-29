import type { ValueKey } from "./definition.js";
import type { ValueId } from "#compiler/value.js";

type InternNode = {
  readonly children: Map<ValueKey, InternNode>;
  value: ValueId | undefined;
};

export type InternTable = Map<object, InternNode>;

export type ScopedInterning = Readonly<{
  table: InternTable;
  parent?: ScopedInterning;
}>;

export function createInternTable(): InternTable {
  return new Map();
}

export function createScopedInterning(parent?: ScopedInterning): ScopedInterning {
  return {
    table: createInternTable(),
    ...(parent === undefined ? {} : { parent })
  };
}

export function cloneInternTable(source: InternTable): InternTable {
  return new Map([...source].map(([definition, root]) => [definition, cloneInternNode(root)]));
}

export function cloneScopedInterning(source: ScopedInterning): ScopedInterning {
  return {
    table: cloneInternTable(source.table),
    ...(source.parent === undefined ? {} : { parent: cloneScopedInterning(source.parent) })
  };
}

export function internValue(
  table: InternTable,
  definition: object,
  key: readonly ValueKey[],
  create: () => ValueId
): ValueId {
  const existingRoot = table.get(definition);
  let position: InternNode;

  if (existingRoot === undefined) {
    position = createInternNode();
    table.set(definition, position);
  } else {
    position = existingRoot;
  }

  for (const part of key) {
    const existingChild = position.children.get(part);

    if (existingChild === undefined) {
      const child = createInternNode();

      position.children.set(part, child);
      position = child;
    } else {
      position = existingChild;
    }
  }

  if (position.value !== undefined) {
    return position.value;
  }

  const value = create();

  position.value = value;
  return value;
}

export function internScopedValue(
  scope: ScopedInterning,
  definition: object,
  key: readonly ValueKey[],
  create: () => ValueId
): ValueId {
  for (
    let current: ScopedInterning | undefined = scope;
    current !== undefined;
    current = current.parent
  ) {
    const existing = internedValue(current.table, definition, key);

    if (existing !== undefined) {
      return existing;
    }
  }

  return internValue(scope.table, definition, key, create);
}

function createInternNode(): InternNode {
  return { children: new Map(), value: undefined };
}

function cloneInternNode(source: InternNode): InternNode {
  return {
    children: new Map([...source.children].map(([key, child]) => [key, cloneInternNode(child)])),
    value: source.value
  };
}

function internedValue(
  table: InternTable,
  definition: object,
  key: readonly ValueKey[]
): ValueId | undefined {
  let position = table.get(definition);

  if (position === undefined) {
    return undefined;
  }
  for (const part of key) {
    position = position.children.get(part);
    if (position === undefined) {
      return undefined;
    }
  }
  return position.value;
}
