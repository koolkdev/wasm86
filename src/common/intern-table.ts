type InternNode<Part, Value> = {
  readonly children: Map<Part, InternNode<Part, Value>>;
  value: Value | undefined;
};

export class InternTable<Namespace, Part, Value extends NonNullable<unknown>> {
  readonly #roots = new Map<Namespace, InternNode<Part, Value>>();

  get(namespace: Namespace, parts: readonly Part[]): Value | undefined {
    let position = this.#roots.get(namespace);

    if (position === undefined) {
      return undefined;
    }
    for (const part of parts) {
      position = position.children.get(part);
      if (position === undefined) {
        return undefined;
      }
    }
    return position.value;
  }

  intern(namespace: Namespace, parts: readonly Part[], create: () => Value): Value {
    const existingRoot = this.#roots.get(namespace);
    let position: InternNode<Part, Value>;

    if (existingRoot === undefined) {
      position = internNode<Part, Value>();
      this.#roots.set(namespace, position);
    } else {
      position = existingRoot;
    }
    for (const part of parts) {
      let child: InternNode<Part, Value> | undefined = position.children.get(part);

      if (child === undefined) {
        child = internNode<Part, Value>();
        position.children.set(part, child);
      }
      position = child;
    }
    if (position.value !== undefined) {
      return position.value;
    }
    const value = create();

    position.value = value;
    return value;
  }
}

function internNode<Part, Value>(): InternNode<Part, Value> {
  return { children: new Map(), value: undefined };
}
